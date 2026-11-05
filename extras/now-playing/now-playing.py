#!/usr/bin/env python3
"""Productivity++ now-playing helper for Linux.

Browsers can't see which song your desktop is playing, so this tiny local server reads it from
MPRIS (the standard Linux media interface: YouTube Music Desktop, Spotify, browsers, VLC, ...)
and hands it to the app's Dashboard at http://127.0.0.1:8971. It only listens on this computer,
and only the app's own web addresses may read it or press play/pause/skip.

Usage: now-playing.py [--port 8971] [--origin https://you.github.io] ...
"""
import argparse
import json
import mimetypes
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

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
last_player = None  # stick with the same player when several are paused
ignored = []  # name fragments of players to skip (--ignore)


def dbus(dest, path, iface, method, args=None, rtype=None):
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
    artist = m.get('xesam:artist') or []
    return {
        'status': p.get('PlaybackStatus', '').lower(),
        'player': identity(name),
        'title': m.get('xesam:title', ''),
        'artist': ', '.join(artist) if isinstance(artist, list) else str(artist),
        'album': m.get('xesam:album', ''),
        'art': art,
        'length': round((m.get('mpris:length') or 0) / 1e6, 1),
        'position': round((p.get('Position') or 0) / 1e6, 1),
        'canNext': bool(p.get('CanGoNext')),
        'canPrevious': bool(p.get('CanGoPrevious')),
        'canPause': bool(p.get('CanPause') or p.get('CanPlay')),
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


class Handler(BaseHTTPRequestHandler):
    extra_origins = set()

    def log_message(self, *args):
        pass

    def origin_allowed(self):
        o = self.headers.get('Origin')
        return o is None or bool(LOCAL_ORIGIN.fullmatch(o)) or o in self.extra_origins

    def send(self, code, body=b'', ctype='application/json'):
        self.send_response(code)
        o = self.headers.get('Origin')
        if o and self.origin_allowed():
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, data, code=200):
        self.send(code, json.dumps(data).encode())

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
                return self.json({'app': 'productivitypp-now-playing', 'ok': True})
        except GLib.Error as e:
            return self.json({'error': e.message}, 500)
        self.json({'error': 'not found'}, 404)

    def do_POST(self):
        if not self.origin_allowed():
            return self.json({'error': 'origin not allowed'}, 403)
        m = re.fullmatch(r'/control/([a-z-]+)', self.path.split('?')[0])
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8971)
    ap.add_argument('--origin', action='append', default=[],
                    help='web address of your app, e.g. https://you.github.io (localhost is always allowed)')
    ap.add_argument('--ignore', action='append', default=[],
                    help='skip players whose bus name contains this, e.g. --ignore wasistlos')
    args = ap.parse_args()
    ignored.extend(i.lower() for i in args.ignore)
    Handler.extra_origins = {o.rstrip('/') for o in args.origin}
    server = HTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Now-playing helper on http://127.0.0.1:{args.port} (apps allowed: localhost{"".join(", " + o for o in sorted(Handler.extra_origins))})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
