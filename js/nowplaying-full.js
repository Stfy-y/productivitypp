// Full-screen "Now playing": big cover, title/artist, progress and controls over a soft,
// slowly drifting gradient made from the cover's own colours.
// It lives outside #view so dashboard re-renders don't rebuild it (no flicker, no restarted animations).
// It is also the whole page of the phone remote (js/remote.js), so it handles its own buttons
// instead of relying on the app's data-action handler.
import { esc } from './util.js';
import { icon } from './icons.js';
import { nowPlaying, livePosition, artUrl, musicError, musicControl, setMusicVolume } from './music.js';

let root = null;
let tick = null;
let weFullscreened = false;
let lastArt = null;
let remoteMode = false;
let volBusyUntil = 0; // ignore volume reports from the helper while the slider is being moved
let volBeforeMute = 0.5;
let flashT = null;
const palettes = new Map(); // art url -> [c1..c4] (or null when the image can't be read)

export const nowPlayingOpen = () => !!root;

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/* ---------- Cover colours ---------- */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Up to 4 distinct, fairly vivid colours, toned so white text stays readable on top. */
function extractPalette(img) {
  const N = 40;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data; // throws when the image is cross-origin without CORS
  const bins = new Map();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const [, s, l] = rgbToHsl(r, g, b);
    const key = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
    const w = 1 + s * 3 * (1 - Math.abs(l - 0.5) * 1.4); // favour colourful mid-tones over greys
    const bin = bins.get(key) || { w: 0, r: 0, g: 0, b: 0, n: 0 };
    bin.w += w; bin.r += r; bin.g += g; bin.b += b; bin.n++;
    bins.set(key, bin);
  }
  const sorted = [...bins.values()].sort((a, b) => b.w - a.w).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
  const picked = [];
  for (const col of sorted) {
    if (picked.every((p) => Math.hypot(p[0] - col[0], p[1] - col[1], p[2] - col[2]) > 70)) picked.push(col);
    if (picked.length === 4) break;
  }
  if (!picked.length) return null;
  const hsl = picked.map(([r, g, b]) => rgbToHsl(r, g, b));
  while (hsl.length < 4) { const [h, s, l] = hsl[hsl.length % picked.length]; hsl.push([(h + 18) % 360, s, l * 0.7]); }
  return hsl.map(([h, s, l], i) => {
    const L = Math.min(0.52, Math.max(i === 3 ? 0.12 : 0.2, l)); // the base (4th) may go darker
    return `hsl(${h.toFixed(0)} ${(Math.min(1, s * 1.15) * 100).toFixed(0)}% ${(L * 100).toFixed(0)}%)`;
  });
}

function loadPalette(url) {
  if (palettes.has(url)) return Promise.resolve(palettes.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      let pal = null;
      try { pal = extractPalette(img); } catch { /* no CORS: fall back to the blurred cover */ }
      palettes.set(url, pal);
      resolve(pal);
    };
    img.onerror = () => { palettes.set(url, null); resolve(null); };
    img.src = url;
  });
}

function applyArt(art) {
  if (art === lastArt) return;
  lastArt = art;
  const blur = root.querySelector('.npf-blur');
  const cover = root.querySelector('.npf-cover');
  blur.style.backgroundImage = art ? `url("${art.replace(/"/g, '%22')}")` : '';
  cover.innerHTML = art ? `<img src="${esc(art)}" alt="" referrerpolicy="no-referrer">` : `<div class="npf-ph">${icon('music')}</div>`;
  root.classList.remove('has-colors');
  if (!art) return;
  loadPalette(art).then((pal) => {
    if (!root || lastArt !== art || !pal) return;
    pal.forEach((c, i) => root.style.setProperty(`--np-c${i + 1}`, c));
    root.classList.add('has-colors');
  });
}

/* ---------- DOM ---------- */
function build() {
  const el = document.createElement('div');
  el.className = `npf${remoteMode ? ' remote' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Now playing');
  el.tabIndex = -1;
  const canFull = remoteMode && document.fullscreenEnabled;
  el.innerHTML = `
    <div class="npf-bg" aria-hidden="true">
      <div class="npf-blur"></div>
      <span class="npf-blob b1"></span><span class="npf-blob b2"></span><span class="npf-blob b3"></span><span class="npf-blob b4"></span>
      <div class="npf-grain"></div>
    </div>
    ${remoteMode
      ? (canFull ? `<button class="npf-close icon-btn" data-np="fullscreen" aria-label="Full screen" title="Full screen">${icon('expand')}</button>` : '')
      : `<button class="npf-close icon-btn" data-np="close" aria-label="Close full screen player" title="Close (Esc)">${icon('close')}</button>`}
    <div class="npf-clock" aria-hidden="true"><b class="npf-clock-time"></b><span class="npf-clock-date"></span></div>
    <div class="npf-body">
      <div class="npf-cover"></div>
      <div class="npf-meta">
        <span class="npf-label"></span>
        <h2 class="npf-title"></h2>
        <p class="npf-artist"></p>
        <p class="npf-album"></p>
        <div class="npf-progress">
          <div class="npf-bar"><span></span></div>
          <div class="npf-time"><span class="npf-pos">0:00</span><span class="npf-len">0:00</span></div>
        </div>
        <div class="npf-ctl">
          <button class="icon-btn npf-prev" data-cmd="previous" aria-label="Previous track">${icon('prev')}</button>
          <button class="icon-btn npf-play" data-cmd="play-pause" aria-label="Play"></button>
          <button class="icon-btn npf-next" data-cmd="next" aria-label="Next track">${icon('next')}</button>
        </div>
        <p class="npf-vol-old" hidden></p>
        <div class="npf-vol" hidden>
          <button class="icon-btn npf-mute" data-np="mute" aria-label="Mute"></button>
          <input class="npf-vol-range" type="range" min="0" max="100" step="1" aria-label="Volume">
          <span class="npf-vol-val" aria-hidden="true"></span>
        </div>
      </div>
    </div>
    <div class="npf-flash" role="status" aria-live="polite"></div>`;
  el.addEventListener('click', onClick);
  const range = el.querySelector('.npf-vol-range');
  range.addEventListener('input', () => { showVolume(range.value / 100); sendVolume(range.value / 100); });
  range.addEventListener('change', () => sendVolume(range.value / 100, true));
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  return el;
}

function setText(sel, text) {
  const n = root.querySelector(sel);
  if (n.textContent !== text) n.textContent = text;
  n.hidden = !text;
}

/** A short message over the player (the phone remote has no app toasts). */
function flash(msg) {
  const n = root?.querySelector('.npf-flash');
  if (!n) return;
  n.textContent = msg;
  n.classList.add('show');
  clearTimeout(flashT);
  flashT = setTimeout(() => n.classList.remove('show'), 4000);
}

/* ---------- Buttons ---------- */
async function command(cmd) {
  const btn = root?.querySelector(`[data-cmd="${cmd}"]`);
  if (!btn || btn.disabled) return;
  try { await musicControl(cmd); } catch (err) { flash(err.message); }
}

function toggleOwnFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function onClick(e) {
  const btn = e.target.closest('[data-cmd], [data-np]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.cmd) return command(btn.dataset.cmd);
  const what = btn.dataset.np;
  if (what === 'close') closeNowPlaying();
  else if (what === 'fullscreen') toggleOwnFullscreen();
  else if (what === 'mute') {
    const v = nowPlaying()?.volume ?? 0;
    if (v > 0) volBeforeMute = v;
    const next = v > 0 ? 0 : volBeforeMute || 0.5;
    showVolume(next);
    sendVolume(next, true);
  }
}

/* ---------- Volume ---------- */
function showVolume(v) {
  if (!root) return;
  const pct = Math.round(v * 100);
  const range = root.querySelector('.npf-vol-range');
  if (document.activeElement !== range || Date.now() > volBusyUntil) range.value = pct;
  range.style.setProperty('--v', `${pct}%`);
  range.setAttribute('aria-valuetext', `${pct}%`);
  root.querySelector('.npf-vol-val').textContent = pct;
  const mute = root.querySelector('.npf-mute');
  const name = pct === 0 ? 'mute' : pct < 50 ? 'volume-low' : 'volume';
  if (mute.dataset.icon !== name) {
    mute.dataset.icon = name;
    mute.innerHTML = icon(name);
    mute.setAttribute('aria-label', pct === 0 ? 'Unmute' : 'Mute');
  }
}

// Send at most every 120 ms while dragging, and always the final value.
let volTimer = null;
let volPending = null;
let volSending = false;
function sendVolume(v, final = false) {
  volBusyUntil = Date.now() + 1500;
  volPending = v;
  if (final) clearTimeout(volTimer), (volTimer = null);
  if (volTimer || volSending) return;
  const send = async () => {
    volTimer = null;
    if (volPending == null) return;
    const val = volPending;
    volPending = null;
    volSending = true;
    try { await setMusicVolume(val); } catch (err) { flash(err.message); volPending = null; }
    volSending = false;
    volBusyUntil = Date.now() + 1500;
    if (volPending != null) volTimer = setTimeout(send, 120);
  };
  if (final) send(); else volTimer = setTimeout(send, 120);
}

function nudgeVolume(delta) {
  const s = nowPlaying();
  if (s?.volume == null) return;
  const v = Math.max(0, Math.min(1, Math.round((s.volume + delta) * 100) / 100));
  showVolume(v);
  sendVolume(v, true);
}

/* ---------- Progress, clock & state ---------- */
function updateClock() {
  const d = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const t = root.querySelector('.npf-clock-time'), dt = root.querySelector('.npf-clock-date');
  if (t.textContent !== time) t.textContent = time;
  if (dt.textContent !== date) dt.textContent = date;
}

function updateProgress() {
  if (!root) return;
  updateClock();
  const s = nowPlaying();
  const prog = root.querySelector('.npf-progress');
  const has = !!(s && s.status !== 'none' && s.length);
  prog.hidden = !has;
  if (!has) return;
  const pos = livePosition(s);
  root.querySelector('.npf-bar span').style.width = `${Math.min(100, (pos / s.length) * 100).toFixed(2)}%`;
  root.querySelector('.npf-pos').textContent = mmss(pos);
  root.querySelector('.npf-len').textContent = mmss(s.length);
}

/** Refresh from the latest music state (called whenever the helper reports a change). */
export function updateNowPlaying() {
  if (!root) return;
  const s = nowPlaying();
  const live = s && s.status !== 'none';
  const playing = live && s.status === 'playing';
  root.classList.toggle('playing', !!playing);
  root.classList.toggle('empty', !live);
  setText('.npf-label', live ? `${playing ? 'Now playing' : 'Paused'}${s.player ? ` · ${s.player}` : ''}` : '');
  setText('.npf-title', live ? s.title : (s ? 'Nothing playing' : musicError || 'Connecting…'));
  setText('.npf-artist', live ? s.artist : (s ? `Start something in your music app${remoteMode ? ' on your computer' : ''}.` : ''));
  setText('.npf-album', live && s.album && ![s.artist, s.title].includes(s.album) ? s.album : ''); // singles: album = title
  root.querySelector('.npf-title').title = live ? s.title : '';
  applyArt(live ? artUrl(s) : '');

  const ctl = root.querySelector('.npf-ctl');
  ctl.hidden = !live;
  if (live) {
    root.querySelector('.npf-prev').disabled = !s.canPrevious;
    root.querySelector('.npf-next').disabled = !s.canNext;
    const play = root.querySelector('.npf-play');
    play.disabled = !s.canPause;
    if (play.dataset.state !== String(playing)) {
      play.dataset.state = String(playing);
      play.innerHTML = icon(playing ? 'pause' : 'play');
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
  }
  const vol = root.querySelector('.npf-vol');
  vol.hidden = !(live && typeof s.volume === 'number');
  // helpers from before volume support don't send the field at all (null means "this player has none")
  setText('.npf-vol-old', live && !('volume' in s) ? 'Update the now-playing helper to control the volume here: run the setup command from Settings → Now playing again.' : '');
  if (!vol.hidden && Date.now() > volBusyUntil) showVolume(s.volume);
  updateProgress();
}

/* ---------- Keys & touch ---------- */
function onKey(e) {
  if (!root || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input')) return; // the volume slider handles its own arrow keys
  const press = (cmd) => { e.preventDefault(); command(cmd); };
  if (e.key === 'Escape' && !remoteMode) { e.preventDefault(); closeNowPlaying(); }
  else if (e.key === ' ' && !e.target.closest('button')) press('play-pause');
  else if (e.key === 'ArrowRight') press('next');
  else if (e.key === 'ArrowLeft') press('previous');
  else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeVolume(0.05); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeVolume(-0.05); }
  else if (e.key === 'm' || e.key === 'M') root.querySelector('.npf-vol:not([hidden]) .npf-mute')?.click();
}

// Phones: swipe left/right for next/previous, swipe down to close (in the app).
let touch = null;
function onTouchStart(e) {
  const t = e.touches[0];
  touch = e.touches.length === 1 && !e.target.closest('input, button') ? { x: t.clientX, y: t.clientY, at: Date.now(), top: root.scrollTop <= 0 } : null;
}
function onTouchEnd(e) {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
  const start = touch;
  const quick = Date.now() - start.at < 700;
  touch = null;
  if (!quick) return;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) command(dx < 0 ? 'next' : 'previous');
  else if (!remoteMode && start.top && dy > 90 && dy > Math.abs(dx) * 1.5) closeNowPlaying();
}

/* ---------- Open / close ---------- */
function onFullscreenChange() {
  // leaving browser full screen (e.g. Esc) also leaves the player, if the player is what entered it
  if (root && weFullscreened && !document.fullscreenElement) { weFullscreened = false; closeNowPlaying(); }
  const fs = root?.querySelector('[data-np="fullscreen"]');
  if (fs) fs.innerHTML = icon(document.fullscreenElement ? 'shrink' : 'expand');
}

/** `remote`: the phone remote page, where the player is the whole page and can't be closed. */
export function openNowPlaying({ remote = false } = {}) {
  if (root) return;
  remoteMode = remote;
  root = build();
  lastArt = null;
  document.body.appendChild(root);
  document.documentElement.classList.add('npf-open');
  updateNowPlaying();
  requestAnimationFrame(() => root?.classList.add('in'));
  tick = setInterval(updateProgress, 500);
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (!remote && !document.fullscreenElement && document.fullscreenEnabled) {
    document.documentElement.requestFullscreen?.().then(() => { weFullscreened = true; }).catch(() => {});
  }
  root.focus({ preventScroll: true });
}

export function closeNowPlaying() {
  if (!root || remoteMode) return;
  const el = root;
  root = null;
  clearInterval(tick);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.documentElement.classList.remove('npf-open');
  if (weFullscreened && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  weFullscreened = false;
  el.classList.remove('in');
  setTimeout(() => el.remove(), 350);
}
