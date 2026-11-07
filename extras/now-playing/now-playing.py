#!/usr/bin/env python3
"""Productivity++ now-playing helper for Linux.

Browsers can't see which song your desktop is playing, so this tiny local server reads it from
MPRIS (the standard Linux media interface: YouTube Music Desktop, Spotify, browsers, VLC, ...)
and hands it to the app's Dashboard at http://127.0.0.1:8971. It only listens on this computer,
and only the app's own web addresses may read it or press play/pause/skip or change the volume.

Phone (off until you turn it on in the app's Settings): the helper also shares the song with your
phone through the app's sync server, and plays/pauses/skips when you tap on the phone.

Usage: now-playing.py [--port 8971] [--origin https://you.github.io] ...
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from gi.repository import Gio, GLib
except ImportError:
    sys.exit('This helper needs PyGObject. Install it with:  sudo apt install python3-gi')

PREFIX = 'org.mpris.MediaPlayer2.'
OBJ = '/org/mpris/MediaPlayer2'
PLAYER = 'org.mpris.MediaPlayer2.Player'
PROPS = 'org.freedesktop.DBus.Properties'
COMMANDS = {'play-pause': 'PlayPause', 'next': 'Next', 'previous': 'Previous'}
LOCAL_ORIGIN = re.compile(r'http://(localhost|127\.0\.0\.1)(:\d+)?')

MIN_LENGTH_S = 20  # shorter "tracks" are notification sounds (chat apps report those as playing)

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
dbus_lock = threading.RLock()  # requests are served on several threads
last_player = None  # stick with the same player when several are paused
ignored = []  # name fragments of players to skip (--ignore)
look_up_covers = True


def dbus(dest, path, iface, method, args=None, rtype=None):
    with dbus_lock:
        res = bus.call_sync(dest, path, iface, method, args, GLib.VariantType(rtype) if rtype else None,
                            Gio.DBusCallFlags.NONE, 800, None)
    return res.unpack() if rtype else None


def players():
    names = dbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', rtype='(as)')[0]
    out = []
    for name in names:
        if not name.startswith(PREFIX) or any(i in name.lower() for i in ignored):
            continue
        try:
            props = dbus(name, OBJ, PROPS, 'GetAll', GLib.Variant('(s)', (PLAYER,)), '(a{sv})')[0]
        except GLib.Error:
            continue
        meta = props.get('Metadata') or {}
        length = (meta.get('mpris:length') or 0) / 1e6
        if not meta.get('xesam:title') or 0 < length < MIN_LENGTH_S:
            continue
        out.append((name, props))
    return out


def current():
    """The player to show: playing beats paused; otherwise keep the one shown last."""
    global last_player
    with dbus_lock:
        rank = {'Playing': 0, 'Paused': 1}
        found = sorted(players(), key=lambda p: (rank.get(p[1].get('PlaybackStatus'), 2), p[0] != last_player))
        if not found or found[0][1].get('PlaybackStatus') not in rank:
            return None, None
        last_player = found[0][0]
        return found[0]


def identity(name):
    try:
        return dbus(name, OBJ, PROPS, 'Get', GLib.Variant('(ss)', ('org.mpris.MediaPlayer2', 'Identity')), '(v)')[0]
    except GLib.Error:
        return name[len(PREFIX):].split('.')[0]


# ---------- Album covers & album names from YouTube Music ----------
# YouTube Music players often report the music video's 16:9 thumbnail, and YouTube Music Desktop can
# keep reporting an old album name for every track. The square cover and the real album are on
# YouTube Music itself: look up the track's audio version, or search for the song.
YTM = 'https://music.youtube.com/youtubei/v1/'
YTM_CLIENT = {'client': {'clientName': 'WEB_REMIX', 'clientVersion': '1.20241106.01.00', 'hl': 'en'}}
YTM_SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'  # search filter: songs only
VIDEO_ID = re.compile(r'[A-Za-z0-9_-]{11}')
# (title, artist) -> (cover or '', album or None, retry after). '' cover: keep the player's picture.
# None album: unknown, keep the player's; '' album: it's a video, not on an album.
lookups = {}
lookup_waits = {}  # (title, artist) -> Event set when the lookup finishes
lookup_lock = threading.Lock()


def ytm(endpoint, body):
    req = urllib.request.Request(
        f'{YTM}{endpoint}?prettyPrint=false', data=json.dumps({'context': YTM_CLIENT, **body}).encode(),
        headers={'Content-Type': 'application/json', 'Origin': 'https://music.youtube.com', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=6) as r:
        return json.load(r)


def large(url):
    """Google image URLs carry their size at the end (=w60-h60-...): ask for a big one."""
    return re.sub(r'=w\d+-h\d+[^/]*$', '=w1200-h1200-l90-rj', url) if 'googleusercontent.com' in url else ''


def norm(s):
    return re.sub(r'\W+', '', (s or '').casefold())


def renderers(o, key):
    if isinstance(o, dict):
        if key in o:
            yield o[key]
        for v in o.values():
            yield from renderers(v, key)
    elif isinstance(o, list):
        for v in o:
            yield from renderers(v, key)


def album_in(runs):
    """The album link in a byline like "Artist • Album • 2026"."""
    for x in runs or []:
        page = (x.get('navigationEndpoint', {}).get('browseEndpoint', {})
                .get('browseEndpointContextSupportedConfigs', {}).get('browseEndpointContextMusicConfig', {}).get('pageType'))
        if page == 'MUSIC_PAGE_TYPE_ALBUM':
            return x.get('text', '')
    return None


def song_of_video(video_id):
    """(cover, album) if this video is a song's audio track (those carry the album art), else None."""
    for r in renderers(ytm('next', {'videoId': video_id}), 'playlistPanelVideoRenderer'):
        if r.get('videoId') != video_id:
            continue
        cover = large(((r.get('thumbnail') or {}).get('thumbnails') or [{}])[-1].get('url', ''))
        album = album_in((r.get('longBylineText') or {}).get('runs'))
        return (cover, album) if cover else None
    return None


def song_by_search(title, artist):
    first_artist = norm(re.split(r',|&| feat\.? | x ', artist or '')[0])
    d = ytm('search', {'query': f'{title} {artist}'.strip(), 'params': YTM_SONGS})
    for i, r in enumerate(renderers(d, 'musicResponsiveListItemRenderer')):
        if i >= 5:
            break
        try:
            runs = [c['musicResponsiveListItemFlexColumnRenderer']['text'].get('runs', []) for c in r['flexColumns']]
            cols = [' '.join(x['text'] for x in rs) for rs in runs]
            thumbs = r['thumbnail']['musicThumbnailRenderer']['thumbnail']['thumbnails']
        except (KeyError, TypeError):
            continue
        t = norm(cols[0])
        if not t or not (t == norm(title) or t.startswith(norm(title)) or norm(title).startswith(t)):
            continue
        if first_artist and first_artist not in norm(cols[1] if len(cols) > 1 else ''):
            continue
        return large(thumbs[-1].get('url', '')), album_in(runs[1] if len(runs) > 1 else [])
    return None


def video_ids(meta, art):
    ids = []
    track = str(meta.get('mpris:trackid') or '').rsplit('/', 1)[-1]
    if VIDEO_ID.fullmatch(track):
        ids.append(track)
    for pattern, text in ((r'/vi(?:_webp)?/([A-Za-z0-9_-]{11})/', art), (r'[?&]v=([A-Za-z0-9_-]{11})', str(meta.get('xesam:url') or ''))):
        m = re.search(pattern, text)
        if m and m.group(1) not in ids:
            ids.append(m.group(1))
    return ids


def look_up(key, ids):
    found, retry = None, float('inf')
    try:
        for vid in ids:
            found = song_of_video(vid)
            if found:
                break
        found = found or song_by_search(*key)
        if not found:
            found = ('', '')  # not a song on YouTube Music (e.g. an uploaded video): no album
    except Exception:  # offline, or YouTube changed something: keep the player's info, try again later
        found, retry = ('', None), time.time() + 120
    with lookup_lock:
        if len(lookups) > 500:
            lookups.clear()
        lookups[key] = (found[0], found[1], retry)
        lookup_waits.pop(key).set()


def from_youtube_music(name, meta, art, album):
    """(art, album), corrected from YouTube Music for YouTube players."""
    if not look_up_covers or not ('ytimg.com/' in art or re.search(r'youtube|ytm', name, re.I)):
        return art, album
    artist = meta.get('xesam:artist') or []
    key = (meta.get('xesam:title', ''), ', '.join(artist) if isinstance(artist, list) else str(artist))
    with lookup_lock:
        hit = lookups.get(key)
        if not (hit and hit[2] > time.time()):
            hit = None
            wait = lookup_waits.get(key)
            if not wait:
                wait = lookup_waits[key] = threading.Event()
                threading.Thread(target=look_up, args=(key, video_ids(meta, art)), daemon=True).start()
    if not hit:
        wait.wait(1.5)  # usually quick: avoids showing the thumbnail and old album for a moment first
        with lookup_lock:
            hit = lookups.get(key)
    if not hit:
        return art, album
    return hit[0] or art, album if hit[1] is None else hit[1]


# ---------- Volume ----------
# The player's own volume when it has one (MPRIS "Volume"), otherwise the system's output volume.
system_volume_for = set()  # players whose Volume property can't actually be changed


def system_volume():
    try:
        if shutil.which('wpctl'):
            out = subprocess.run(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'], capture_output=True, text=True, timeout=2).stdout
            m = re.search(r'Volume:\s*([\d.]+)', out)
            return (0.0 if 'MUTED' in out else min(1.0, float(m.group(1)))) if m else None
        if shutil.which('pactl'):
            out = subprocess.run(['pactl', 'get-sink-volume', '@DEFAULT_SINK@'], capture_output=True, text=True, timeout=2).stdout
            m = re.search(r'(\d+)%', out)
            return min(1.0, int(m.group(1)) / 100) if m else None
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def set_system_volume(v):
    if shutil.which('wpctl'):
        subprocess.run(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '0'], timeout=2)
        subprocess.run(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', f'{v:.3f}'], timeout=2, check=True)
    elif shutil.which('pactl'):
        subprocess.run(['pactl', 'set-sink-mute', '@DEFAULT_SINK@', '0'], timeout=2)
        subprocess.run(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', f'{round(v * 100)}%'], timeout=2, check=True)
    else:
        raise RuntimeError('no volume control found (needs wpctl or pactl)')


def volume_of(name, props):
    if name not in system_volume_for and isinstance(props.get('Volume'), float):
        return max(0.0, min(1.0, props['Volume']))
    return system_volume()


def player_volume(name):
    return dbus(name, OBJ, PROPS, 'Get', GLib.Variant('(ss)', (PLAYER, 'Volume')), '(v)')[0]


def set_volume(v):
    v = max(0.0, min(1.0, v))
    name, props = current()
    if name and name not in system_volume_for and isinstance((props or {}).get('Volume'), float):
        before = props['Volume']
        dbus(name, OBJ, PROPS, 'Set', GLib.Variant('(ssv)', (PLAYER, 'Volume', GLib.Variant('d', v))))
        if abs(before - v) < 0.005:
            return
        for _ in range(4):
            time.sleep(0.1)
            if abs(player_volume(name) - before) > 0.001:
                return
        system_volume_for.add(name)  # it ignored us (some browsers do): use the system volume from now on
    set_system_volume(v)


# ---------- Now playing ----------
def now_playing():
    name, p = current()
    if not name:
        return {'status': 'none'}
    m = p.get('Metadata') or {}
    art = m.get('mpris:artUrl') or ''
    if art.startswith('file://'):
        art = '/art'  # local file: served by us, see art_file()
    elif not art.startswith(('https://', 'http://', 'data:image/')):
        art = ''
    art, album = from_youtube_music(name, m, art, m.get('xesam:album', ''))
    artist = m.get('xesam:artist') or []
    return {
        'status': p.get('PlaybackStatus', '').lower(),
        'player': identity(name),
        'title': m.get('xesam:title', ''),
        'artist': ', '.join(artist) if isinstance(artist, list) else str(artist),
        'album': album,
        'art': art,
        'length': round((m.get('mpris:length') or 0) / 1e6, 1),
        'position': round((p.get('Position') or 0) / 1e6, 1),
        'canNext': bool(p.get('CanGoNext')),
        'canPrevious': bool(p.get('CanGoPrevious')),
        'canPause': bool(p.get('CanPause') or p.get('CanPlay')),
        'volume': volume_of(name, p),
    }


def art_file():
    """Only ever the current track's cover, never an arbitrary path."""
    name, p = current()
    url = ((p or {}).get('Metadata') or {}).get('mpris:artUrl', '')
    if not url.startswith('file://'):
        return None, None
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    mime = mimetypes.guess_type(path)[0] or ''
    if not mime.startswith('image/') or not os.path.isfile(path) or os.path.getsize(path) > 10 * 1024 * 1024:
        return None, None
    with open(path, 'rb') as f:
        return f.read(), mime


# ---------- Phone: share through the sync server ----------
# Phones can't reach this helper (an https app may not call a computer on the home network), so the
# helper hands the current song to the app's own sync server (the Cloudflare Worker) and picks up
# the phone's taps from there. Off until it's turned on in the app's Settings.
#
# The Worker keeps data in Cloudflare KV, whose free plan allows 1,000 writes a day: the song is only
# sent when something changes (song, play/pause, a seek, the volume), plus a check-in every 10 minutes
# while something is playing so the phone can tell when the computer went away.
RELAY_FILE = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'productivitypp', 'relay.json')
relay = {'url': '', 'token': ''}
relay_status = {'ok': False, 'error': '', 'sent': 0}
relay_lock = threading.Lock()
relay_wake = threading.Event()
RELAY_FIELDS = ('status', 'player', 'title', 'artist', 'album', 'art', 'length', 'canNext', 'canPrevious', 'canPause', 'volume')


def load_relay():
    try:
        with open(RELAY_FILE) as f:
            relay.update({k: v for k, v in json.load(f).items() if k in relay})
    except (OSError, ValueError):
        pass


def save_relay():
    os.makedirs(os.path.dirname(RELAY_FILE), exist_ok=True)
    fd = os.open(RELAY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # holds the sync token
    with os.fdopen(fd, 'w') as f:
        json.dump(relay, f)


def worker(method, path, body=None, url=None, token=None):
    req = urllib.request.Request(
        (url or relay['url']).rstrip('/') + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {token or relay["token"]}', 'Content-Type': 'application/json',
                 'User-Agent': 'productivitypp-now-playing'})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get('error') or ''
        except Exception:
            msg = ''
        if e.code == 404:
            msg = 'The sync server is out of date: paste the latest worker.js into it and deploy.'
        raise RuntimeError(msg or f'Sync server error {e.code}') from None


def relay_info():
    with relay_lock:
        return {'enabled': bool(relay['url']), **relay_status}


def run_command(c):
    cmd = c.get('cmd')
    if cmd == 'volume':
        set_volume(float(c.get('v')))
    elif cmd in COMMANDS:
        name, _ = current()
        if name:
            dbus(name, OBJ, PLAYER, COMMANDS[cmd])


def relay_loop():
    last_sig, last_push, pushed_pos = None, 0.0, None  # pushed_pos: (position, when, playing)
    last_id, next_inbox, backoff_until = None, 0.0, 0.0
    while True:
        relay_wake.wait(0.5)
        relay_wake.clear()
        if not relay['url']:
            last_sig, last_id = None, None
            continue
        now = time.time()
        if now < backoff_until:
            continue
        try:
            try:
                s = now_playing()
            except GLib.Error:
                s = {'status': 'none'}
            if s.get('art', '').startswith('/'):
                s['art'] = ''  # a picture stored on this computer: the phone can't load it
            sig = json.dumps([s.get(k) for k in RELAY_FIELDS])
            playing = s.get('status') == 'playing'
            jumped = False
            if pushed_pos and s.get('status') != 'none':
                p, at, was_playing = pushed_pos
                jumped = abs(p + (now - at if was_playing else 0) - s.get('position', 0)) > 3
            heartbeat = s.get('status') != 'none' and now - last_push > 600
            if (sig != last_sig or jumped or heartbeat) and now - last_push > 1:
                worker('PUT', '/music', {k: s.get(k) for k in (*RELAY_FIELDS, 'position')})
                last_sig, last_push, pushed_pos = sig, now, (s.get('position', 0), now, playing)
                with relay_lock:
                    relay_status.update(ok=True, error='', sent=int(now))

            if now >= next_inbox:
                inbox = worker('GET', '/music/inbox')
                cmds = sorted(inbox.get('cmds') or [], key=lambda c: c.get('id', 0))
                if last_id is None:  # just started: don't replay what was tapped before
                    last_id = max([c.get('id', 0) for c in cmds] + [0])
                new = [c for c in cmds if c.get('id', 0) > last_id]
                if new:
                    last_id = new[-1]['id']
                    vols = [c for c in new if c.get('cmd') == 'volume']
                    for c in [c for c in new if c.get('cmd') != 'volume'] + vols[-1:]:  # only the last volume counts
                        try:
                            run_command(c)
                        except (GLib.Error, RuntimeError, OSError, ValueError, TypeError, subprocess.SubprocessError):
                            pass
                    time.sleep(0.3)
                    last_sig = None  # send the result right away
                    relay_wake.set()
                watching = (inbox.get('watch') or 0) > (inbox.get('now') or 0)
                next_inbox = now + (1 if watching else 5 if s.get('status') != 'none' else 30)
        except Exception as e:  # offline, sync server down or over its daily limit: try again in a minute
            with relay_lock:
                relay_status.update(ok=False, error=str(e) or e.__class__.__name__)
            backoff_until = time.time() + 60


def relay_goodbye():
    """Tell the phone nothing is playing when the helper stops (computer shutting down, logging out)."""
    if relay['url']:
        try:
            worker('PUT', '/music', {'status': 'none'})
        except Exception:
            pass


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    extra_origins = set()

    def log_message(self, *args):
        pass

    def origin_allowed(self):
        o = self.headers.get('Origin')
        return o is None or bool(LOCAL_ORIGIN.fullmatch(o)) or o in self.extra_origins

    def send(self, code, body=b'', ctype='application/json', cache='no-store'):
        self.send_response(code)
        o = self.headers.get('Origin')
        if o and self.origin_allowed():
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', cache)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, data, code=200):
        self.send(code, json.dumps(data).encode())

    def query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def do_OPTIONS(self):
        self.send(204 if self.origin_allowed() else 403, ctype='text/plain')

    def do_GET(self):
        if not self.origin_allowed():
            return self.json({'error': 'origin not allowed'}, 403)
        path = self.path.split('?')[0]
        try:
            if path == '/now-playing':
                return self.json(now_playing())
            if path == '/art':
                data, mime = art_file()
                return self.send(200, data, mime) if data else self.send(404, ctype='text/plain')
            if path == '/':
                return self.json({'app': 'productivitypp-now-playing', 'ok': True, 'relay': True})
            if path == '/relay/info':
                return self.json(relay_info())
        except GLib.Error as e:
            return self.json({'error': e.message}, 500)
        self.json({'error': 'not found'}, 404)

    def do_POST(self):
        if not self.origin_allowed():
            return self.json({'error': 'origin not allowed'}, 403)
        path = self.path.split('?')[0]
        if path == '/volume':
            try:
                set_volume(float(self.query().get('v', [''])[0]))
            except ValueError:
                return self.json({'error': 'bad volume'}, 400)
            except (GLib.Error, RuntimeError, OSError, subprocess.SubprocessError) as e:
                return self.json({'error': f'Couldn\'t change the volume: {getattr(e, "message", e)}'}, 500)
            return self.json({'ok': True})
        if path in ('/relay/enable', '/relay/disable'):
            return self.relay_setup(path.endswith('enable'))
        m = re.fullmatch(r'/control/([a-z-]+)', path)
        if not m or m.group(1) not in COMMANDS:
            return self.json({'error': 'unknown command'}, 404)
        name, _ = current()
        if not name:
            return self.json({'error': 'nothing is playing'}, 409)
        try:
            dbus(name, OBJ, PLAYER, COMMANDS[m.group(1)])
        except GLib.Error as e:
            return self.json({'error': e.message}, 500)
        self.json({'ok': True})

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            return json.loads(self.rfile.read(min(n, 10000)) or b'{}')
        except ValueError:
            return {}

    def relay_setup(self, on):
        if on:
            # the app hands over its sync server address and token (sent as text/plain JSON: no preflight)
            b = self.body()
            url, token = str(b.get('url') or '').strip().rstrip('/'), str(b.get('token') or '')
            if not (url.startswith('https://') or LOCAL_ORIGIN.match(url)) or not token:  # http only for a local test server
                return self.json({'error': 'Set up sync first (Settings → Sync & background push).'}, 400)
            try:
                worker('GET', '/music', url=url, token=token)
            except Exception as e:
                return self.json({'error': str(e)}, 502)
            relay.update(url=url, token=token)
        else:
            relay_goodbye()
            relay.update(url='', token='')
        save_relay()
        with relay_lock:
            relay_status.update(ok=on, error='', sent=0)
        relay_wake.set()
        self.json(relay_info())


def stop(*_):
    raise KeyboardInterrupt


def main():
    global look_up_covers
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8971)
    ap.add_argument('--origin', action='append', default=[],
                    help='web address of your app, e.g. https://you.github.io (localhost is always allowed)')
    ap.add_argument('--ignore', action='append', default=[],
                    help='skip players whose bus name contains this, e.g. --ignore wasistlos')
    ap.add_argument('--no-covers', action='store_true',
                    help='don\'t look up square album covers and album names on YouTube Music (keeps what the player reports)')
    args = ap.parse_args()
    ignored.extend(i.lower() for i in args.ignore)
    look_up_covers = not args.no_covers
    Handler.extra_origins = {o.rstrip('/') for o in args.origin}
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    print(f'Now-playing helper on http://127.0.0.1:{args.port} (apps allowed: localhost{"".join(", " + o for o in sorted(Handler.extra_origins))})', flush=True)
    load_relay()
    threading.Thread(target=relay_loop, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)  # systemd stopping us: tell the phone first (see finally)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        relay_goodbye()


if __name__ == '__main__':
    main()
