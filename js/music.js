// Now playing: reads the local helper (extras/now-playing) that shares the desktop's current song.
import { settings } from './store.js';

const POLL_MS = 4000;
let state = null; // last /now-playing answer + `at` (when it was read)
export let musicError = '';
let timer = null;
let lastTry = 0;
let onUpdate = () => {};
export const setMusicListener = (fn) => { onUpdate = fn; };

const base = () => (settings.musicUrl || 'http://127.0.0.1:8971').replace(/\/+$/, '');
export const nowPlaying = () => (settings.music ? state : null);

/** Fetch now; re-render only when something other than the position changed. */
export async function refreshMusic() {
  lastTry = Date.now();
  try {
    const r = await fetch(`${base()}/now-playing`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Helper error ${r.status}`);
    const next = { ...(await r.json()), at: Date.now() };
    const sig = (s) => (s ? [s.status, s.title, s.artist, s.art, s.length, s.player].join('|') : '');
    // a jump in position (seek, replay) also needs a redraw
    const jumped = state && Math.abs(livePosition(state) - next.position) > 3;
    const changed = sig(state) !== sig(next) || musicError || jumped;
    state = next;
    musicError = '';
    if (changed) onUpdate();
    return true;
  } catch {
    const had = state || !musicError;
    state = null;
    musicError = 'The now-playing helper isn\'t running on this computer.';
    if (had) onUpdate();
    return false;
  }
}

/** Fetch if the last read is old (used when the Dashboard opens, so it doesn't wait for the next poll). */
export function ensureMusic() {
  if (settings.music && Date.now() - lastTry > POLL_MS) refreshMusic();
}

/** Poll while `isActive()` (Dashboard visible and the feature on). */
export function startMusic(isActive) {
  if (timer) return;
  timer = setInterval(() => { if (settings.music && isActive()) refreshMusic(); }, POLL_MS);
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
  const r = await fetch(`${base()}/control/${cmd}`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The player didn\'t respond');
  setTimeout(refreshMusic, 250);
}

export const artUrl = (s) => (!s?.art ? '' : s.art.startsWith('/') ? `${base()}${s.art}?t=${encodeURIComponent(s.title)}` : s.art);

/** Position in seconds right now, counting time since the last poll while playing. */
export function livePosition(s = state) {
  if (!s) return 0;
  const p = s.position + (s.status === 'playing' ? (Date.now() - s.at) / 1000 : 0);
  return s.length ? Math.min(p, s.length) : p;
}
