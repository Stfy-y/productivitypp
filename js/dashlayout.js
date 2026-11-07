// Dashboard layout: which panels show, in which column and in what order, plus the edit mode that changes it.
// Saved per device in settings.dashLayout; null = the default:
//   { cols: [[ids], [ids], [ids]], hidden: [ids], sizes: { id: px height }, widths: [fr, fr, fr] }
// A panel without a size takes its natural height (the flexible ones share what's left in the column).
import { settings, saveSettings } from './store.js';
import { suppressNextClick } from './drag.js';

export const PANELS = {
  hero: { title: 'Clock & day', icon: 'clock' },
  exams: { title: 'Exams', icon: 'exam' },
  agenda: { title: 'Today\'s agenda', icon: 'calendar' },
  nownext: { title: 'Now & next', icon: 'clock' },
  music: { title: 'Now playing', icon: 'music' },
  tasks: { title: 'Tasks', icon: 'today' },
  habits: { title: 'Habits', icon: 'habits' },
  weather: { title: 'Weather', icon: 'sun' },
  whatsapp: { title: 'WhatsApp', icon: 'chat' },
  tomorrow: { title: 'Tomorrow', icon: 'week' },
};
const DEFAULT_COLS = [['hero', 'exams', 'agenda'], ['nownext', 'music', 'tasks', 'habits'], ['weather', 'whatsapp', 'tomorrow']];
export const COLS = DEFAULT_COLS.length;
const DEFAULT_WIDTHS = [1.2, 1, 1];
export const MIN_H = 80;
export const MAX_H = 1600;

/** The layout to draw: the saved one, cleaned up, with panels added since it was saved put in their default column. */
export function layout() {
  const saved = settings.dashLayout;
  if (!saved?.cols) return { cols: DEFAULT_COLS.map((c) => [...c]), hidden: [], sizes: {}, widths: [...DEFAULT_WIDTHS], custom: false };
  const seen = new Set();
  const keep = (id) => PANELS[id] && !seen.has(id) && seen.add(id);
  const cols = Array.from({ length: COLS }, (_, i) => (saved.cols[i] || []).filter(keep));
  const hidden = (saved.hidden || []).filter(keep);
  DEFAULT_COLS.forEach((c, i) => c.forEach((id) => { if (!seen.has(id)) cols[i].push(id); }));
  const sizes = {};
  for (const [id, h] of Object.entries(saved.sizes || {})) if (PANELS[id] && h >= MIN_H) sizes[id] = Math.min(MAX_H, Math.round(h));
  const w = saved.widths;
  const widths = Array.isArray(w) && w.length === COLS && w.every((x) => x > 0.1 && x < 10) ? w : [...DEFAULT_WIDTHS];
  return { cols, hidden, sizes, widths, custom: true };
}

/** Save a change; whatever isn't in `patch` stays as it is. */
function save(cols, hidden, patch = {}) {
  const { sizes, widths } = layout();
  saveSettings({ dashLayout: { cols, hidden, sizes, widths, ...patch } });
}
const update = (patch) => { const { cols, hidden } = layout(); save(cols, hidden, patch); };

/** Fixed height for a panel (px), or null for its natural height. */
export function setPanelSize(id, h) {
  const sizes = { ...layout().sizes };
  if (h == null) delete sizes[id];
  else sizes[id] = Math.max(MIN_H, Math.min(MAX_H, Math.round(h / 10) * 10));
  update({ sizes });
}
export const setColWidths = (widths) => update({ widths: widths.map((x) => Math.round(x * 100) / 100) });
const defaultCol = (id) => Math.max(0, DEFAULT_COLS.findIndex((c) => c.includes(id)));

export function removePanel(id) {
  const { cols, hidden } = layout();
  save(cols.map((c) => c.filter((x) => x !== id)), [...hidden.filter((x) => x !== id), id]);
}

export function addPanel(id) {
  const { cols, hidden } = layout();
  cols[defaultCol(id)].push(id);
  save(cols, hidden.filter((x) => x !== id));
}

/** Arrow buttons: up/down inside the column, left/right to the same spot in the next column. */
export function movePanel(id, dir) {
  const { cols, hidden } = layout();
  const ci = cols.findIndex((c) => c.includes(id));
  if (ci < 0) return;
  const col = cols[ci];
  const i = col.indexOf(id);
  if (dir === 'up' || dir === 'down') {
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= col.length) return;
    [col[i], col[j]] = [col[j], col[i]];
  } else {
    const cj = dir === 'left' ? ci - 1 : ci + 1;
    if (cj < 0 || cj >= COLS) return;
    col.splice(i, 1);
    cols[cj].splice(Math.min(i, cols[cj].length), 0, id);
  }
  save(cols, hidden);
}

export const resetLayout = () => saveSettings({ dashLayout: null });

/* ---------- Edit mode ---------- */
let editing = false;
let dragging = false;
export const isEditing = () => editing;
/** A panel is being dragged: the app holds re-renders until it's dropped (onChange redraws then). */
export const isDraggingPanel = () => dragging;
export function setEditing(on) { editing = !!on; }

/** Drag panels between and within columns while editing. Mouse: grab anywhere on a panel.
 * Touch: grab the handle (the rest of the panel scrolls the page as usual). */
export function enableDashEdit(root, onChange) {
  root.addEventListener('dblclick', (e) => {
    const grip = editing && e.target.closest('[data-resize-panel]');
    if (!grip) return;
    setPanelSize(grip.dataset.resizePanel, null);
    onChange();
  });
  root.addEventListener('pointerdown', (e) => {
    if (!editing || e.button > 0) return;
    if (e.target.closest('[data-resize-panel]')) { resizePanel(e, onChange); return; }
    if (e.target.closest('[data-resize-col]')) { resizeColumn(e, root, onChange); return; }
    const panel = e.target.closest('[data-panel]');
    if (!panel || e.target.closest('button, a, input, select')) return;
    const touch = e.pointerType !== 'mouse';
    if (touch && !e.target.closest('[data-dash-handle]')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let started = false, ghost = null, ph = null, last = e, raf = 0;
    const scroller = document.getElementById('main');

    const start = () => {
      started = dragging = true;
      const r = panel.getBoundingClientRect();
      ghost = panel.cloneNode(true);
      ghost.classList.add('dash-ghost');
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${Math.min(r.height, 320)}px` });
      ghost._ox = sx - r.left; ghost._oy = sy - r.top;
      document.body.appendChild(ghost);
      ph = document.createElement('div');
      ph.className = 'dash-ph';
      ph.style.height = `${Math.min(r.height, 220)}px`;
      panel.after(ph);
      panel.classList.add('dash-dragging');
      document.body.classList.add('is-dragging');
      navigator.vibrate?.(15);
      place(last);
      raf = requestAnimationFrame(autoScroll);
    };

    /** Put the placeholder where the pointer is: the nearest column, before the first panel below the pointer. */
    const place = (ev) => {
      ghost.style.transform = `translate(${ev.clientX - ghost._ox}px, ${ev.clientY - ghost._oy}px) rotate(1deg)`;
      let best = null, bestD = Infinity;
      for (const col of root.querySelectorAll('[data-col]')) {
        const r = col.getBoundingClientRect();
        const dx = ev.clientX < r.left ? r.left - ev.clientX : ev.clientX > r.right ? ev.clientX - r.right : 0;
        const dy = ev.clientY < r.top ? r.top - ev.clientY : ev.clientY > r.bottom ? ev.clientY - r.bottom : 0;
        const d = dx * 4 + dy; // stay in the column under the pointer even when below its last panel
        if (d < bestD) { bestD = d; best = col; }
      }
      if (!best) return;
      const before = [...best.querySelectorAll(':scope > [data-panel]')].find((p) => {
        if (p === panel) return false;
        const r = p.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      const anchor = before || best.querySelector(':scope > .dash-drop-end');
      if (ph.nextSibling !== anchor) anchor.before(ph);
    };

    const autoScroll = () => {
      if (!started) return;
      const edge = 70;
      const v = last.clientY < edge ? -(edge - last.clientY) / 4 : last.clientY > innerHeight - edge ? (last.clientY - (innerHeight - edge)) / 4 : 0;
      if (v && scroller) { scroller.scrollTop += v; place(last); }
      raf = requestAnimationFrame(autoScroll);
    };

    const move = (ev) => {
      last = ev;
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > (touch ? 2 : 6)) start();
        return;
      }
      ev.preventDefault();
      place(ev);
    };

    const end = (ev) => {
      if (started) {
        suppressNextClick();
        if (ev.type === 'pointerup') {
          ph.replaceWith(panel);
          const cols = [...root.querySelectorAll('[data-col]')].map((c) => [...c.querySelectorAll(':scope > [data-panel]')].map((p) => p.dataset.panel));
          save(cols, layout().hidden);
        }
      }
      cleanup();
      if (started) onChange();
    };

    function cleanup() {
      dragging = false;
      cancelAnimationFrame(raf);
      ghost?.remove();
      ph?.remove();
      panel.classList.remove('dash-dragging');
      document.body.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

/* ---------- Resizing (edit mode) ---------- */
/** Follow the pointer until it's released; `step(ev)` on every move, `done(ev)` at the end. */
function track(e, cursor, step, done) {
  e.preventDefault();
  dragging = true;
  document.body.classList.add('is-resizing');
  document.body.style.cursor = cursor;
  const move = (ev) => { ev.preventDefault(); step(ev); };
  const end = (ev) => {
    dragging = false;
    document.body.classList.remove('is-resizing');
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    suppressNextClick();
    done(ev);
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/** Drag a panel's bottom edge: its card gets that height (snapped to 10 px). */
function resizePanel(e, onChange) {
  const grip = e.target.closest('[data-resize-panel]');
  const id = grip.dataset.resizePanel;
  const card = grip.closest('[data-panel]')?.querySelector(':scope > .card');
  if (!card) return;
  const startH = card.getBoundingClientRect().height;
  const sy = e.clientY;
  const label = grip.querySelector('[data-size-label]');
  let h = startH;
  track(e, 'ns-resize', (ev) => {
    h = Math.max(MIN_H, Math.min(MAX_H, Math.round((startH + ev.clientY - sy) / 10) * 10));
    card.style.setProperty('--ph', `${h}px`);
    card.dataset.size = h;
    if (label) label.textContent = `${h} px`;
  }, (ev) => {
    if (h === startH) return; // a plain click (or the first half of a double-click): nothing changed
    if (ev.type === 'pointerup') setPanelSize(id, h);
    onChange();
  });
}

/** Drag the divider after column i: the two columns beside it trade width (each keeps at least 20%). */
function resizeColumn(e, root, onChange) {
  const i = +e.target.closest('[data-resize-col]').dataset.resizeCol;
  const dash = root.querySelector('.dash');
  const cols = [...root.querySelectorAll('[data-col]')];
  if (!dash || !cols[i + 1]) return;
  const widths = [...layout().widths];
  const pair = widths[i] + widths[i + 1];
  const a = cols[i].getBoundingClientRect(), b = cols[i + 1].getBoundingClientRect();
  const gap = b.left - a.right;
  const span = b.right - a.left - gap;
  let moved = false;
  track(e, 'col-resize', (ev) => {
    moved = true;
    const f = Math.max(0.2, Math.min(0.8, (ev.clientX - a.left - gap / 2) / span));
    widths[i] = pair * f;
    widths[i + 1] = pair - widths[i];
    widths.forEach((w, k) => dash.style.setProperty(`--c${k + 1}`, `${w}fr`));
  }, (ev) => {
    if (!moved) return;
    if (ev.type === 'pointerup') setColWidths(widths);
    onChange();
  });
}
