import { esc } from '../util.js';
import { icon } from '../icons.js';
import {
  today, addDays, addMonths, diffDays, startOfWeek, startOfMonth, parseYmd, fmtDay, fmtTime, WD_SHORT, MONTHS,
} from '../dates.js';
import { tasks, sortTasks, quadrant, settings, habits, habitCount, isScheduled } from '../store.js';
import { taskRow, eventRow } from '../ui.js';
import { eventsOn, ensureRange } from '../gcal.js';

const state = {
  mode: localStorage.getItem('ppp-cal-mode') || 'month',
  cursor: today(),
  selected: today(),
};

export function calAction(action, el) {
  if (action === 'cal-mode') { state.mode = el.dataset.mode; localStorage.setItem('ppp-cal-mode', state.mode); }
  if (action === 'cal-prev') state.cursor = state.mode === 'month' ? addMonths(startOfMonth(state.cursor), -1) : addDays(state.cursor, -7);
  if (action === 'cal-next') state.cursor = state.mode === 'month' ? addMonths(startOfMonth(state.cursor), 1) : addDays(state.cursor, 7);
  if (action === 'cal-today') state.cursor = state.selected = today();
  if (action === 'cal-select') {
    state.selected = el.dataset.date;
    if (state.mode === 'month' && state.selected.slice(0, 7) !== state.cursor.slice(0, 7)) state.cursor = state.selected;
  }
}
export const calSelected = () => state.selected;

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
    : (() => { const s = startOfWeek(state.cursor, ws); const e = addDays(s, 6); return `${parseYmd(s).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${parseYmd(e).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`; })();

  let html = `<div class="cal-toolbar">
    <div class="cal-nav">
      <button class="icon-btn" data-action="cal-prev" aria-label="Previous">${icon('left')}</button>
      <h2>${title}</h2>
      <button class="icon-btn" data-action="cal-next" aria-label="Next">${icon('right')}</button>
    </div>
    <div class="cal-right">
      <button class="btn small ghost" data-action="cal-today">Today</button>
      <div class="seg small">
        <button data-action="cal-mode" data-mode="month" class="${state.mode === 'month' ? 'on' : ''}">Month</button>
        <button data-action="cal-mode" data-mode="week" class="${state.mode === 'week' ? 'on' : ''}">Week</button>
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
        ...evs.map((e) => `<div class="pill ev" style="--ec:${esc(e.color)}">${e.time ? `<b>${esc(fmtTime(e.time))}</b> ` : ''}${esc(e.title)}</div>`),
        ...list.map((x) => `<div class="pill q${quadrant(x)} ${x.done ? 'is-done' : ''}" data-drag-id="${x.id}">${x.time ? `<b>${esc(fmtTime(x.time))}</b> ` : ''}${esc(x.title)}</div>`),
      ];
      html += `<div class="day ${cls}" data-action="cal-select" data-date="${d}" data-drop="date:${d}">
        <div class="day-num"><span>${parseYmd(d).getDate()}</span>${habitRing(d)}</div>
        <div class="pills">${pills.slice(0, 3).join('')}${pills.length > 3 ? `<div class="more">+${pills.length - 3} more</div>` : ''}</div>
        <div class="dots">${evs.slice(0, 2).map((e) => `<i class="dot ev" style="--ec:${esc(e.color)}"></i>`).join('')}${list.slice(0, 4 - Math.min(2, evs.length)).map((x) => `<i class="dot q${quadrant(x)} ${x.done ? 'is-done' : ''}"></i>`).join('')}</div>
      </div>`;
    }
    html += `</div></div>${agenda(map)}</div>`;
  } else {
    const s = startOfWeek(state.cursor, ws);
    ensureRange(s, addDays(s, 6));
    html += `<div class="week-grid">`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(s, i);
      const list = map.get(d) || [];
      html += `<div class="week-col ${d === t ? 'today' : ''}" data-drop="date:${d}">
        <div class="week-col-head"><span>${WD_SHORT[parseYmd(d).getDay()]}</span><b>${parseYmd(d).getDate()}</b>
          <button class="icon-btn small" data-action="quick-add" data-date="${d}" aria-label="Add task on ${d}">${icon('plus')}</button></div>
        <div class="task-list">${eventsOn(d).map(eventRow).join('')}${list.map((x) => taskRow(x, { showDate: false })).join('') || (eventsOn(d).length ? '' : '<div class="faint">No tasks</div>')}</div>
      </div>`;
    }
    html += `</div>`;
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
