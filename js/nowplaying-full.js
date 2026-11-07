// Full-screen "Now playing": big cover, title/artist, progress and controls over a soft,
// slowly drifting gradient made from the cover's own colours.
// It lives outside #view so dashboard re-renders don't rebuild it (no flicker, no restarted animations).
import { esc } from './util.js';
import { icon } from './icons.js';
import { nowPlaying, livePosition, artUrl, musicError } from './music.js';

let root = null;
let tick = null;
let weFullscreened = false;
let lastArt = null;
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
  el.className = 'npf';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Now playing');
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="npf-bg" aria-hidden="true">
      <div class="npf-blur"></div>
      <span class="npf-blob b1"></span><span class="npf-blob b2"></span><span class="npf-blob b3"></span><span class="npf-blob b4"></span>
      <div class="npf-grain"></div>
    </div>
    <button class="npf-close icon-btn" data-action="music-full-close" aria-label="Close full screen player" title="Close (Esc)">${icon('close')}</button>
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
          <button class="icon-btn npf-prev" data-action="music-cmd" data-cmd="previous" aria-label="Previous track">${icon('prev')}</button>
          <button class="icon-btn npf-play" data-action="music-cmd" data-cmd="play-pause" aria-label="Play"></button>
          <button class="icon-btn npf-next" data-action="music-cmd" data-cmd="next" aria-label="Next track">${icon('next')}</button>
        </div>
      </div>
    </div>`;
  return el;
}

function setText(sel, text) {
  const n = root.querySelector(sel);
  if (n.textContent !== text) n.textContent = text;
  n.hidden = !text;
}

function updateProgress() {
  if (!root) return;
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
  setText('.npf-artist', live ? s.artist : (s ? 'Start something in your music app.' : ''));
  setText('.npf-album', live && s.album && s.album !== s.artist ? s.album : '');
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
  updateProgress();
}

/* ---------- Open / close ---------- */
function onKey(e) {
  if (!root || e.ctrlKey || e.metaKey || e.altKey) return;
  const press = (cmd) => { e.preventDefault(); root.querySelector(`[data-cmd="${cmd}"]:not([disabled])`)?.click(); };
  if (e.key === 'Escape') { e.preventDefault(); closeNowPlaying(); }
  else if (e.key === ' ' && !e.target.closest('button')) press('play-pause');
  else if (e.key === 'ArrowRight') press('next');
  else if (e.key === 'ArrowLeft') press('previous');
}

function onFullscreenChange() {
  // leaving browser full screen (e.g. Esc) also leaves the player, if the player is what entered it
  if (root && weFullscreened && !document.fullscreenElement) { weFullscreened = false; closeNowPlaying(); }
}

export function openNowPlaying() {
  if (root) return;
  root = build();
  lastArt = null;
  document.body.appendChild(root);
  document.documentElement.classList.add('npf-open');
  updateNowPlaying();
  requestAnimationFrame(() => root?.classList.add('in'));
  tick = setInterval(updateProgress, 500);
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (!document.fullscreenElement && document.fullscreenEnabled) {
    document.documentElement.requestFullscreen?.().then(() => { weFullscreened = true; }).catch(() => {});
  }
  root.focus({ preventScroll: true });
}

export function closeNowPlaying() {
  if (!root) return;
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
