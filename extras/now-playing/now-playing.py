#!/usr/bin/env python3
"""Productivity++ now-playing helper for Linux.

Browsers can't see which song your desktop is playing, so this tiny local server reads it from
MPRIS (the standard Linux media interface: YouTube Music Desktop, Spotify, browsers, VLC, ...)
and hands it to the app's Dashboard at http://127.0.0.1:8971. It only listens on this computer,
and only the app's own web addresses may read it or press play/pause/skip or change the volume.

Phone remote (off until you turn it on in the app's Settings): a second server on port 8972 that
your phone can open over the local network. Every request to it needs a secret key, which is in
the link/QR code the app shows.

Usage: now-playing.py [--port 8971] [--remote-port 8972] [--origin https://you.github.io] ...
"""
import argparse
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
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
CONFIG = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'productivitypp', 'remote.json')

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


# ---------- Phone remote ----------
remote = {'enabled': False, 'token': '', 'app': ''}
remote_server = None
remote_port = 8972
APP_FILE = re.compile(r'(css/[\w-]+\.css|js/[\w-]+(/[\w-]+)*\.js|icons/[\w-]+\.(png|svg))')
app_cache = {}  # path -> (bytes, type, fetched at)


def load_remote():
    try:
        with open(CONFIG) as f:
            remote.update({k: v for k, v in json.load(f).items() if k in remote})
    except (OSError, ValueError):
        pass


def save_remote():
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(remote, f)


def lan_addresses():
    ips = []
    try:  # the address this computer would use to reach the internet (no packet is sent)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('192.0.2.1', 9))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.') and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return ips


def remote_info():
    # the key goes in the address itself, so a home-screen icon made from it keeps working
    links = [f'http://{ip}:{remote_port}/remote?k={remote["token"]}' for ip in lan_addresses()] if remote['enabled'] else []
    return {'enabled': remote['enabled'], 'running': remote_server is not None, 'links': links, 'port': remote_port}


def start_remote():
    global remote_server
    if remote_server:
        return
    try:
        remote_server = ThreadingHTTPServer(('0.0.0.0', remote_port), RemoteHandler)
    except OSError as e:
        print(f'Phone remote: can\'t listen on port {remote_port}: {e}', flush=True)
        return
    remote_server.daemon_threads = True
    threading.Thread(target=remote_server.serve_forever, daemon=True).start()
    print(f'Phone remote on port {remote_port}', flush=True)


def stop_remote():
    global remote_server
    if remote_server:
        srv, remote_server = remote_server, None
        threading.Thread(target=lambda: (srv.shutdown(), srv.server_close()), daemon=True).start()


def app_file(path):
    """The phone page loads the app's player code through us (it can't reach the app's https address from an http page reliably)."""
    hit = app_cache.get(path)
    if hit and time.time() - hit[2] < 300:
        return hit[0], hit[1]
    try:
        with urllib.request.urlopen(urllib.parse.urljoin(remote['app'], path), timeout=8) as r:
            data, ctype = r.read(), r.headers.get('Content-Type') or mimetypes.guess_type(path)[0] or 'application/octet-stream'
    except Exception:
        return (hit[0], hit[1]) if hit else (None, None)  # offline: an old copy is better than nothing
    app_cache[path] = (data, ctype, time.time())
    return data, ctype


REMOTE_PAGE = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#15161d">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Now playing">
<title>Now playing</title>
<link rel="manifest" href="/remote.webmanifest{query}"><link rel="icon" href="/app/icons/icon.svg"><link rel="apple-touch-icon" href="/app/icons/apple-touch-icon.png">
<link rel="stylesheet" href="/app/css/app.css">
<style>html, body { margin: 0; background: #15161d; color: #fff; color-scheme: dark; }</style>
</head><body class="np-remote">{keep_key}
<script type="module" src="/app/js/remote.js"></script>
<noscript><p style="padding:24px;font:16px system-ui">Turn on JavaScript to use the remote.</p></noscript>
</body></html>'''



def key_ok(key):
    return bool(remote['enabled'] and remote['token'] and key) and hmac.compare_digest(key.encode(), remote['token'].encode())


def remote_page(key):
    """With a valid key in the address, the home-screen start address carries it too. Home-screen apps
    don't share storage with the browser on iPhone, so a key saved by the browser isn't there."""
    if not key_ok(key):
        return REMOTE_PAGE.replace('{query}', '').replace('{keep_key}', '')
    keep = f'<script>try {{ localStorage.setItem("ppp-remote-key", {json.dumps(key)}); }} catch (e) {{}}</script>'
    return REMOTE_PAGE.replace('{query}', f'?k={urllib.parse.quote(key)}').replace('{keep_key}', keep)


def remote_manifest(key):
    return json.dumps({
        'name': 'Now playing', 'short_name': 'Now playing', 'id': '/remote', 'scope': '/', 'display': 'fullscreen',
        'start_url': f'/remote?k={urllib.parse.quote(key)}' if key_ok(key) else '/remote',
        'background_color': '#15161d', 'theme_color': '#15161d',
        'icons': [{'src': '/app/icons/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
                  {'src': '/app/icons/icon-512.png', 'sizes': '512x512', 'type': 'image/png'}],
    })


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    extra_origins = set()

    def log_message(self, *args):
        pass

    def origin_allowed(self):
        o = self.headers.get('Origin')
        return o is None or bool(LOCAL_ORIGIN.fullmatch(o)) or o in self.extra_origins

    def allowed(self):
        return self.origin_allowed()

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
        if not self.allowed():
            return self.json({'error': 'not allowed'}, 403)
        path = self.path.split('?')[0]
        try:
            if path == '/now-playing':
                return self.json(now_playing())
            if path == '/art':
                data, mime = art_file()
                return self.send(200, data, mime) if data else self.send(404, ctype='text/plain')
            if path == '/':
                return self.json({'app': 'productivitypp-now-playing', 'ok': True, 'remote': True})
            if path == '/remote/info':
                return self.json(remote_info())
        except GLib.Error as e:
            return self.json({'error': e.message}, 500)
        self.json({'error': 'not found'}, 404)

    def do_POST(self):
        if not self.allowed():
            return self.json({'error': 'not allowed'}, 403)
        path = self.path.split('?')[0]
        if path == '/volume':
            try:
                set_volume(float(self.query().get('v', [''])[0]))
            except ValueError:
                return self.json({'error': 'bad volume'}, 400)
            except (GLib.Error, RuntimeError, OSError, subprocess.SubprocessError) as e:
                return self.json({'error': f'Couldn\'t change the volume: {getattr(e, "message", e)}'}, 500)
            return self.json({'ok': True})
        if path in ('/remote/enable', '/remote/disable'):
            return self.remote_setup(path.endswith('enable'))
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

    def remote_setup(self, on):
        if on:
            # the app tells us its own address, so the phone page can load the player from it
            app = self.query().get('app', [''])[0]
            u = urllib.parse.urlparse(app)
            origin = f'{u.scheme}://{u.netloc}'
            if u.scheme not in ('http', 'https') or (self.headers.get('Origin') and self.headers['Origin'] != origin):
                return self.json({'error': 'bad app address'}, 400)
            remote.update(enabled=True, app=app if app.endswith('/') else app + '/', token=remote['token'] or secrets.token_urlsafe(24))
            app_cache.clear()
            save_remote()
            start_remote()
        else:
            remote.update(enabled=False, token='')  # a new key next time: old links stop working
            save_remote()
            stop_remote()
        self.json(remote_info())


class RemoteHandler(Handler):
    """The phone remote, reachable from the local network: everything but the page itself needs the key."""
    PUBLIC = {'/remote', '/remote.webmanifest'}

    def origin_allowed(self):
        return False  # same-origin page: no CORS headers for anyone

    def allowed(self):
        path = self.path.split('?')[0]
        if path in self.PUBLIC or path.startswith('/app/'):
            return True
        return key_ok(self.headers.get('X-Key') or self.query().get('k', [''])[0])

    def do_OPTIONS(self):
        self.send(403, ctype='text/plain')

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/remote':
            return self.send(200, remote_page(self.query().get('k', [''])[0]).encode(), 'text/html; charset=utf-8', 'no-store')
        if path == '/remote.webmanifest':
            return self.send(200, remote_manifest(self.query().get('k', [''])[0]).encode(), 'application/manifest+json', 'no-store')
        if path.startswith('/app/'):
            rel = path[5:]
            if not APP_FILE.fullmatch(rel) or not remote['app']:
                return self.send(404, ctype='text/plain')
            data, ctype = app_file(rel)
            return self.send(200, data, ctype, 'no-cache') if data else self.send(502, ctype='text/plain')
        if path.startswith('/remote/'):
            return self.json({'error': 'not found'}, 404)
        super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0].startswith('/remote/'):
            return self.json({'error': 'not found'}, 404)
        super().do_POST()


def main():
    global look_up_covers, remote_port
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8971)
    ap.add_argument('--remote-port', type=int, default=8972, help='port for the phone remote (only used once it\'s turned on in the app)')
    ap.add_argument('--origin', action='append', default=[],
                    help='web address of your app, e.g. https://you.github.io (localhost is always allowed)')
    ap.add_argument('--ignore', action='append', default=[],
                    help='skip players whose bus name contains this, e.g. --ignore wasistlos')
    ap.add_argument('--no-covers', action='store_true',
                    help='don\'t look up square album covers and album names on YouTube Music (keeps what the player reports)')
    args = ap.parse_args()
    ignored.extend(i.lower() for i in args.ignore)
    look_up_covers = not args.no_covers
    remote_port = args.remote_port
    Handler.extra_origins = {o.rstrip('/') for o in args.origin}
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    print(f'Now-playing helper on http://127.0.0.1:{args.port} (apps allowed: localhost{"".join(", " + o for o in sorted(Handler.extra_origins))})', flush=True)
    load_remote()
    if remote['enabled'] and remote['token']:
        start_remote()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
