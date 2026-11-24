// "Dynamic island" for GNOME Shell: a black pill hanging under the top bar that shows
// the event happening now / coming up next, and what's playing (any MPRIS player:
// Spotify, Chrome, Firefox, …). Click it to expand; it collapses when the pointer leaves.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ArtBackground, paletteFor } from './artbg.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PAUSED_GRACE_MS = 5 * 60 * 1000; // keep a paused player in the island this long
const NEXT_WINDOW_MIN = 60; // show "next" events starting within this many minutes
const PEEK_BEFORE_MIN = 5; // briefly expand this many minutes before an event
const PEEK_MS = 6000;
const TRACK_W = 304; // progress bar width (expanded width 340 − padding)
const GAP = 6; // space between the top bar and the island

const fmtLeft = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`);
const fmtClock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmtPos = (us) => { const s = Math.max(0, Math.floor(us / 1e6)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const nowSec = () => { const d = GLib.DateTime.new_now_local(); return d.get_hour() * 3600 + d.get_minute() * 60 + d.get_second(); };

function label(styleClass, props = {}) {
  const l = new St.Label({ style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
  l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
  return l;
}

/** Tracks MPRIS media players on the session bus and picks the one to show. */
class Mpris {
  constructor(onChange) {
    this._onChange = onChange;
    this._players = new Map(); // bus name -> { proxy, sig, lastActive }
    this._bus = Gio.DBus.session;
    this._sub = this._bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
      '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
        const [name, oldOwner, newOwner] = params.deepUnpack();
        if (!name.startsWith(MPRIS_PREFIX)) return;
        if (oldOwner) this._remove(name);
        if (newOwner) this._add(name);
      });
    this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
      null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
        if (this._destroyed) return;
        try {
          const [names] = bus.call_finish(res).deepUnpack();
          for (const n of names) if (n.startsWith(MPRIS_PREFIX)) this._add(n);
        } catch (e) {
          console.warn(`Productivity++ island: could not list media players: ${e.message}`);
        }
      });
  }

  _add(name) {
    // playerctld re-exports whichever player is active; showing it would duplicate that player
    if (this._players.has(name) || name === `${MPRIS_PREFIX}playerctld`) return;
    const entry = { name, proxy: null, sig: 0, lastActive: 0 };
    this._players.set(name, entry);
    Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, null,
      name, MPRIS_PATH, PLAYER_IFACE, null, (_o, res) => {
        let proxy;
        try {
          proxy = Gio.DBusProxy.new_for_bus_finish(res);
        } catch {
          if (this._players.get(name) === entry) this._players.delete(name);
          return;
        }
        if (this._destroyed || this._players.get(name) !== entry) return;
        entry.proxy = proxy;
        entry.sig = proxy.connect('g-properties-changed', () => { this._touch(entry); this._onChange(); });
        this._touch(entry);
        this._onChange();
      });
  }

  _remove(name) {
    const entry = this._players.get(name);
    if (!entry) return;
    if (entry.sig) entry.proxy.disconnect(entry.sig);
    this._players.delete(name);
    this._onChange();
  }

  _prop(entry, key) {
    return entry.proxy?.get_cached_property(key)?.recursiveUnpack();
  }

  _touch(entry) {
    if (this._prop(entry, 'PlaybackStatus') === 'Playing') entry.lastActive = Date.now();
  }

  /** The player to show: the most recently playing one, or one paused a short while ago. */
  current() {
    let best = null;
    for (const entry of this._players.values()) {
      if (!entry.proxy) continue;
      const status = this._prop(entry, 'PlaybackStatus');
      if (status === 'Playing') entry.lastActive = Date.now();
      else if (status !== 'Paused' || Date.now() - entry.lastActive > PAUSED_GRACE_MS) continue;
      const meta = this._prop(entry, 'Metadata') || {};
      const title = meta['xesam:title'];
      if (!title) continue;
      const rank = (status === 'Playing' ? 1e15 : 0) + entry.lastActive;
      if (best && best.rank >= rank) continue;
      const artist = meta['xesam:artist'];
      best = {
        rank, entry, title, status,
        artist: Array.isArray(artist) ? artist.join(', ') : (artist || ''),
        artUrl: meta['mpris:artUrl'] || '',
        length: Number(meta['mpris:length']) || 0,
        canNext: this._prop(entry, 'CanGoNext') !== false,
        canPrev: this._prop(entry, 'CanGoPrevious') !== false,
      };
    }
    return best;
  }

  position(entry, cb) {
    entry.proxy.call('org.freedesktop.DBus.Properties.Get', new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
      Gio.DBusCallFlags.NONE, 1000, null, (proxy, res) => {
        try {
          const [v] = proxy.call_finish(res).deepUnpack();
          cb(Number(v.unpack()));
        } catch {
          cb(null);
        }
      });
  }

  control(entry, method) {
    entry.proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
  }

  raise(entry) {
    this._bus.call(entry.name, MPRIS_PATH, 'org.mpris.MediaPlayer2', 'Raise', null, null,
      Gio.DBusCallFlags.NONE, -1, null, null);
  }

  destroy() {
    this._destroyed = true;
    this._bus.signal_unsubscribe(this._sub);
    for (const entry of this._players.values()) if (entry.sig) entry.proxy.disconnect(entry.sig);
    this._players.clear();
  }
}

export class Island {
  constructor({ openApp }) {
    this._openApp = openApp;
    this._schedule = [];
    this._expanded = false;
    this._shown = false;
    this._target = null;
    this._session = new Soup.Session({ timeout: 15 });
    this._artCache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'productivitypp', 'art']);
    this._peeked = new Set();

    this._build();
    Main.layoutManager.addChrome(this._root, { trackFullscreen: true });

    this._mpris = new Mpris(() => this._update());
    this._signals = [
      [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._reposition())],
      [Main.layoutManager.panelBox, Main.layoutManager.panelBox.connect('notify::height', () => this._reposition())],
      [Main.overview, Main.overview.connect('showing', () => this._update())],
      [Main.overview, Main.overview.connect('hidden', () => this._update())],
    ];
    this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => { this._update(); return GLib.SOURCE_CONTINUE; });
    this._reposition();
    this._update();
  }

  /** Timed items for today: [{ title, s, e (minutes), color, location, kind }], sorted by start. */
  setSchedule(items) {
    this._schedule = items || [];
    this._update();
  }

  _build() {
    // _root is managed by the layout manager (hidden in fullscreen); _island is the visible pill;
    // _clip animates its size and cuts off the content while it grows or shrinks.
    this._root = new St.Widget({ name: 'pppIslandRoot' });
    this._island = new St.Widget({ style_class: 'ppp-island', reactive: true, track_hover: true, visible: false, opacity: 0 });
    this._island.set_pivot_point(0.5, 0);
    this._clip = new St.Widget({ clip_to_allocation: true });
    // While music plays, the cover-coloured background of the full-screen player sits behind the content
    this._bg = new ArtBackground(this._island, this._clip);
    this._island.add_child(this._bg.actor);
    this._island.add_child(this._clip);
    this._root.add_child(this._island);

    // Collapsed
    this._compact = new St.BoxLayout({ style_class: 'ppp-island-compact' });
    this._cArt = new St.Widget({ style_class: 'ppp-island-art-sm', y_align: Clutter.ActorAlign.CENTER });
    this._cDot = new St.Widget({ style_class: 'ppp-island-dot', y_align: Clutter.ActorAlign.CENTER });
    this._cTitle = label('ppp-island-ctitle');
    this._cRight = label('ppp-island-cright');
    this._cBars = new St.BoxLayout({ style_class: 'ppp-island-bars', y_align: Clutter.ActorAlign.CENTER });
    this._bars = [0, 1, 2, 3].map(() => {
      const b = new St.Widget({ style_class: 'ppp-island-bar', y_align: Clutter.ActorAlign.CENTER });
      b.set_pivot_point(0.5, 0.5);
      this._cBars.add_child(b);
      return b;
    });
    for (const a of [this._cArt, this._cDot, this._cTitle, this._cBars, this._cRight]) this._compact.add_child(a);

    // Expanded
    this._expandedBox = new St.BoxLayout({ style_class: 'ppp-island-expanded', vertical: true, visible: false, opacity: 0 });

    this._mBox = new St.BoxLayout({ vertical: true, style_class: 'ppp-island-section' });
    const mHead = new St.BoxLayout({ style_class: 'ppp-island-mhead', x_expand: true });
    this._mArt = new St.Widget({ style_class: 'ppp-island-art' });
    const mText = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    this._mTitle = label('ppp-island-title');
    this._mArtist = label('ppp-island-sub');
    mText.add_child(this._mTitle);
    mText.add_child(this._mArtist);
    mHead.add_child(this._mArt);
    mHead.add_child(mText);
    const mHeadBtn = new St.Button({ child: mHead, style_class: 'ppp-island-link', can_focus: false, x_expand: true, x_align: Clutter.ActorAlign.FILL });
    mHeadBtn.connect('clicked', () => this._music && this._mpris.raise(this._music.entry));
    this._mBox.add_child(mHeadBtn);
    [this._mTrack, this._mFill] = this._track();
    this._mBox.add_child(this._mTrack);
    this._mTimes = new St.BoxLayout();
    this._mPos = label('ppp-island-time', { x_expand: true });
    this._mLen = label('ppp-island-time');
    this._mTimes.add_child(this._mPos);
    this._mTimes.add_child(this._mLen);
    this._mBox.add_child(this._mTimes);
    const controls = new St.BoxLayout({ style_class: 'ppp-island-controls', x_align: Clutter.ActorAlign.CENTER });
    const btn = (icon, method) => {
      const b = new St.Button({ style_class: 'ppp-island-btn', can_focus: false, child: new St.Icon({ icon_name: icon, icon_size: 22 }) });
      b.connect('clicked', () => this._music && this._mpris.control(this._music.entry, method));
      controls.add_child(b);
      return b;
    };
    this._prevBtn = btn('media-skip-backward-symbolic', 'Previous');
    this._playBtn = btn('media-playback-pause-symbolic', 'PlayPause');
    this._nextBtn = btn('media-skip-forward-symbolic', 'Next');
    this._mBox.add_child(controls);

    this._sep = new St.Widget({ style_class: 'ppp-island-sep' });

    const eBox = new St.BoxLayout({ vertical: true, style_class: 'ppp-island-section', x_expand: true });
    const eHead = new St.BoxLayout({ style_class: 'ppp-island-ehead' });
    this._eDot = new St.Widget({ style_class: 'ppp-island-dot', y_align: Clutter.ActorAlign.CENTER });
    this._eKind = label('ppp-island-kind', { x_expand: true });
    this._eLeft = label('ppp-island-cright');
    eHead.add_child(this._eDot);
    eHead.add_child(this._eKind);
    eHead.add_child(this._eLeft);
    eBox.add_child(eHead);
    this._eTitle = label('ppp-island-title');
    this._eDetail = label('ppp-island-sub');
    eBox.add_child(this._eTitle);
    eBox.add_child(this._eDetail);
    [this._eTrack, this._eFill] = this._track();
    eBox.add_child(this._eTrack);
    this._eThen = label('ppp-island-sub ppp-island-then');
    eBox.add_child(this._eThen);
    this._eBtn = new St.Button({ child: eBox, style_class: 'ppp-island-link', can_focus: false, x_expand: true, x_align: Clutter.ActorAlign.FILL });
    this._eBtn.connect('clicked', () => this._openApp('#/calendar'));

    this._expandedBox.add_child(this._mBox);
    this._expandedBox.add_child(this._sep);
    this._expandedBox.add_child(this._eBtn);

    this._clip.add_child(this._compact);
    this._clip.add_child(this._expandedBox);
    this._clip.connect('notify::width', () => this._reposition());

    // Click to expand / collapse; collapse shortly after the pointer leaves
    this._island.connect('button-release-event', () => {
      this._setExpanded(!this._expanded);
      return Clutter.EVENT_STOP;
    });
    this._island.connect('notify::hover', () => {
      this._clearTimeout('_collapseId');
      if (this._island.hover || !this._expanded) return;
      this._collapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        this._collapseId = 0;
        this._setExpanded(false);
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  _track() {
    const track = new St.Widget({ style_class: 'ppp-island-track' });
    const fill = new St.Widget({ style_class: 'ppp-island-fill' });
    track.add_child(fill);
    return [track, fill];
  }

  _clearTimeout(key) {
    if (this[key]) GLib.source_remove(this[key]);
    this[key] = 0;
  }

  _reposition() {
    const mon = Main.layoutManager.primaryMonitor;
    if (!mon) return;
    const w = this._clip.width;
    this._root.set_position(mon.x + Math.round((mon.width - w) / 2), mon.y + Main.layoutManager.panelBox.height + GAP);
    // Keep the content centered while the pill grows or shrinks
    for (const child of [this._compact, this._expandedBox]) {
      if (!child.visible) continue;
      const [, cw] = child.get_preferred_width(-1);
      child.set_position(Math.round((w - cw) / 2), 0);
    }
  }

  _setExpanded(expanded, { peek = false } = {}) {
    this._clearTimeout('_peekId');
    if (peek) {
      this._peekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_MS, () => {
        this._peekId = 0;
        if (!this._island.hover) this._setExpanded(false);
        return GLib.SOURCE_REMOVE;
      });
    }
    if (this._expanded === expanded) return;
    this._expanded = expanded;
    const [show, hide] = expanded ? [this._expandedBox, this._compact] : [this._compact, this._expandedBox];
    hide.remove_all_transitions();
    hide.hide();
    hide.opacity = 0;
    show.show();
    show.opacity = 0;
    show.ease({ opacity: 255, delay: 90, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    if (expanded) this._island.add_style_class_name('expanded');
    else this._island.remove_style_class_name('expanded');
    this._update();
  }

  _events() {
    const sec = nowSec();
    const min = Math.floor(sec / 60);
    const current = this._schedule.find((i) => i.s <= min && min < i.e);
    const upcoming = this._schedule.filter((i) => i.s > min);
    const next = upcoming[0];
    return { sec, min, current, next, soon: next && next.s - min <= NEXT_WINDOW_MIN ? next : null };
  }

  _update() {
    if (this._destroyed) return;
    const music = this._mpris.current();
    this._music = music;
    const { sec, min, current, next, soon } = this._events();
    const event = current || soon;
    const visible = !!(music || event) && !Main.overview.visible;

    // Peek (auto-expand for a few seconds) when an event starts and shortly before one
    if (event) {
      const key = `${event.title}@${event.s}:${current ? 'now' : 'soon'}`;
      const peekNow = current ? true : event.s - min <= PEEK_BEFORE_MIN;
      if (visible && peekNow && !this._peeked.has(key)) {
        this._peeked.add(key);
        if (!this._expanded) this._setExpanded(true, { peek: true });
      }
    }

    this._bg.setActive(visible && !!music);
    if (!visible) {
      if (this._expanded) this._setExpanded(false);
      this._setShown(false);
      return;
    }

    const eventLeft = event && (current
      ? Math.max(1, Math.ceil((current.e * 60 - sec) / 60))
      : Math.max(0, Math.ceil((event.s * 60 - sec) / 60)));
    const eventText = event && (current ? `${fmtLeft(eventLeft)} left` : (eventLeft < 1 ? 'now' : `in ${fmtLeft(eventLeft)}`));
    const color = event?.color || '#4f6bed';

    // Collapsed: music takes the left side when playing; the event countdown goes on the right
    this._cArt.visible = !!music;
    this._cDot.visible = !music;
    this._cBars.visible = !!music && !event;
    this._cTitle.text = music ? music.title : event.title;
    this._cRight.visible = !!event;
    if (event) {
      this._cRight.text = current ? fmtLeft(eventLeft) : (eventLeft < 1 ? 'now' : `in ${fmtLeft(eventLeft)}`);
      this._cRight.style = `color: ${color};`;
      this._cDot.style = `background-color: ${color};`;
    }
    this._setBarsPlaying(!!music && !event && music.status === 'Playing');

    // Expanded
    this._mBox.visible = !!music;
    this._sep.visible = !!music && !!event;
    this._eBtn.visible = !!event;
    if (music) {
      this._setArt(music.artUrl);
      this._mTitle.text = music.title;
      this._mArtist.text = music.artist;
      this._mArtist.visible = !!music.artist;
      this._playBtn.child.icon_name = music.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
      this._prevBtn.reactive = music.canPrev;
      this._prevBtn.opacity = music.canPrev ? 255 : 90;
      this._nextBtn.reactive = music.canNext;
      this._nextBtn.opacity = music.canNext ? 255 : 90;
      this._mTrack.visible = this._mTimes.visible = music.length > 0;
      if (this._expanded && music.length > 0) this._updatePosition(music);
    }
    if (event) {
      this._eDot.style = `background-color: ${color};`;
      this._eKind.text = current ? 'NOW' : 'NEXT';
      this._eLeft.text = eventText;
      this._eLeft.style = `color: ${color};`;
      this._eTitle.text = event.title;
      this._eDetail.text = `${fmtClock(event.s)} – ${fmtClock(event.e)}${event.location ? ` · ${event.location}` : ''}`;
      this._eTrack.visible = !!current;
      if (current) {
        const frac = Math.min(1, Math.max(0, (sec - current.s * 60) / ((current.e - current.s) * 60 || 1)));
        this._eFill.width = Math.round(TRACK_W * frac);
        this._eFill.style = `background-color: ${color};`;
      }
      const then = current ? next : this._schedule.find((i) => i.s > event.s);
      this._eThen.visible = !!then;
      if (then) this._eThen.text = `Then: ${then.title} at ${fmtClock(then.s)}`;
    }

    this._setShown(true);
    this._resize();
  }

  _updatePosition(music) {
    if (this._posPending) return;
    this._posPending = true;
    this._mpris.position(music.entry, (pos) => {
      this._posPending = false;
      if (this._destroyed || pos === null || this._music?.entry !== music.entry) return;
      const len = this._music.length || music.length;
      this._mFill.width = Math.round(TRACK_W * Math.min(1, pos / len));
      this._mPos.text = fmtPos(pos);
      this._mLen.text = `-${fmtPos(Math.max(0, len - pos))}`;
    });
  }

  _setBarsPlaying(playing) {
    if (playing === !!this._barsId) return;
    this._clearTimeout('_barsId');
    if (!playing) {
      for (const b of this._bars) b.ease({ scale_y: 0.3, duration: 200 });
      return;
    }
    this._barsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
      for (const b of this._bars) b.ease({ scale_y: 0.25 + Math.random() * 0.75, duration: 240, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD });
      return GLib.SOURCE_CONTINUE;
    });
  }

  /** Album art: local files are used directly; web images are downloaded once into the cache. */
  _setArt(url) {
    if (url === this._artUrl) return;
    this._artUrl = url;
    const apply = (uri) => {
      if (this._destroyed || this._artUrl !== url) return;
      const style = uri ? `background-image: url("${uri.replace(/"/g, '%22')}");` : '';
      this._mArt.style = style;
      this._cArt.style = style;
      this._bg.setPalette(uri ? paletteFor(uri) : null);
      for (const a of [this._mArt, this._cArt]) {
        if (uri) a.remove_style_class_name('no-art');
        else a.add_style_class_name('no-art');
      }
    };
    if (!url) return apply(null);
    if (url.startsWith('file://')) return apply(url);
    if (!/^https?:\/\//.test(url)) return apply(null);

    const path = GLib.build_filenamev([this._artCache, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)]);
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) return apply(`file://${path}`);
    apply(null);
    let msg;
    try {
      msg = Soup.Message.new('GET', url);
    } catch {
      return;
    }
    this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, res) => {
      try {
        const bytes = session.send_and_read_finish(res);
        if (msg.get_status() !== 200) return;
        GLib.mkdir_with_parents(this._artCache, 0o700);
        GLib.file_set_contents(path, bytes.get_data());
        apply(`file://${path}`);
      } catch {
        // No art; the placeholder stays
      }
    });
  }

  _setShown(shown) {
    if (shown === this._shown) return;
    this._shown = shown;
    this._island.remove_all_transitions();
    if (shown) {
      this._island.show();
      this._island.set({ opacity: 0, scale_x: 0.6, scale_y: 0.6 });
      this._island.ease({ opacity: 255, scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK });
    } else {
      this._island.ease({
        opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 220, mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => { if (!this._shown) this._island.hide(); },
      });
      this._target = null;
    }
  }

  /** Animate the pill to the size of whatever it shows now. */
  _resize() {
    const child = this._expanded ? this._expandedBox : this._compact;
    const [, w] = child.get_preferred_width(-1);
    const [, h] = child.get_preferred_height(w);
    const key = `${w}x${h}`;
    if (key === this._target) return;
    const first = this._target === null;
    this._target = key;
    this._bg.setTargetSize(w, h);
    if (first && !this._clip.width) {
      this._clip.set_size(w, h);
      this._reposition();
      return;
    }
    const growing = w * h > this._clip.width * this._clip.height;
    this._clip.ease({
      width: w, height: h, duration: growing ? 420 : 300,
      mode: growing ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUINT,
    });
  }

  destroy() {
    this._destroyed = true;
    for (const key of ['_tick', '_peekId', '_collapseId', '_barsId']) this._clearTimeout(key);
    for (const [obj, id] of this._signals) obj.disconnect(id);
    this._mpris.destroy();
    this._bg.destroy();
    this._session.abort();
    this._root.destroy();
  }
}
