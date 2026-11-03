import { esc } from '../util.js';
import { icon } from '../icons.js';
import { today, addDays, parseYmd, startOfWeek, startOfMonth, addMonths, diffDays, WD_MIN, WD_SHORT, MONTHS } from '../dates.js';
import { habits, getHabit, habitCount, habitStats, isScheduled, settings } from '../store.js';

const state = { date: today(), month: startOfMonth(today()), showArchived: false };
export function habitAction(action, el) {
  if (action === 'habit-date') state.date = el.dataset.date;
  if (action === 'habit-month-prev') state.month = addMonths(state.month, -1);
  if (action === 'habit-month-next') state.month = addMonths(state.month, 1);
  if (action === 'habit-archived') state.showArchived = !state.showArchived;
}

const ring = (c, g, color) => {
  const p = Math.min(1, c / g);
  return `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line)" stroke-width="3"/>
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(p * 97.4).toFixed(1)} 97.4" transform="rotate(-90 18 18)"/></svg>`;
};

export function renderHabits() {
  const t = today();
  const ws = startOfWeek(state.date, settings.weekStart);
  let html = `<div class="date-strip">
    <button class="icon-btn small" data-action="habit-date" data-date="${addDays(ws, -7)}" aria-label="Previous week">${icon('left')}</button>
    ${[...Array(7)].map((_, i) => {
      const d = addDays(ws, i);
      return `<button class="ds-day ${d === state.date ? 'sel' : ''} ${d === t ? 'today' : ''}" data-action="habit-date" data-date="${d}" ${d > t ? 'disabled' : ''}>
        <small>${WD_SHORT[parseYmd(d).getDay()]}</small><b>${parseYmd(d).getDate()}</b></button>`;
    }).join('')}
    <button class="icon-btn small" data-action="habit-date" data-date="${addDays(ws, 7) > t ? t : addDays(ws, 7)}" aria-label="Next week">${icon('right')}</button>
  </div>`;

  const list = habits().filter((h) => !h.archived);
  const archived = habits().filter((h) => h.archived);
  if (!list.length) {
    html += `<div class="empty"><div class="empty-art">${icon('habits')}</div><p>Build a habit. Small steps, every day.</p>
      <button class="btn primary" data-action="habit-new">${icon('plus')} New habit</button></div>`;
  }
  const sorted = [...list].sort((a, b) => isScheduled(b, state.date) - isScheduled(a, state.date));
  html += `<div class="habit-list">${sorted.map((h) => card(h)).join('')}</div>`;
  if (list.length) html += `<div class="center"><button class="btn ghost" data-action="habit-new">${icon('plus')} New habit</button></div>`;
  if (archived.length) {
    html += `<div class="center"><button class="link" data-action="habit-archived">${state.showArchived ? 'Hide' : 'Show'} archived (${archived.length})</button></div>`;
    if (state.showArchived) html += `<div class="habit-list archived">${archived.map((h) => card(h)).join('')}</div>`;
  }
  return html;
}

function card(h) {
  const d = state.date;
  const c = habitCount(h, d), g = h.goal || 1, done = c >= g;
  const st = habitStats(h);
  const sched = isScheduled(h, d);
  const last7 = [...Array(7)].map((_, i) => addDays(d, i - 6));
  return `<article class="habit ${done ? 'on' : ''} ${sched ? '' : 'off'}" style="--hc:${h.color}" data-action="habit-open" data-id="${h.id}">
    <div class="habit-ico">${esc(h.icon)}</div>
    <div class="habit-body">
      <div class="habit-name">${esc(h.name)}</div>
      <div class="habit-sub">${st.current ? `<span class="streak">${icon('flame')} ${st.current}</span>` : ''}
        ${g > 1 ? `<span>${c}/${g} today</span>` : ''}${sched ? '' : '<span>Not scheduled</span>'}${h.remind ? `<span class="mi">${icon('bell')}</span>` : ''}</div>
      <div class="mini-week">${last7.map((x) => {
        const n = habitCount(h, x);
        const cls = n >= g ? 'full' : n > 0 ? 'part' : isScheduled(h, x) ? '' : 'na';
        return `<button class="mw ${cls}" data-action="habit-cycle" data-id="${h.id}" data-date="${x}" title="${x}">${WD_MIN[parseYmd(x).getDay()]}</button>`;
      }).join('')}</div>
    </div>
    <button class="habit-check" data-action="habit-cycle" data-id="${h.id}" data-date="${d}" aria-label="Check in ${esc(h.name)}">
      ${ring(c, g, h.color)}<span>${done ? icon('check') : g > 1 ? c : ''}</span></button>
  </article>`;
}

export function renderHabitDetail(id) {
  const h = getHabit(id);
  if (!h || h.deleted) return '<div class="empty"><p>Habit not found.</p><a class="btn" href="#/habits">Back</a></div>';
  const st = habitStats(h);
  const t = today();
  const m = state.month;
  const first = parseYmd(m);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const gs = startOfWeek(m, settings.weekStart);
  const lead = diffDays(gs, m);
  const order = [...Array(7)].map((_, i) => (settings.weekStart + i) % 7);
  const g = h.goal || 1;
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div></div>';
  for (let i = 0; i < days; i++) {
    const d = addDays(m, i);
    const c = habitCount(h, d);
    const cls = [c >= g ? 'full' : c > 0 ? 'part' : '', d === t ? 'today' : '', !isScheduled(h, d) ? 'na' : ''].join(' ');
    cells += `<button class="hm ${cls}" ${d > t ? 'disabled' : ''} data-action="habit-cycle" data-id="${h.id}" data-date="${d}">${i + 1}</button>`;
  }
  const daysTxt = h.days?.length === 7 ? 'Every day' : order.filter((d) => h.days.includes(d)).map((d) => WD_SHORT[d]).join(', ');
  return `<div class="habit-detail" style="--hc:${h.color}">
    <div class="hd-head">
      <a href="#/habits" class="icon-btn" aria-label="Back">${icon('back')}</a>
      <div class="habit-ico big">${esc(h.icon)}</div>
      <div><h2>${esc(h.name)}</h2><small>${esc(daysTxt)}${g > 1 ? ` · ${g}× per day` : ''}${h.remind ? ` · ⏰ ${h.remind}` : ''}</small></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${st.current}</b><small>Current streak</small></div>
      <div class="stat"><b>${st.best}</b><small>Best streak</small></div>
      <div class="stat"><b>${st.total}</b><small>Total days</small></div>
      <div class="stat"><b>${st.monthRate}%</b><small>This month</small></div>
    </div>
    <div class="card">
      <div class="cal-nav">
        <button class="icon-btn" data-action="habit-month-prev" aria-label="Previous month">${icon('left')}</button>
        <h3>${MONTHS[first.getMonth()]} ${first.getFullYear()}</h3>
        <button class="icon-btn" data-action="habit-month-next" aria-label="Next month">${icon('right')}</button>
      </div>
      <div class="hm-grid">${order.map((d) => `<div class="hm-head">${WD_MIN[d]}</div>`).join('')}${cells}</div>
    </div>
    <div class="row-actions">
      <button class="btn" data-action="habit-edit" data-id="${h.id}">${icon('edit')} Edit</button>
      <button class="btn" data-action="habit-archive" data-id="${h.id}">${icon('archive')} ${h.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="btn danger ghost" data-action="habit-delete" data-id="${h.id}">${icon('trash')} Delete</button>
    </div>
  </div>`;
}
