// Dashboard layout: which panels show, in which column and in what order, plus the edit mode that changes it.
// Saved per device in settings.dashLayout ({ cols: [[ids], [ids], [ids]], hidden: [ids] }); null = the default.
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

/** The layout to draw: the saved one, cleaned up, with panels added since it was saved put in their default column. */
export function layout() {
  const saved = settings.dashLayout;
  if (!saved?.cols) return { cols: DEFAULT_COLS.map((c) => [...c]), hidden: [], custom: false };
  const seen = new Set();
  const keep = (id) => PANELS[id] && !seen.has(id) && seen.add(id);
  const cols = Array.from({ length: COLS }, (_, i) => (saved.cols[i] || []).filter(keep));
  const hidden = (saved.hidden || []).filter(keep);
  DEFAULT_COLS.forEach((c, i) => c.forEach((id) => { if (!seen.has(id)) cols[i].push(id); }));
  return { cols, hidden, custom: true };
}

const save = (cols, hidden) => saveSettings({ dashLayout: { cols, hidden } });
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
  root.addEventListener('pointerdown', (e) => {
    if (!editing || e.button > 0) return;
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
