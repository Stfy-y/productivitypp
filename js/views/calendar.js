import { esc } from '../util.js';
import { icon } from '../icons.js';
import {
  today, addDays, addMonths, diffDays, startOfWeek, startOfMonth, parseYmd, fmtDay, fmtTime, WD_SHORT, MONTHS,
} from '../dates.js';
import { tasks, sortTasks, quadrant, QUADS, settings, habits, habitCount, isScheduled } from '../store.js';
import { taskRow, eventRow, eventAttrs } from '../ui.js';
import { ensureRange } from '../gcal.js';
import { allEventsOn as eventsOn } from '../events.js';
import { renderTimeGrid, renderTimeRows, toMin, fromMin, fmtDur, DEFAULT_DURATION } from './timegrid.js';

/** Week mode: 7 days from week start on wide screens, 3 days from the cursor on phones. */
function span() {
  const n = matchMedia('(max-width: 699px)').matches ? 3 : 7;
  return { n, start: n === 7 ? startOfWeek(state.cursor, settings.weekStart) : state.cursor };
}

const AXIS_V = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>';
const AXIS_H = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.33h18M3 14.67h18"/></svg>';

const state = {
  mode: localStorage.getItem('ppp-cal-mode') || 'month',
  axis: localStorage.getItem('ppp-week-axis') || 'vertical', // week view: days as columns (vertical) or rows (horizontal)
  cursor: today(),
  selected: today(),
};

export function calAction(action, el) {
  if (action === 'cal-mode') { state.mode = el.dataset.mode; localStorage.setItem('ppp-cal-mode', state.mode); }
  if (action === 'cal-axis') { state.axis = el.dataset.axis; localStorage.setItem('ppp-week-axis', state.axis); }
  const step = (dir) => {
    if (state.mode === 'month') return addMonths(startOfMonth(state.cursor), dir);
    if (state.mode === 'day') return addDays(state.cursor, dir);
    return addDays(span().start, dir * span().n);
  };
  if (action === 'cal-prev') state.cursor = step(-1);
  if (action === 'cal-next') state.cursor = step(1);
  if (action === 'cal-day') state.cursor = state.selected = el.dataset.date;
  if (action === 'cal-today') state.cursor = state.selected = today();
  if (action === 'cal-select') {
    state.selected = el.dataset.date;
    if (state.mode === 'month' && state.selected.slice(0, 7) !== state.cursor.slice(0, 7)) state.cursor = state.selected;
  }
}
export const calSelected = () => state.selected;

/** Phones: swipe left/right to step through 3-day pages (week mode) and agenda days. */
export function enableCalSwipe(root, rerender) {
  let st = null;
  root.addEventListener('touchstart', (e) => {
    st = null;
    if (e.touches.length !== 1 || root.dataset.view !== 'calendar') return;
    if (!matchMedia('(max-width: 699px)').matches || (state.mode !== 'week' && state.mode !== 'day')) return;
    // horizontal week layout scrolls sideways itself; the resize handle owns its gesture
    if (e.target.closest('.th, .tb-resize, input, textarea, select')) return;
    const t = e.touches[0];
    st = { x: t.clientX, y: t.clientY, at: Date.now(), moved: 0 };
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!st || st.moved) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - st.x, t.clientY - st.y) > 8) st.moved = Date.now();
  }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (!st) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - st.x, dy = t.clientY - st.y;
    const quick = Date.now() - st.at < 700;
    const held = !st.moved || st.moved - st.at > 300; // finger rested first = long-press drag, not a swipe
    st = null;
    if (!quick || held || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const dir = dx < 0 ? 1 : -1;
    if (state.mode === 'day') state.cursor = state.selected = addDays(state.cursor, dir);
    else state.cursor = addDays(span().start, dir * span().n);
    rerender();
    const el = root.querySelector('.tb, .agenda-static');
    if (el) el.classList.add(dir > 0 ? 'swipe-next' : 'swipe-prev');
  }, { passive: true });
  root.addEventListener('touchcancel', () => { st = null; }, { passive: true });
}

function byDate() {
  const map = new Map();
  for (const t of tasks()) {
    if (!t.date) continue;
    if (!map.has(t.date)) map.set(t.date, []);
    map.get(t.date).push(t);
  }
  for (const l of map.values()) sortTasks(l).sort((a, b) => a.done - b.done);
  return map;
}

function habitRing(d) {
  if (d > today()) return '';
  const hs = habits().filter((h) => !h.archived && isScheduled(h, d) && h.createdAt <= parseYmd(d).getTime() + 864e5);
  if (!hs.length) return '';
  const done = hs.filter((h) => habitCount(h, d) >= (h.goal || 1)).length;
  if (!done) return '';
  return `<span class="hring" style="--p:${Math.round((done / hs.length) * 100)}" title="${done}/${hs.length} habits"></span>`;
}

export function renderCalendar() {
  const map = byDate();
  const t = today();
  const ws = settings.weekStart;
  const title = state.mode === 'month'
    ? `${MONTHS[parseYmd(state.cursor).getMonth()]} ${parseYmd(state.cursor).getFullYear()}`
    : state.mode === 'day'
      ? parseYmd(state.cursor).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
      : (() => { const { n, start: s } = span(); const e = addDays(s, n - 1); return `${parseYmd(s).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${parseYmd(e).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`; })();

  let html = `<div class="cal-toolbar">
    <div class="cal-nav">
      <button class="icon-btn" data-action="cal-prev" aria-label="Previous">${icon('left')}</button>
      <h2>${title}</h2>
      <button class="icon-btn" data-action="cal-next" aria-label="Next">${icon('right')}</button>
    </div>
    <div class="cal-right">
      ${state.mode === 'week' ? `<div class="seg small axis-toggle" title="Week layout">
        <button data-action="cal-axis" data-axis="vertical" class="${state.axis !== 'horizontal' ? 'on' : ''}" aria-label="Days as columns" title="Days as columns">${AXIS_V}</button>
        <button data-action="cal-axis" data-axis="horizontal" class="${state.axis === 'horizontal' ? 'on' : ''}" aria-label="Days as rows" title="Days as rows">${AXIS_H}</button>
      </div>` : ''}
      <button class="btn small ghost" data-action="cal-today">Today</button>
      <div class="seg small">
        <button data-action="cal-mode" data-mode="month" class="${state.mode === 'month' ? 'on' : ''}">Month</button>
        <button data-action="cal-mode" data-mode="week" class="${state.mode === 'week' ? 'on' : ''}">${matchMedia('(max-width: 699px)').matches ? '3 Days' : 'Week'}</button>
        <button data-action="cal-mode" data-mode="day" class="${state.mode === 'day' ? 'on' : ''}">Agenda</button>
      </div>
    </div>
  </div>`;

  const order = [...Array(7)].map((_, i) => (ws + i) % 7);
  if (state.mode === 'month') {
    const first = startOfMonth(state.cursor);
    const gridStart = startOfWeek(first, ws);
    const month = first.slice(0, 7);
    const fd = parseYmd(first);
    const daysInMonth = new Date(fd.getFullYear(), fd.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((diffDays(gridStart, first) + daysInMonth) / 7);
    ensureRange(gridStart, addDays(gridStart, weeks * 7 - 1));
    html += `<div class="cal-layout"><div class="month">
      <div class="month-head">${order.map((d) => `<div>${WD_SHORT[d]}</div>`).join('')}</div>
      <div class="month-grid" style="--weeks:${weeks}">`;
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(gridStart, i);
      const list = map.get(d) || [];
      const evs = eventsOn(d);
      const cls = [d.slice(0, 7) !== month && 'out', d === t && 'today', d === state.selected && 'sel'].filter(Boolean).join(' ');
      const pills = [
        ...evs.map((e) => `<div class="pill ev" ${eventAttrs(e)} ${e.local ? `data-drag-id="ev:${esc(e.id)}@${esc(e.occ)}"` : ''} style="--ec:${esc(e.color)}">${e.time ? `<b>${esc(fmtTime(e.time))}</b> ` : ''}${e.repeating ? '↻ ' : ''}${esc(e.title)}</div>`),
        ...list.map((x) => `<div class="pill q${quadrant(x)} ${x.done ? 'is-done' : ''}" data-drag-id="${x.id}">${x.time ? `<b>${esc(fmtTime(x.time))}</b> ` : ''}${esc(x.title)}</div>`),
      ];
      html += `<div class="day ${cls}" data-action="cal-select" data-date="${d}" data-drop="date:${d}">
        <div class="day-num"><span>${parseYmd(d).getDate()}</span>${habitRing(d)}</div>
        <div class="pills">${pills.slice(0, 3).join('')}${pills.length > 3 ? `<div class="more">+${pills.length - 3} more</div>` : ''}</div>
        <div class="dots">${evs.slice(0, 2).map((e) => `<i class="dot ev" style="--ec:${esc(e.color)}"></i>`).join('')}${list.slice(0, 4 - Math.min(2, evs.length)).map((x) => `<i class="dot q${quadrant(x)} ${x.done ? 'is-done' : ''}"></i>`).join('')}</div>
      </div>`;
    }
    html += `</div></div>${agenda(map)}</div>`;
  } else if (state.mode === 'day') {
    html += renderAgendaDay(map);
  } else {
    const { n, start } = span();
    ensureRange(start, addDays(start, n - 1));
    html += state.axis === 'horizontal' ? renderTimeRows(start, n, map) : renderTimeGrid(start, n, map);
  }
  return html;
}

function agenda(map) {
  const d = state.selected;
  const list = map.get(d) || [];
  return `<aside class="agenda" data-drop="date:${d}">
    <div class="agenda-head"><h3>${esc(fmtDay(d, { long: true }))}</h3>
      <button class="btn small primary" data-action="quick-add" data-date="${d}">${icon('plus')} Add</button></div>
    <div class="task-list">${eventsOn(d).map(eventRow).join('')}${list.map((x) => taskRow(x, { showDate: false })).join('') || (eventsOn(d).length ? '' : '<div class="faint pad">Nothing this day.</div>')}</div>
  </aside>`;
}

/* ---------- Agenda: static, read-only schedule for one day ---------- */
// Fixed-size blocks in time order, spanning only from the first start to the last end.
function renderAgendaDay(map) {
  const d = state.cursor;
  const t = today();
  const ws = startOfWeek(d, settings.weekStart);
  ensureRange(ws, addDays(ws, 6));
  const strip = [...Array(7)].map((_, i) => {
    const x = addDays(ws, i);
    const n = (map.get(x) || []).filter((k) => k.time && !k.done).length + eventsOn(x).length;
    return `<button class="ds-day ${x === d ? 'sel' : ''} ${x === t ? 'today' : ''}" data-action="cal-day" data-date="${x}">
      <small>${WD_SHORT[parseYmd(x).getDay()]}</small><b>${parseYmd(x).getDate()}</b><i class="ds-dot ${n ? 'on' : ''}"></i></button>`;
  }).join('');

  // Collect timed items
  const items = [];
  const allDay = [];
  for (const e of eventsOn(d)) {
    if (e.allDay) { allDay.push(e); continue; }
    const s = e.time ? toMin(e.time) : 0;
    const en = e.endTime ? toMin(e.endTime) : 1440;
    items.push({ kind: 'event', title: (e.repeating ? '↻ ' : '') + e.title, s, e: Math.max(en, s), color: e.color, sub: [e.calName, e.location].filter(Boolean).join(' · ') });
  }
  for (const k of map.get(d) || []) {
    if (!k.time) continue;
    const s = toMin(k.time);
    items.push({ kind: 'task', title: k.title, s, e: Math.min(1440, s + (Number(k.duration) || DEFAULT_DURATION)), q: quadrant(k), done: k.done, sub: QUADS[quadrant(k)].hint });
  }
  items.sort((a, b) => a.s - b.s || a.e - b.e);
  for (const it of items) it.clash = items.filter((o) => o !== it && o.s < it.e && it.s < o.e).map((o) => o.title);

  const clock = (m) => fmtTime(fromMin(Math.min(m, 1439)));
  let rows = '';
  let maxEnd = -1;
  let free = 0;
  items.forEach((it, i) => {
    if (i > 0 && it.s - maxEnd >= 15) {
      free += it.s - maxEnd;
      rows += `<div class="ag-gap"><span>Free · ${fmtDur(it.s - maxEnd)}</span></div>`;
    }
    maxEnd = Math.max(maxEnd, it.e);
    const dur = it.e - it.s;
    rows += `<div class="ag-row">
      <div class="ag-time">${esc(clock(it.s))}</div>
      <div class="ag-rail"><i class="ag-dot ${it.kind === 'task' ? `q${it.q}` : ''}" ${it.kind === 'event' ? `style="--c:${esc(it.color)}"` : ''}></i></div>
      <div class="ag-block ${it.kind} ${it.kind === 'task' ? `q${it.q}` : ''} ${it.done ? 'is-done' : ''} ${it.clash.length ? 'clash' : ''}" ${it.kind === 'event' ? `style="--c:${esc(it.color)}"` : ''}>
        <div class="ag-main">
          <div class="ag-title">${it.kind === 'task' ? `<span class="ag-kind">${it.done ? '✓' : '○'}</span>` : ''}${esc(it.title)}</div>
          <div class="ag-sub">${esc(clock(it.s))} – ${esc(clock(it.e))}${it.sub ? ` · ${esc(it.sub)}` : ''}${it.clash.length ? ` · <span class="ag-warn">⚠ overlaps ${esc(it.clash.join(', '))}</span>` : ''}</div>
        </div>
        <div class="ag-dur">${fmtDur(dur)}</div>
      </div>
    </div>`;
  });

  let body;
  if (!items.length) {
    body = `<div class="empty"><div class="empty-art">${icon('calendar')}</div><p>Nothing scheduled ${d === t ? 'today' : 'this day'}.</p></div>`;
  } else {
    const first = items[0].s;
    const busy = maxEnd - first - free;
    body = `<div class="ag-summary">${esc(clock(first))} – ${esc(clock(maxEnd))} · ${items.length} item${items.length === 1 ? '' : 's'} · ${fmtDur(busy)} busy${free ? ` · <span class="free-sum">${fmtDur(free)} free</span>` : ''}</div>
      <div class="ag-list">${rows}
        <div class="ag-row ag-end"><div class="ag-time">${esc(clock(maxEnd))}</div><div class="ag-rail"><i class="ag-dot end"></i></div><div class="ag-endlabel">Done for the day</div></div>
      </div>`;
  }

  return `<div class="date-strip agenda-strip">
      <button class="icon-btn small" data-action="cal-day" data-date="${addDays(ws, -7)}" aria-label="Previous week">${icon('left')}</button>
      ${strip}
      <button class="icon-btn small" data-action="cal-day" data-date="${addDays(ws, 7)}" aria-label="Next week">${icon('right')}</button>
    </div>
    <div class="agenda-static">
      ${allDay.length ? `<div class="ag-allday"><span class="ag-allday-label">All day</span>${allDay.map((e) => `<span class="ag-chip" style="--c:${esc(e.color)}">${esc(e.title)}</span>`).join('')}</div>` : ''}
      ${body}
    </div>`;
}
