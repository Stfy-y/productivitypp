// Tiny pointer-based drag & drop that works with mouse and touch (long-press on touch).
// Draggables: [data-drag-id]. Drop targets: [data-drop="kind:value"].
let suppressClick = false;
/** Swallow the click that follows a drag/resize gesture. */
export function suppressNextClick() {
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 300);
}
/** For time-grid columns: minutes since midnight at a y position, snapped to 15 min. */
export function slotMinutesAt(col, y, x) {
  const r = col.getBoundingClientRect();
  const frac = col.dataset.axis === 'x' ? (x - r.left) / r.width : (y - r.top) / r.height;
  const m = Math.round((frac * 1440) / 15) * 15;
  return Math.max(0, Math.min(1440 - 15, m));
}
document.addEventListener('click', (e) => {
  if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
}, true);

let dragging = false;
document.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('[data-drag-id]') && (dragging || e.pointerType !== 'mouse')) e.preventDefault(); });

export function enableDrag(root, onDrop) {
  root.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('[data-drag-id]');
    if (!item || e.button > 0 || e.target.closest('button, input, select, textarea, a, .tb-resize')) return;
    const touch = e.pointerType !== 'mouse';
    const sx = e.clientX, sy = e.clientY;
    let last = e, started = false, ghost = null, over = null, lp = null;

    const position = (ev) => {
      ghost.style.transform = `translate(${ev.clientX - ghost._ox}px, ${ev.clientY - ghost._oy}px) rotate(1.5deg)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
      if (hit !== over) { over?.classList.remove('drop-over'); over = hit; over?.classList.add('drop-over'); }
      if (over?.dataset.drop.startsWith('slot:')) {
        const m = slotMinutesAt(over, ev.clientY - ghost._oy, ev.clientX - ghost._ox);
        ghost.dataset.time = new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } else delete ghost.dataset.time;
    };
    const start = () => {
      started = dragging = true;
      const r = item.getBoundingClientRect();
      ghost = item.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = r.width + 'px';
      ghost.style.top = '0'; ghost.style.left = '0'; ghost.style.height = r.height + 'px';
      ghost._ox = sx - r.left; ghost._oy = sy - r.top;
      document.body.appendChild(ghost);
      item.classList.add('dragging');
      document.body.classList.add('is-dragging');
      navigator.vibrate?.(15);
      position(last);
    };
    const move = (ev) => {
      last = ev;
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) { if (touch) cleanup(); else start(); }
        return;
      }
      ev.preventDefault();
      position(ev);
    };
    const end = (ev) => {
      if (started) {
        suppressNextClick();
        const target = over?.dataset.drop;
        if (target && ev.type === 'pointerup') {
          const i = target.indexOf(':');
          onDrop(item.dataset.dragId, target.slice(0, i), target.slice(i + 1), { el: over, top: ev.clientY - ghost._oy, left: ev.clientX - ghost._ox });
        }
      }
      cleanup();
    };
    function cleanup() {
      clearTimeout(lp);
      dragging = false;
      ghost?.remove();
      over?.classList.remove('drop-over');
      item.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    }
    if (touch) lp = setTimeout(start, 380);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}
