import { esc } from '../util.js';
import { icon } from '../icons.js';
import { today, addDays, fmtDay, parseYmd } from '../dates.js';
import { tasks, sortTasks, habits, habitCount, isScheduled } from '../store.js';
import { taskRow } from '../ui.js';

export const LISTS = {
  today: { title: 'Today', icon: 'today' },
  week: { title: 'Next 7 Days', icon: 'week' },
  inbox: { title: 'All Tasks', icon: 'inbox' },
  done: { title: 'Completed', icon: 'done' },
};

const section = (title, list, opts = {}) => list.length ? `
  <section class="group">
    <h3 class="group-title ${opts.cls || ''}">${esc(title)}<span class="count">${list.length}</span></h3>
    <div class="task-list" ${opts.drop ? `data-drop="${opts.drop}"` : ''}>${list.map((t) => taskRow(t, opts)).join('')}</div>
  </section>` : '';

const empty = (msg) => `<div class="empty"><div class="empty-art">${icon('done')}</div><p>${msg}</p>
  <button class="btn primary" data-action="quick-add">${icon('plus')} Add a task</button></div>`;

const chips = (active) => `<div class="seg mobile-only">${Object.entries(LISTS).map(([k, v]) =>
  `<a href="#/${k}" class="${k === active ? 'on' : ''}">${v.title.replace('Next ', '')}</a>`).join('')}</div>`;

function habitStrip() {
  const t = today();
  const hs = habits().filter((h) => !h.archived && isScheduled(h, t));
  if (!hs.length) return '';
  return `<div class="habit-strip">${hs.map((h) => {
    const c = habitCount(h, t), g = h.goal || 1, done = c >= g;
    return `<button class="hchip ${done ? 'on' : ''}" style="--hc:${h.color}" data-action="habit-cycle" data-id="${h.id}" data-date="${t}">
      <span class="hchip-ico">${esc(h.icon)}</span><span class="hchip-name">${esc(h.name)}</span>${g > 1 ? `<small>${c}/${g}</small>` : ''}</button>`;
  }).join('')}</div>`;
}

export function renderList(kind) {
  const t = today();
  const open = tasks().filter((x) => !x.done);
  const overdue = sortTasks(open.filter((x) => x.date && x.date < t));
  let html = chips(kind);

  if (kind === 'today') {
    const todays = sortTasks(open.filter((x) => x.date === t));
    const doneToday = tasks().filter((x) => x.done && x.doneAt && new Date(x.doneAt).toDateString() === new Date().toDateString())
      .sort((a, b) => b.doneAt - a.doneAt);
    html += habitStrip();
    html += section('Overdue', overdue, { cls: 'red' });
    html += section(fmtDay(t, { long: true }), todays, { showDate: false, drop: `date:${t}` });
    if (!overdue.length && !todays.length) html += empty('Nothing due today. Enjoy it, or plan ahead.');
    html += section('Completed today', doneToday, { showDate: false });
  }

  if (kind === 'week') {
    html += section('Overdue', overdue, { cls: 'red' });
    for (let i = 0; i < 7; i++) {
      const d = addDays(t, i);
      const list = sortTasks(open.filter((x) => x.date === d));
      const label = `${fmtDay(d, { long: true })}${i < 2 ? ' · ' + parseYmd(d).toLocaleDateString([], { weekday: 'long' }) : ''}`;
      html += `<section class="group"><h3 class="group-title ${list.length ? '' : 'muted'}">${esc(label)}${list.length ? `<span class="count">${list.length}</span>` : ''}</h3>
        <div class="task-list ${list.length ? '' : 'empty-drop'}" data-drop="date:${d}">${list.map((x) => taskRow(x, { showDate: false })).join('')}</div></section>`;
    }
  }

  if (kind === 'inbox') {
    const tm = addDays(t, 1);
    html += section('Overdue', overdue, { cls: 'red' });
    html += section('Today', sortTasks(open.filter((x) => x.date === t)), { showDate: false, drop: `date:${t}` });
    html += section('Tomorrow', sortTasks(open.filter((x) => x.date === tm)), { showDate: false, drop: `date:${tm}` });
    html += section('Later', sortTasks(open.filter((x) => x.date && x.date > tm)));
    html += section('No date', sortTasks(open.filter((x) => !x.date)), { drop: 'date:' });
    if (!open.length) html += empty('No open tasks. Add one with the + button.');
  }

  if (kind === 'done') {
    const done = tasks().filter((x) => x.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const groups = new Map();
    for (const x of done) {
      const d = new Date(x.doneAt || x.updatedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    }
    for (const [d, list] of groups) html += section(fmtDay(d, { long: true }), list);
    if (!done.length) html += `<div class="empty"><div class="empty-art">${icon('done')}</div><p>Completed tasks will show up here.</p></div>`;
    else html += `<div class="center"><button class="btn ghost danger" data-action="clear-completed">${icon('trash')} Clear completed</button></div>`;
  }
  return html;
}
