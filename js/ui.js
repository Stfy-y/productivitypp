import { $, $$, esc, toast } from './util.js';
import { icon } from './icons.js';
import { fmtDue, fmtTime, fmtDay, today, WD_MIN } from './dates.js';
import { parseQuick } from './parse.js';
import { gcalOn } from './gcal.js';
import {
  settings, addTask, updateTask, deleteTask, getTask, toggleTask, quadrant, QUADS, quadFlags,
  snapshot, restore, addHabit, updateHabit, getHabit,
} from './store.js';

/* ---------- Sheet / modal ---------- */
let current = null;
export function openSheet(html, { onMount, wide = false } = {}) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div>`;
  root.classList.add('open');
  const el = $('.sheet', root);
  $('.sheet-backdrop', root).onclick = closeSheet;
  current = { el };
  onMount?.(el);
  return el;
}
export function closeSheet() {
  const root = $('#sheet-root');
  if (!root.classList.contains('open')) return;
  root.classList.remove('open');
  root.innerHTML = '';
  current = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) closeSheet(); });

/* ---------- Task row ---------- */
export function taskRow(t, { showDate = true } = {}) {
  const q = quadrant(t);
  const overdue = !t.done && t.date && t.date < today();
  const meta = [];
  if (showDate && t.date) meta.push(`<span class="${overdue ? 'overdue' : ''}">${esc(fmtDue(t.date, t.time))}</span>`);
  else if (t.time) meta.push(`<span>${esc(fmtTime(t.time))}</span>`);
  if (t.repeat) meta.push(`<span class="mi" title="Repeats ${t.repeat}">${icon('repeat')}</span>`);
  if (t.remind != null && t.remind !== '') meta.push(`<span class="mi" title="Reminder">${icon('bell')}</span>`);
  if (t.notes) meta.push(`<span class="note">${esc(t.notes.split('\n')[0].slice(0, 60))}</span>`);
  return `<div class="task ${t.done ? 'is-done' : ''}" data-drag-id="${t.id}" data-action="edit-task" data-id="${t.id}">
    <button class="check q${q}" data-action="toggle-task" data-id="${t.id}" aria-label="${t.done ? 'Mark not done' : 'Complete'}">${icon('check')}</button>
    <div class="task-body"><div class="task-title">${esc(t.title)}</div>${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}</div>
  </div>`;
}

/* ---------- Google Calendar event row ---------- */
export function eventRow(e) {
  const when = e.allDay ? 'All day' : `${e.time ? fmtTime(e.time) : '…'}${e.endTime ? ' – ' + fmtTime(e.endTime) : ''}`;
  return `<a class="event" href="${esc(e.link)}" target="_blank" rel="noopener" style="--ec:${esc(e.color)}">
    <span class="ev-bar"></span><span class="ev-body"><span class="ev-title">${esc(e.title)}</span>
    <span class="ev-meta">${esc(when)}${e.location ? ` · ${esc(e.location)}` : ''}</span></span></a>`;
}

export function doToggle(id) {
  const snap = snapshot();
  const r = toggleTask(id);
  const t = getTask(id);
  if (r === 'rolled') toast(`Done. Next: ${fmtDay(t.date)}`, { action: 'Undo', onAction: () => restore(snap) });
  else if (r === 'done') toast('Task completed', { action: 'Undo', onAction: () => restore(snap) });
  navigator.vibrate?.(8);
}

/* ---------- Quick add ---------- */
export function openQuickAdd(preset = {}) {
  const presetChips = [];
  if (preset.date) presetChips.push(`📅 ${fmtDay(preset.date)}`);
  if (preset.quad) presetChips.push(`<i class="dot q${preset.quad}"></i>${QUADS[preset.quad].hint}`);
  openSheet(`
    <form class="quick-add" autocomplete="off">
      <input name="q" placeholder="Add a task… e.g. “Call mom tomorrow 6pm !1”" enterkeyhint="done" aria-label="New task">
      <div class="chips" id="qa-chips">${presetChips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>
      <div class="qa-foot">
        <span class="hint">Smart dates: today, fri, next week, 15.11, 3pm · !1–!4 = quadrant · daily/weekly</span>
        <button class="btn primary" type="submit">Add</button>
      </div>
    </form>`, {
    onMount(el) {
      const input = $('input', el);
      const chips = $('#qa-chips', el);
      setTimeout(() => input.focus(), 50);
      input.addEventListener('input', () => {
        const r = parseQuick(input.value, { weekStart: settings.weekStart });
        const c = [];
        const date = r.date || preset.date;
        const quad = r.quad || preset.quad;
        if (date) c.push(`📅 ${fmtDay(date)}${r.time ? ' ' + fmtTime(r.time) : ''}`);
        if (quad) c.push(`<i class="dot q${quad}"></i>${QUADS[quad].hint}`);
        if (r.repeat) c.push(`${icon('repeat')} ${r.repeat}`);
        chips.innerHTML = c.map((x) => `<span class="chip">${x}</span>`).join('');
      });
      $('form', el).onsubmit = (e) => {
        e.preventDefault();
        const r = parseQuick(input.value, { weekStart: settings.weekStart });
        if (!r.title) return;
        const q = r.quad || preset.quad;
        addTask({
          title: r.title, date: r.date || preset.date || null, time: r.time, repeat: r.repeat,
          remind: r.time ? 0 : null, ...(q ? quadFlags(q) : {}),
        });
        toast(`Added${r.date || preset.date ? ' to ' + fmtDay(r.date || preset.date) : ''}`);
        input.value = '';
        chips.innerHTML = '';
        if (matchMedia('(max-width: 899px)').matches) closeSheet();
      };
    },
  });
}

/* ---------- Task editor ---------- */
const REMINDERS = [['', 'No reminder'], ['0', 'On time'], ['5', '5 min before'], ['15', '15 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['1440', '1 day before']];
const REPEATS = [['', 'Does not repeat'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const opts = (list, v) => list.map(([k, l]) => `<option value="${k}" ${String(v ?? '') === k ? 'selected' : ''}>${l}</option>`).join('');

export function openTaskEditor(id) {
  const t = getTask(id);
  if (!t || t.deleted) return;
  const q = quadrant(t);
  openSheet(`
    <form class="editor" autocomplete="off">
      <div class="editor-head">
        <button type="button" class="check big q${q} ${t.done ? 'on' : ''}" data-x="toggle">${icon('check')}</button>
        <input name="title" class="title-input" value="${esc(t.title)}" required aria-label="Title">
      </div>
      <textarea name="notes" rows="3" placeholder="Notes">${esc(t.notes)}</textarea>
      <div class="grid2">
        <label>Date<input type="date" name="date" value="${t.date || ''}"></label>
        <label>Time<input type="time" name="time" value="${t.time || ''}"></label>
        <label>Repeat<select name="repeat">${opts(REPEATS, t.repeat)}</select></label>
        <label>Reminder<select name="remind">${opts(REMINDERS, t.remind)}</select></label>
      </div>
      ${gcalOn() ? `<label class="gcal-toggle"><input type="checkbox" name="gcal" ${t.gcal?.want ? 'checked' : ''}>
        <span>Add to Google Calendar</span><small>Stays in sync when you edit or move this task</small></label>` : ''}
      <div class="field-label">Eisenhower quadrant</div>
      <div class="quad-pick">${[1, 2, 3, 4].map((n) => `
        <label class="qp q${n}"><input type="radio" name="quad" value="${n}" ${n === q ? 'checked' : ''}><span><b>${QUADS[n].hint}</b><small>${QUADS[n].name}</small></span></label>`).join('')}
      </div>
      <div class="editor-foot">
        <button type="button" class="btn danger ghost" data-x="delete">${icon('trash')} Delete</button>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-x="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`, {
    onMount(el) {
      const f = $('form', el);
      const sync = () => {
        f.remind.disabled = !f.date.value;
        if (f.gcal) f.gcal.disabled = !f.date.value;
      };
      f.date.oninput = sync; sync();
      f.onsubmit = (e) => {
        e.preventDefault();
        const quad = +f.quad.value;
        updateTask(id, {
          title: f.title.value.trim() || t.title, notes: f.notes.value,
          date: f.date.value || null, time: f.time.value || null,
          repeat: f.date.value ? f.repeat.value : '',
          remind: f.date.value && f.remind.value !== '' ? Number(f.remind.value) : null,
          ...quadFlags(quad),
          ...(f.gcal ? { gcal: f.gcal.checked && f.date.value ? { ...(t.gcal || {}), want: true } : (t.gcal ? { ...t.gcal, want: false } : null) } : {}),
        });
        closeSheet();
      };
      el.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]')?.dataset.x;
        if (x === 'cancel') closeSheet();
        if (x === 'toggle') { closeSheet(); doToggle(id); }
        if (x === 'delete') {
          const snap = snapshot();
          deleteTask(id); closeSheet();
          toast('Task deleted', { action: 'Undo', onAction: () => restore(snap) });
        }
      });
    },
  });
}

/* ---------- Habit editor ---------- */
const COLORS = ['#4f6bed', '#e5484d', '#f5a524', '#22a06b', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];
const EMOJI = ['✅', '💧', '📚', '🏃', '🧘', '💪', '🥗', '😴', '✍️', '🎸', '🧹', '💊', '🚭', '🌅', '📵', '💰'];

export function openHabitEditor(id) {
  const h = id ? getHabit(id) : { name: '', icon: '✅', color: COLORS[0], days: [0, 1, 2, 3, 4, 5, 6], goal: 1, remind: null };
  const order = settings.weekStart === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  openSheet(`
    <form class="editor" autocomplete="off">
      <h2>${id ? 'Edit habit' : 'New habit'}</h2>
      <div class="editor-head">
        <input name="icon" class="emoji-input" value="${esc(h.icon)}" maxlength="4" aria-label="Icon">
        <input name="name" class="title-input" value="${esc(h.name)}" placeholder="e.g. Meditate" required aria-label="Name">
      </div>
      <div class="emoji-row">${EMOJI.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>
      <div class="field-label">Color</div>
      <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === h.color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
      <div class="field-label">Repeat on <button type="button" class="link" data-days="all">Every day</button> · <button type="button" class="link" data-days="wk">Weekdays</button></div>
      <div class="days">${order.map((d) => `<label><input type="checkbox" name="days" value="${d}" ${h.days?.includes(d) ? 'checked' : ''}><span>${WD_MIN[d]}</span></label>`).join('')}</div>
      <div class="grid2">
        <label>Times per day<input type="number" name="goal" min="1" max="50" value="${h.goal || 1}"></label>
        <label>Reminder<input type="time" name="remind" value="${h.remind || ''}"></label>
      </div>
      <div class="editor-foot">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-x="cancel">Cancel</button>
        <button type="submit" class="btn primary">${id ? 'Save' : 'Create'}</button>
      </div>
    </form>`, {
    onMount(el) {
      const f = $('form', el);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.emoji) f.icon.value = b.dataset.emoji;
        if (b.dataset.x === 'cancel') closeSheet();
        if (b.dataset.days) $$('input[name=days]', f).forEach((c) => { c.checked = b.dataset.days === 'all' || !['0', '6'].includes(c.value); });
      });
      if (!id) setTimeout(() => f.name.focus(), 50);
      f.onsubmit = (e) => {
        e.preventDefault();
        const days = $$('input[name=days]:checked', f).map((c) => +c.value).sort();
        const data = {
          name: f.name.value.trim(), icon: f.icon.value.trim() || '✅', color: f.color.value,
          days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
          goal: Math.max(1, +f.goal.value || 1), remind: f.remind.value || null,
        };
        if (id) updateHabit(id, data); else addHabit(data);
        closeSheet();
      };
    },
  });
}

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    openSheet(`<div class="confirm"><p>${esc(message)}</p><div class="editor-foot"><span class="spacer"></span>
      <button class="btn ghost" data-r="0">Cancel</button><button class="btn danger" data-r="1">${esc(okLabel)}</button></div></div>`, {
      onMount(el) {
        el.addEventListener('click', (e) => {
          const r = e.target.closest('[data-r]')?.dataset.r;
          if (r == null) return;
          closeSheet();
          resolve(r === '1');
        });
      },
    });
  });
}
