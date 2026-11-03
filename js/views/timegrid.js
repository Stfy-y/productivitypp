// Time-blocking week grid: hours × days, overlap layout, free-time gaps, drag/resize tasks.
import { esc } from '../util.js';
import { today, addDays, parseYmd, fmtTime, WD_SHORT, pad } from '../dates.js';
import { quadrant, settings, getTask, updateTask, getEvent, updateEvent } from '../store.js';
import { allEventsOn } from '../events.js';
import { suppressNextClick } from '../drag.js';
import { eventAttrs } from '../ui.js';

export const HOUR_PX = 48;
const PX_MIN = HOUR_PX / 60;
const MIN_FREE = 30; // smallest gap worth showing as "free"
export const DEFAULT_DURATION = 30;

export const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const dayBounds = () => {
  const s = toMin(settings.dayStart || '08:00');
  const e = toMin(settings.dayEnd || '22:00');
  return e > s ? [s, e] : [480, 1320];
};

/** Side-by-side layout for overlapping items. Mutates items: col, cols, overlap. Returns # of overlapping pairs. */
function layout(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let pairs = 0;
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds = [];
    for (const it of cluster) {
      let c = colEnds.findIndex((end) => end <= it.s);
      if (c < 0) { c = colEnds.length; colEnds.push(it.ve); } else colEnds[c] = it.ve;
      it.col = c;
    }
    for (const it of cluster) {
      it.cols = colEnds.length;
      it.overlapsWith = cluster.filter((o) => o !== it && o.s < it.e && it.s < o.e);
      it.overlap = it.overlapsWith.length > 0;
      // widen into empty columns on the right
      it.span = 1;
      for (let c = it.col + 1; c < it.cols; c++) {
        if (cluster.some((o) => o.col === c && o.s < it.ve && it.s < o.ve)) break;
        it.span++;
      }
    }
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        if (cluster[i].s < cluster[j].e && cluster[j].s < cluster[i].e) pairs++;
      }
    }
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.ve);
  }
  if (cluster.length) flush();
  return pairs;
}

/** Free gaps inside the day window, ignoring the past. */
function freeGaps(items, d) {
  const t = today();
  if (d < t) return [];
  let [ws, we] = dayBounds();
  if (d === t) ws = Math.max(ws, Math.ceil(nowMin() / 5) * 5);
  if (ws >= we) return [];
  const busy = items.filter((i) => i.busy).map((i) => [Math.max(i.s, ws), Math.min(i.e, we)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cur = ws;
  for (const [a, b] of busy) {
    if (a - cur >= MIN_FREE) gaps.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (we - cur >= MIN_FREE) gaps.push([cur, we]);
  return gaps;
}

function dayItems(d, tasksOnDay, opts = {}) {
  const timed = [];
  const allDay = [];
  for (const ev of allEventsOn(d)) {
    if (ev.allDay) { allDay.push({ kind: 'event', ev }); continue; }
    const s = ev.time ? toMin(ev.time) : 0;
    const end = ev.endTime ? toMin(ev.endTime) : 1440;
    timed.push({ kind: 'event', ev, s, e: Math.max(end, s + 1), busy: true });
  }
  for (const t of tasksOnDay) {
    if (!t.time) { if (!opts.hideAllDayTasks) allDay.push({ kind: 'task', t }); continue; }
    const s = toMin(t.time);
    timed.push({ kind: 'task', t, s, e: Math.min(1440, s + (Number(t.duration) || DEFAULT_DURATION)), busy: !t.done });
  }
  for (const it of timed) it.ve = Math.max(it.e, it.s + 20); // visual end (tiny items stay clickable)
  return { timed, allDay };
}

function block(it) {
  const top = it.s * PX_MIN;
  const height = Math.max(18, (it.ve - it.s) * PX_MIN - 2);
  const left = `calc(${(it.col / it.cols) * 100}% + 2px)`;
  const width = `calc(${(100 * it.span) / it.cols}% - 4px)`;
  const style = `top:${top}px;height:${height}px;left:${left};width:${width}`;
  const short = height < 44; // not enough room for two lines: put the time next to the title
  const range = `${fmtTime(fromMin(it.s))}${it.e - it.s >= 30 ? ' – ' + fmtTime(fromMin(Math.min(it.e, 1439))) : ''}`;
  const name = (o) => (o.kind === 'event' ? o.ev.title : o.t.title);
  const clash = it.overlap ? ` · ⚠ overlaps ${it.overlapsWith.map(name).join(', ')}` : '';
  if (it.kind === 'event') {
    const e = it.ev;
    const local = e.local ? `data-drag-id="ev:${esc(e.id)}" data-resize="event"` : '';
    return `<div class="tb-item ev-block ${e.local ? 'local' : ''} ${short ? 'short' : ''} ${it.overlap ? 'overlap' : ''}" ${eventAttrs(e)} ${local} style="${style};--ec:${esc(e.color)}" title="${esc(e.title)} · ${esc(range)}${esc(clash)}">
      <b>${esc(e.title)}</b><small>${esc(range)}${e.location ? ' · ' + esc(e.location) : ''}</small>${e.local ? '<button class="tb-resize" aria-label="Drag to change duration" tabindex="-1"></button>' : ''}</div>`;
  }
  const t = it.t;
  return `<div class="tb-item task-block q${quadrant(t)} ${t.done ? 'is-done' : ''} ${short ? 'short' : ''} ${it.overlap ? 'overlap' : ''}" style="${style}"
      data-drag-id="${t.id}" data-resize="task" data-action="edit-task" data-id="${t.id}" title="${esc(t.title)} · ${esc(range)}${esc(clash)}">
    <button class="check q${quadrant(t)}" data-action="toggle-task" data-id="${t.id}" aria-label="Complete"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg></button>
    <span class="tb-text"><b>${esc(t.title)}</b><small>${esc(range)}</small></span>
    <button class="tb-resize" aria-label="Drag to change duration" tabindex="-1"></button>
  </div>`;
}

export function renderTimeGrid(start, n, map, opts = {}) {
  const t = today();
  const [ws, we] = dayBounds();
  const days = [...Array(n)].map((_, i) => addDays(start, i));
  const cols = days.map((d) => {
    const { timed, allDay } = dayItems(d, map.get(d) || [], opts);
    const overlaps = layout(timed);
    const free = freeGaps(timed, d);
    const freeTotal = free.reduce((a, [s, e]) => a + (e - s), 0);
    return { d, timed, allDay, overlaps, free, freeTotal };
  });

  const head = cols.map((c) => `<div class="tb-day ${c.d === t ? 'today' : ''}">
      <span>${WD_SHORT[parseYmd(c.d).getDay()]}</span><b>${parseYmd(c.d).getDate()}</b>
      <small>${c.d < t ? '' : c.freeTotal ? `<span class="free-sum">${fmtDur(c.freeTotal)}<em> free</em></span>` : '<span class="busy-sum">Booked</span>'}</small>
      ${c.overlaps ? `<small class="ov-sum" title="${c.overlaps} overlapping pair${c.overlaps > 1 ? 's' : ''}">⚠ ${c.overlaps}<em> overlap${c.overlaps > 1 ? 's' : ''}</em></small>` : ''}
    </div>`).join('');

  const allday = cols.map((c) => `<div class="tb-adcell" data-drop="allday:${c.d}">${c.allDay.map((x) => x.kind === 'event'
    ? `<div class="tb-chip ev" ${eventAttrs(x.ev)} ${x.ev.local ? `data-drag-id="ev:${esc(x.ev.id)}"` : ''} style="--ec:${esc(x.ev.color)}">${esc(x.ev.title)}</div>`
    : `<div class="tb-chip q${quadrant(x.t)} ${x.t.done ? 'is-done' : ''}" data-drag-id="${x.t.id}" data-action="edit-task" data-id="${x.t.id}">${esc(x.t.title)}</div>`).join('')}</div>`).join('');

  const hours = [...Array(24)].map((_, h) => (h ? `<span style="top:${h * HOUR_PX}px">${esc(fmtTime(fromMin(h * 60)).replace(':00', ''))}</span>` : '')).join('');

  const body = cols.map((c) => `<div class="tb-col ${c.d === t ? 'today' : ''} ${c.d < t ? 'past' : ''}" data-drop="slot:${c.d}" data-action="tb-slot" data-date="${c.d}">
      <div class="tb-off" style="top:0;height:${ws * PX_MIN}px"></div>
      <div class="tb-off" style="top:${we * PX_MIN}px;bottom:0"></div>
      ${c.free.map(([s, e]) => `<div class="tb-free" style="top:${s * PX_MIN}px;height:${(e - s) * PX_MIN}px"><span>Free · ${fmtDur(e - s)}</span></div>`).join('')}
      ${c.timed.map(block).join('')}
      ${c.d === t ? `<div class="tb-now" style="top:${nowMin() * PX_MIN}px"></div>` : ''}
    </div>`).join('');

  return `<div class="tb ${n === 1 ? 'tb-single' : ''}" style="--n:${n};--hour:${HOUR_PX}px">
    <div class="tb-top">
      <div class="tb-row tb-headrow"><div class="tb-gutter"></div>${head}</div>
      <div class="tb-row tb-allrow"><div class="tb-gutter"><small>all-day</small></div>${allday}</div>
    </div>
    <div class="tb-row tb-body" style="height:${24 * HOUR_PX}px"><div class="tb-hours">${hours}</div>${body}</div>
  </div>
  ${opts.hint === false ? '' : `<p class="hint tb-hint">Click an empty slot to add an event · drag tasks and your events to reschedule · drag the bottom edge to change the length.</p>`}`;
}

let scrollMemo = null;
/** Restore the grid's scroll position, or start near the current time / day start. */
export function afterTimeGrid(root) {
  const sc = root.querySelector('.tb');
  if (!sc) return;
  if (scrollMemo == null) {
    const [ws, we] = dayBounds();
    const n = nowMin();
    const startAt = n > ws + 120 && n < we ? n - 120 : ws - 30; // keep "now" in view, else day start
    scrollMemo = Math.max(0, startAt * PX_MIN);
  }
  sc.scrollTop = scrollMemo;
  sc.addEventListener('scroll', () => { scrollMemo = sc.scrollTop; }, { passive: true });
}

export function updateNowLine() {
  const el = document.querySelector('.tb-now');
  if (el) el.style.top = `${nowMin() * PX_MIN}px`;
}

/** Drag the bottom edge of a task or event block to change its duration. */
export function enableResize(root) {
  root.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.tb-resize');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const item = handle.closest('[data-resize]');
    if (!item) return;
    const isEvent = item.dataset.resize === 'event';
    const rec = isEvent ? getEvent(item.dataset.id) : getTask(item.dataset.id);
    if (!rec?.time) return;
    const fallback = isEvent ? 60 : DEFAULT_DURATION;
    const startY = e.clientY;
    const startH = item.offsetHeight;
    const startMin = toMin(rec.time);
    let dur = Number(rec.duration) || fallback;
    item.classList.add('resizing');
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const h = Math.max(15 * PX_MIN, startH + (ev.clientY - startY));
      dur = Math.max(15, Math.min(1440 - startMin, Math.round(h / PX_MIN / 15) * 15));
      item.style.height = `${dur * PX_MIN - 2}px`;
      const small = item.querySelector('small');
      if (small) small.textContent = `${fmtTime(rec.time)} – ${fmtTime(fromMin(Math.min(startMin + dur, 1439)))} · ${fmtDur(dur)}`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      item.classList.remove('resizing');
      suppressNextClick();
      if (dur !== (Number(rec.duration) || fallback)) (isEvent ? updateEvent : updateTask)(rec.id, { duration: dur });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
