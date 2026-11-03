import { $, $$, esc, toast } from './util.js';
import { icon } from './icons.js';
import { fmtDue, fmtTime, fmtDay, today, WD_MIN } from './dates.js';
import { parseQuick } from './parse.js';
import { gcalOn } from './gcal.js';
import {
  settings, addTask, updateTask, deleteTask, getTask, toggleTask, quadrant, QUADS, quadFlags,
  snapshot, restore, addHabit, updateHabit, getHabit, addEvent, updateEvent, deleteEvent, getEvent,
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
/** Attributes that make an element open the in-app event window. */
export const eventAttrs = (e) => (e.local
  ? `data-action="edit-event" data-id="${esc(e.id)}" role="button" tabindex="0"`
  : `data-action="open-event" data-cal="${esc(e.cal)}" data-id="${esc(e.id)}" role="button" tabindex="0"`);

export function eventRow(e) {
  const when = e.allDay ? 'All day' : `${e.time ? fmtTime(e.time) : '…'}${e.endTime ? ' – ' + fmtTime(e.endTime) : ''}`;
  return `<div class="event" ${eventAttrs(e)} style="--ec:${esc(e.color)}">
    <span class="ev-bar"></span><span class="ev-body"><span class="ev-title">${esc(e.title)}</span>
    <span class="ev-meta">${esc(when)}${e.location ? ` · ${esc(e.location)}` : ''}</span></span></div>`;
}

/* ---------- Event details window ---------- */
const linkify = (text) => esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

/** Google descriptions can contain HTML: keep only the text and line breaks, then re-linkify. */
function descriptionText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'), 'text/html');
  doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

function eventWhen(e) {
  const dayFmt = { weekday: 'short', month: 'short', day: 'numeric' };
  if (e.allDay) {
    const s = new Date(e.start + 'T12:00');
    const last = new Date(e.end + 'T12:00'); last.setDate(last.getDate() - 1);
    const one = s.toDateString() === last.toDateString();
    return `All day · ${s.toLocaleDateString([], dayFmt)}${one ? '' : ' – ' + last.toLocaleDateString([], dayFmt)}`;
  }
  const s = new Date(e.start), en = new Date(e.end);
  const t = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = s.toDateString() === en.toDateString();
  const mins = Math.round((en - s) / 60000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}` : `${mins}m`;
  return sameDay
    ? `${s.toLocaleDateString([], dayFmt)} · ${t(s)} – ${t(en)} <span class="faint">(${dur})</span>`
    : `${s.toLocaleDateString([], dayFmt)} ${t(s)} – ${en.toLocaleDateString([], dayFmt)} ${t(en)}`;
}

const RSVP = { accepted: ['✓', 'Going'], declined: ['✕', 'Not going'], tentative: ['?', 'Maybe'], needsAction: ['•', 'No reply'] };

export function openEventSheet(e) {
  const desc = descriptionText(e.description);
  const guests = (e.attendees || []).filter((a) => a.name);
  const going = guests.filter((a) => a.status === 'accepted').length;
  const me = guests.find((a) => a.self);
  const row = (ico, html) => `<div class="evd-row"><span class="evd-ico">${ico}</span><div>${html}</div></div>`;
  openSheet(`
    <div class="evd" style="--ec:${esc(e.color)}">
      <div class="evd-head"><span class="evd-swatch"></span><h2>${esc(e.title)}</h2>
        <button class="icon-btn" data-x="close" aria-label="Close">${icon('close')}</button></div>
      ${row('🕒', eventWhen(e))}
      ${e.calName ? row('📅', esc(e.calName)) : ''}
      ${e.location ? row('📍', `${linkify(e.location)}<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}" target="_blank" rel="noopener" class="small">Open in Maps</a>`) : ''}
      ${e.meet ? row('🎥', `<a class="btn small primary" href="${esc(e.meet)}" target="_blank" rel="noopener">Join video call</a>`) : ''}
      ${e.organizer ? row('👤', `Organized by ${esc(e.organizer)}`) : ''}
      ${guests.length ? row('👥', `<b>${guests.length} guest${guests.length > 1 ? 's' : ''}</b> <span class="faint">· ${going} going</span>
        <ul class="evd-guests">${guests.map((a) => `<li class="rs-${esc(a.status)}" title="${esc(RSVP[a.status]?.[1] || '')}"><i>${RSVP[a.status]?.[0] || '•'}</i>${esc(a.name)}${a.self ? ' <span class="faint">(you)</span>' : ''}${a.organizer ? ' <span class="faint">· organizer</span>' : ''}</li>`).join('')}</ul>
        ${me ? `<p class="small faint">Your reply: ${esc(RSVP[me.status]?.[1] || me.status)}</p>` : ''}`) : ''}
      ${desc ? `<div class="evd-desc">${linkify(desc)}</div>` : ''}
      ${e.description === undefined ? '<p class="small faint">Update your worker to see the description, guests and video link here.</p>' : ''}
      <div class="editor-foot"><span class="spacer"></span>
        ${e.link ? `<a class="btn ghost" href="${esc(e.link)}" target="_blank" rel="noopener">Open in Google Calendar</a>` : ''}
        <button class="btn primary" data-x="close">Done</button></div>
    </div>`, {
    onMount(el) {
      el.addEventListener('click', (ev) => { if (ev.target.closest('[data-x="close"]')) closeSheet(); });
    },
  });
}

export function doToggle(id) {
  const snap = snapshot();
  const r = toggleTask(id);
  const t = getTask(id);
  if (r === 'rolled') toast(`Done. Next: ${fmtDay(t.date)}`, { action: 'Undo', onAction: () => restore(snap) });
  else if (r === 'done') toast('Task completed', { action: 'Undo', onAction: () => restore(snap) });
  navigator.vibrate?.(8);
}

/* ---------- Quick add (tasks and events) ---------- */
const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const lastColor = () => { try { return localStorage.getItem('ppp-ev-color') || COLORS[0]; } catch { return COLORS[0]; } };

export function openQuickAdd(preset = {}) {
  let kind = preset.kind === 'event' ? 'event' : 'task';
  let color = lastColor();
  const keyHint = (k) => (settings.shortcuts?.[k] ? `<kbd>${esc(settings.shortcuts[k])}</kbd>` : '');
  openSheet(`
    <form class="quick-add" autocomplete="off">
      <div class="seg qa-kind" role="tablist">
        <button type="button" data-kind="task" role="tab">Task ${keyHint('task')}</button>
        <button type="button" data-kind="event" role="tab">Event ${keyHint('event')}</button>
      </div>
      <input name="q" enterkeyhint="done" aria-label="Title">
      <div class="qa-colors swatches">${COLORS.map((c) => `<label><input type="radio" name="qcolor" value="${c}"><span style="background:${c}"></span></label>`).join('')}</div>
      <div class="chips" id="qa-chips"></div>
      <div class="qa-foot">
        <span class="hint" id="qa-hint"></span>
        <button class="btn primary" type="submit">Add</button>
      </div>
    </form>`, {
    onMount(el) {
      const form = $('form', el);
      const input = $('input[name=q]', el);
      const chips = $('#qa-chips', el);
      const parse = () => parseQuick(input.value, { weekStart: settings.weekStart });

      const update = () => {
        $$('.qa-kind button', el).forEach((b) => { b.classList.toggle('on', b.dataset.kind === kind); b.setAttribute('aria-selected', b.dataset.kind === kind); });
        form.classList.toggle('is-event', kind === 'event');
        input.placeholder = kind === 'event' ? 'Add an event… e.g. “Dinner with Ana fri 7pm for 2h”' : 'Add a task… e.g. “Call mom tomorrow 6pm !1”';
        $('#qa-hint', el).textContent = kind === 'event'
          ? 'Shows only in the calendar · no time = all-day · “for 2h” sets the length'
          : 'Smart dates: today, fri, next week, 15.11, 3pm · !1–!4 = quadrant · daily/weekly';
        $$('input[name=qcolor]', el).forEach((r) => { r.checked = r.value === color; });
        const r = parse();
        const c = [];
        const date = r.date || preset.date || (kind === 'event' ? today() : null);
        const time = r.time || (r.date ? null : preset.time);
        if (date) c.push(`📅 ${fmtDay(date)}${time ? ' ' + fmtTime(time) : kind === 'event' ? ' · all day' : ''}`);
        const dur = r.duration || (kind === 'event' && time ? 60 : null);
        if (dur && (kind === 'event' ? time : true)) c.push(`⏱ ${fmtMins(dur)}`);
        if (kind === 'task') {
          const quad = r.quad || preset.quad;
          if (quad) c.push(`<i class="dot q${quad}"></i>${QUADS[quad].hint}`);
          if (r.repeat) c.push(`${icon('repeat')} ${r.repeat}`);
        }
        chips.innerHTML = c.map((x) => `<span class="chip">${x}</span>`).join('');
      };

      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-kind]');
        if (b) { kind = b.dataset.kind; update(); input.focus(); }
      });
      el.addEventListener('change', (e) => {
        if (e.target.name === 'qcolor') { color = e.target.value; try { localStorage.setItem('ppp-ev-color', color); } catch { /* ignore */ } }
      });
      input.addEventListener('input', update);
      update();
      setTimeout(() => input.focus(), 50);

      form.onsubmit = (e) => {
        e.preventDefault();
        const r = parse();
        if (!r.title) return;
        const time = r.time || (r.date ? null : preset.time || null);
        if (kind === 'event') {
          const date = r.date || preset.date || today();
          addEvent({ title: r.title, date, time, duration: r.duration || 60, color });
          toast(`Event added to ${fmtDay(date)}`);
        } else {
          const q = r.quad || preset.quad;
          addTask({
            title: r.title, date: r.date || preset.date || null, time, repeat: r.repeat,
            duration: r.duration || null, remind: time ? 0 : null, ...(q ? quadFlags(q) : {}),
          });
          toast(`Added${r.date || preset.date ? ' to ' + fmtDay(r.date || preset.date) : ''}`);
        }
        input.value = '';
        update();
        if (matchMedia('(max-width: 899px)').matches) closeSheet();
      };
    },
  });
}

/* ---------- Event editor (no completion: events just happen) ---------- */
export function openEventEditor(id) {
  const ev = getEvent(id);
  if (!ev || ev.deleted) return;
  openSheet(`
    <form class="editor" autocomplete="off">
      <div class="editor-head">
        <span class="ev-swatch" style="background:${esc(ev.color)}"></span>
        <input name="title" class="title-input" value="${esc(ev.title)}" required aria-label="Title">
      </div>
      <div class="grid2">
        <label>Date<input type="date" name="date" value="${ev.date || today()}" required></label>
        <label>Start time<input type="time" name="time" value="${ev.time || ''}"></label>
        <label class="span2 inline-check"><input type="checkbox" name="allday" ${ev.time ? '' : 'checked'}> All day</label>
        <label>Duration<select name="duration">${opts(DURATIONS, String(ev.duration || 60))}</select></label>
        <label>Reminder<select name="remind">${opts(REMINDERS, ev.remind)}</select></label>
        <label class="span2">Location<input name="location" value="${esc(ev.location)}" placeholder="Optional"></label>
      </div>
      <div class="field-label">Color</div>
      <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === ev.color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
      <textarea name="notes" rows="3" placeholder="Notes">${esc(ev.notes)}</textarea>
      <div class="editor-foot">
        <button type="button" class="btn danger ghost" data-x="delete">${icon('trash')} Delete</button>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-x="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`, {
    onMount(el) {
      const f = $('form', el);
      let lastTime = ev.time || '09:00';
      const sync = () => {
        f.time.disabled = f.allday.checked;
        f.duration.disabled = f.allday.checked || !f.time.value;
      };
      f.allday.onchange = () => {
        if (f.allday.checked) { lastTime = f.time.value || lastTime; f.time.value = ''; } else if (!f.time.value) f.time.value = lastTime;
        sync();
      };
      f.time.oninput = () => { if (f.time.value) f.allday.checked = false; sync(); };
      sync();
      f.addEventListener('change', (e) => { if (e.target.name === 'color') $('.ev-swatch', el).style.background = e.target.value; });
      f.onsubmit = (e) => {
        e.preventDefault();
        updateEvent(id, {
          title: f.title.value.trim() || ev.title, date: f.date.value || ev.date, time: f.allday.checked ? null : (f.time.value || null),
          duration: Number(f.duration.value) || 60, remind: f.remind.value !== '' ? Number(f.remind.value) : null,
          location: f.location.value.trim(), color: f.color.value || ev.color, notes: f.notes.value,
        });
        closeSheet();
      };
      el.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]')?.dataset.x;
        if (x === 'cancel') closeSheet();
        if (x === 'delete') {
          deleteEvent(id); closeSheet();
          toast('Event deleted', { action: 'Undo', onAction: () => updateEvent(id, { deleted: false }) });
        }
      });
    },
  });
}

/* ---------- Task editor ---------- */
const REMINDERS = [['', 'No reminder'], ['0', 'On time'], ['5', '5 min before'], ['15', '15 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['1440', '1 day before']];
const REPEATS = [['', 'Does not repeat'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const DURATIONS = [['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1.5 hours'], ['120', '2 hours'], ['180', '3 hours'], ['240', '4 hours'], ['360', '6 hours'], ['480', '8 hours']];
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
        <label>Duration<select name="duration">${opts(DURATIONS, String(t.duration || 30))}</select></label>
        <label>Reminder<select name="remind">${opts(REMINDERS, t.remind)}</select></label>
        <label class="span2">Repeat<select name="repeat">${opts(REPEATS, t.repeat)}</select></label>
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
        f.duration.disabled = !f.time.value;
        if (f.gcal) f.gcal.disabled = !f.date.value;
      };
      f.date.oninput = sync; f.time.oninput = sync; sync();
      f.onsubmit = (e) => {
        e.preventDefault();
        const quad = +f.quad.value;
        updateTask(id, {
          title: f.title.value.trim() || t.title, notes: f.notes.value,
          date: f.date.value || null, time: f.time.value || null, duration: Number(f.duration.value) || 30,
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
