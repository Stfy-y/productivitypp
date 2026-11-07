// Now playing. Two sources:
// - On the Linux computer: the local helper (extras/now-playing) that reads the desktop's players.
// - Anywhere else (the phone): the same song, which the helper shares through the sync server
//   (the Cloudflare Worker), because an https app can't reach a computer on the home network.
//   Taps are sent back the same way, so they take a second or two.
import { settings } from './store.js';
import { api } from './sync.js';

const POLL_MS = 4000;
const RELAY_STALE_MS = 15 * 60 * 1000; // the helper checks in every 10 minutes while something plays
let state = null; // last answer + `at` (when its position was measured, in this device's clock)
export let musicError = '';
let timer = null;
let lastTry = 0;
let onUpdate = () => {};
export const setMusicListener = (fn) => { onUpdate = fn; };

/** This device shows the computer's song through the sync server (it isn't the computer with the helper). */
export const viaSync = () => !settings.music && !!settings.apiUrl && settings.musicPhone !== false;
const on = () => !!settings.music || viaSync();
const base = () => (settings.musicUrl || 'http://127.0.0.1:8971').replace(/\/+$/, '');
const call = (path, opts = {}) => fetch(`${base()}${path}`, { cache: 'no-store', ...opts });
export const nowPlaying = () => (on() ? state : null);

const syncError = (e) => (/^404/.test(e.message)
  ? 'Your sync server is out of date: paste the latest worker.js into it and deploy.'
  : 'Can\'t reach your sync server.');

async function readNext() {
  if (!viaSync()) {
    const r = await call('/now-playing');
    if (!r.ok) throw new Error(`Helper error ${r.status}`);
    return { ...(await r.json()), at: Date.now() };
  }
  const m = await api('/music');
  // the computer went away without saying so (asleep, no internet): don't show an old song forever
  if (!m.status || m.age > RELAY_STALE_MS) return { status: 'none', at: Date.now() };
  return { ...m, position: m.position || 0, at: Date.now() - (m.age || 0) };
}

/** Fetch now; re-render only when something other than the position changed. */
export async function refreshMusic() {
  lastTry = Date.now();
  try {
    const next = await readNext();
    if (pendingUntil > Date.now() && state) Object.assign(next, pending); // a tap the computer hasn't reported back yet
    const sig = (s) => (s ? [s.status, s.title, s.artist, s.album, s.art, s.length, s.player, s.volume].join('|') : '');
    // a jump in position (seek, replay) also needs a redraw
    const jumped = state && Math.abs(livePosition(state) - livePosition(next)) > 3;
    const changed = sig(state) !== sig(next) || musicError || jumped;
    state = next;
    musicError = '';
    if (changed) onUpdate();
    return true;
  } catch (e) {
    const msg = viaSync() ? syncError(e) : 'The now-playing helper isn\'t running on this computer.';
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

/** Poll while `isActive()`. Through the sync server a bit faster, since the song arrives with a delay anyway. */
export function startMusic(isActive) {
  if (timer) return;
  let n = 0;
  timer = setInterval(() => {
    n++;
    if (!on() || !isActive()) return;
    if (viaSync() || n % 2 === 0) refreshMusic();
  }, POLL_MS / 2);
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

/* ---------- Controls ---------- */
// Through the sync server a tap takes a moment to reach the computer and come back, so the screen
// shows the result right away and keeps it until the computer reports back (or a few seconds pass).
let pending = {};
let pendingUntil = 0;
function expect(patch) {
  if (!state) return;
  pending = { ...pending, ...patch };
  pendingUntil = Date.now() + 6000;
  Object.assign(state, patch);
  onUpdate();
}

const sendCmd = (cmd, v) => api('/music/cmd', { method: 'POST', body: JSON.stringify({ cmd, v }) }).catch((e) => { throw new Error(syncError(e)); });

export async function musicControl(cmd) {
  if (viaSync()) {
    if (cmd === 'play-pause' && state?.status !== 'none') {
      const pos = livePosition(state);
      expect({ status: state.status === 'playing' ? 'paused' : 'playing', position: pos, at: Date.now() });
    }
    await sendCmd(cmd);
    if (cmd !== 'play-pause') { pending = {}; pendingUntil = 0; }
    setTimeout(refreshMusic, 1500);
    setTimeout(refreshMusic, 3500);
    return;
  }
  const r = await call(`/control/${cmd}`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The player didn\'t respond');
  setTimeout(refreshMusic, 250);
}

// Through the sync server every change is a write (the free plan allows 1,000 a day): while the slider
// moves, send at most one every 0.8 s, always ending with the final value.
let volTimer = null;
let volNext = null;
export async function setMusicVolume(v) {
  v = Math.max(0, Math.min(1, v));
  if (viaSync()) {
    expect({ volume: v });
    volNext = v;
    if (volTimer) return;
    const flush = async () => {
      const val = volNext;
      volNext = null;
      try { await sendCmd('volume', val); } finally {
        volTimer = volNext == null ? null : setTimeout(flush, 800);
      }
    };
    volTimer = setTimeout(flush, 0);
    return;
  }
  const r = await call(`/volume?v=${v.toFixed(3)}`, { method: 'POST' });
  if (r.status === 404) throw new Error('Update the now-playing helper to change the volume: run the setup command in Settings again.');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Couldn\'t change the volume');
  if (state) state.volume = v;
}

/** The song is on screen on this phone: the computer checks for taps every second for the next 2 minutes
 * (otherwise every 5 s). One write per 100 s at most, against the sync server's daily write limit. */
let lastWatch = 0;
export function musicWatching() {
  if (!viaSync() || document.visibilityState !== 'visible' || Date.now() - lastWatch < 100000) return;
  lastWatch = Date.now();
  sendCmd('watch').catch(() => { lastWatch = 0; });
}

/* ---------- Sharing with the phone (set up on the computer, done by the helper) ---------- */
export let phoneInfo = null; // { enabled, ok, error, sent } | { outdated: true } | null while unknown
let phoneTried = 0;
/** Fetch the sharing status now and then (Settings asks on every render). */
export function ensurePhoneInfo() {
  if (Date.now() - phoneTried < 30000) return;
  phoneTried = Date.now();
  loadPhoneInfo();
}
export async function loadPhoneInfo(action = 'info') {
  let error = '';
  try {
    const r = action === 'info' ? await call('/relay/info')
      // text/plain, so the browser doesn't need to ask the helper first (it answers simple requests only)
      : await call(`/relay/${action}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ url: settings.apiUrl, token: settings.apiToken }) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 404) phoneInfo = { outdated: true };
    else if (r.ok) phoneInfo = data;
    else error = data.error || `Helper error ${r.status}`;
  } catch { phoneInfo = null; error = 'Can\'t reach the now-playing helper.'; }
  onUpdate();
  if (error) throw new Error(error);
  return phoneInfo;
}

export const artUrl = (s) => (!s?.art ? '' : s.art.startsWith('/') ? `${base()}${s.art}?t=${encodeURIComponent(s.title)}` : s.art);

/** Position in seconds right now, counting time since it was measured while playing. */
export function livePosition(s = state) {
  if (!s) return 0;
  const p = (s.position || 0) + (s.status === 'playing' ? (Date.now() - s.at) / 1000 : 0);
  return s.length ? Math.min(p, s.length) : p;
}
