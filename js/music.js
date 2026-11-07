// Now playing: reads the local helper (extras/now-playing) that shares the desktop's current song.
import { settings } from './store.js';

const POLL_MS = 4000;
let state = null; // last /now-playing answer + `at` (when it was read)
export let musicError = '';
let timer = null;
let lastTry = 0;
let onUpdate = () => {};
export const setMusicListener = (fn) => { onUpdate = fn; };

// On the phone remote page (served by the helper over the local network) everything goes to that page's own address with its key.
let remote = null; // { base, key }
export function useRemote(base, key) { remote = { base, key }; }
export const isRemote = () => !!remote;

const base = () => (remote?.base || settings.musicUrl || 'http://127.0.0.1:8971').replace(/\/+$/, '');
const on = () => !!(remote || settings.music);
const call = (path, opts = {}) => fetch(`${base()}${path}`, { cache: 'no-store', ...opts, headers: remote ? { 'X-Key': remote.key } : {} });
export const nowPlaying = () => (on() ? state : null);

/** Fetch now; re-render only when something other than the position changed. */
export async function refreshMusic() {
  lastTry = Date.now();
  try {
    const r = await call('/now-playing');
    if (!r.ok) throw Object.assign(new Error(`Helper error ${r.status}`), { status: r.status });
    const next = { ...(await r.json()), at: Date.now() };
    const sig = (s) => (s ? [s.status, s.title, s.artist, s.album, s.art, s.length, s.player, s.volume].join('|') : '');
    // a jump in position (seek, replay) also needs a redraw
    const jumped = state && Math.abs(livePosition(state) - next.position) > 3;
    const changed = sig(state) !== sig(next) || musicError || jumped;
    state = next;
    musicError = '';
    if (changed) onUpdate();
    return true;
  } catch (e) {
    const msg = !remote ? 'The now-playing helper isn\'t running on this computer.'
      : e.status === 403 ? 'This link doesn\'t work anymore. Scan the code in Settings → Now playing on your computer again.'
      : 'Can\'t reach your computer. Is it on, and is this phone on the same Wi-Fi?';
    const had = state || musicError !== msg;
    state = null;
    musicError = msg;
    if (had) onUpdate();
    return false;
  }
}

/** Fetch if the last read is old (used when the Dashboard opens, so it doesn't wait for the next poll). */
export function ensureMusic() {
  if (on() && Date.now() - lastTry > POLL_MS) refreshMusic();
}

/** Poll while `isActive()` (Dashboard visible and the feature on). */
export function startMusic(isActive, ms = POLL_MS) {
  if (timer) return;
  timer = setInterval(() => { if (on() && isActive()) refreshMusic(); }, ms);
}

/* ---------- Setup ---------- */
/** The one-line install command for this copy of the app (it also tells the helper which site may use it). */
export function installCommand() {
  const app = new URL('.', location.href).href;
  return `curl -fsSL ${app}extras/now-playing/install.sh | bash -s -- ${app}`;
}

export const isLinuxDesktop = () => /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

/** After the command is copied: check for the helper every few seconds and turn the feature on when it answers. */
export let waitingForHelper = false;
let watchT = null;
export function watchForHelper(onFound) {
  clearInterval(watchT);
  waitingForHelper = true;
  const until = Date.now() + 15 * 60 * 1000;
  const check = async () => {
    if (Date.now() > until) { clearInterval(watchT); waitingForHelper = false; onUpdate(); return; }
    try {
      const r = await fetch(`${base()}/`, { cache: 'no-store' });
      if (!r.ok) return;
      clearInterval(watchT);
      waitingForHelper = false;
      onFound();
    } catch { /* not running yet */ }
  };
  watchT = setInterval(check, 3000);
  onUpdate();
}

export async function musicControl(cmd) {
  const r = await call(`/control/${cmd}`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The player didn\'t respond');
  setTimeout(refreshMusic, 250);
}

/** Volume 0..1: the player's own volume, or the computer's when the player has none. */
export async function setMusicVolume(v) {
  const r = await call(`/volume?v=${Math.max(0, Math.min(1, v)).toFixed(3)}`, { method: 'POST' });
  if (r.status === 404) throw new Error('Update the now-playing helper to change the volume: run the setup command in Settings again.');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Couldn\'t change the volume');
  if (state) state.volume = v;
}

/* ---------- Phone remote (the helper serves a player page on the local network) ---------- */
export let remoteInfo = null; // { enabled, running, links, port } | { outdated: true } | null while unknown
let remoteTried = 0;
/** Fetch the remote's status now and then (Settings asks on every render). */
export function ensureRemoteInfo() {
  if (Date.now() - remoteTried < 30000) return;
  remoteTried = Date.now();
  loadRemoteInfo();
}
export async function loadRemoteInfo(action = 'info') {
  try {
    const app = new URL('.', location.href).href;
    const r = action === 'info' ? await call('/remote/info') : await call(`/remote/${action}?app=${encodeURIComponent(app)}`, { method: 'POST' });
    remoteInfo = r.status === 404 ? { outdated: true } : r.ok ? await r.json() : remoteInfo;
  } catch { remoteInfo = null; }
  onUpdate();
  return remoteInfo;
}

export const artUrl = (s) => (!s?.art ? '' : s.art.startsWith('/')
  ? `${base()}${s.art}?t=${encodeURIComponent(s.title)}${remote ? `&k=${encodeURIComponent(remote.key)}` : ''}` : s.art);

/** Position in seconds right now, counting time since the last poll while playing. */
export function livePosition(s = state) {
  if (!s) return 0;
  const p = s.position + (s.status === 'playing' ? (Date.now() - s.at) / 1000 : 0);
  return s.length ? Math.min(p, s.length) : p;
}
