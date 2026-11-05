import { $, $$, esc, toast } from './util.js';
import { icon } from './icons.js';
import { fmtDue, fmtTime, fmtDay, today, WD_MIN, WD_SHORT, weekday, addDays, diffDays } from './dates.js';
import { parseQuick } from './parse.js';
import { gcalOn } from './gcal.js';
import {
  settings, addTask, updateTask, deleteTask, getTask, toggleTask, quadrant, QUADS, quadFlags,
  snapshot, restore, addHabit, updateHabit, getHabit, addEvent, updateEvent, deleteEvent, getEvent,
  isRepeating, deleteOccurrence, detachOccurrence, addExam, EXAM_TYPES,
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
  ? `data-action="edit-event" data-id="${esc(e.id)}" data-date="${esc(e.occ || '')}" role="button" tabindex="0"`
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
  let kind = ['event', 'exam'].includes(preset.kind) ? preset.kind : 'task';
  let color = lastColor();
  const keyHint = (k) => (settings.shortcuts?.[k] ? `<kbd>${esc(settings.shortcuts[k])}</kbd>` : '');
  openSheet(`
    <form class="quick-add" autocomplete="off">
      <div class="seg qa-kind" role="tablist">
        <button type="button" data-kind="task" role="tab">Task ${keyHint('task')}</button>
        <button type="button" data-kind="event" role="tab">Event ${keyHint('event')}</button>
        <button type="button" data-kind="exam" role="tab">Exam</button>
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
        input.placeholder = kind === 'event' ? 'Add an event… e.g. “Dinner with Ana fri 7pm for 2h”'
          : kind === 'exam' ? 'Add an exam… e.g. “Calculus 15.12 9am”' : 'Add a task… e.g. “Call mom tomorrow 6pm !1”';
        $('#qa-hint', el).textContent = kind === 'event'
          ? 'Shows only in the calendar · no time = all-day · “for 2h” sets the length'
          : kind === 'exam' ? 'Gets a countdown on the Dashboard · reminder the day before · open it later to add the room'
          : 'Smart dates: today, fri, next week, 15.11, 3pm · !1–!4 = quadrant · daily/weekly';
        $$('input[name=qcolor]', el).forEach((r) => { r.checked = r.value === color; });
        const r = parse();
        const c = [];
        const date = r.date || preset.date || (kind === 'event' ? today() : null);
        if (kind === 'exam') {
          c.push(date ? `🎓 ${fmtDay(date)}${time0(r, preset) ? ' ' + fmtTime(time0(r, preset)) : ''} · in ${Math.max(0, diffDays(today(), date))} days` : '🎓 Add a date, e.g. “15.12” or “next fri”');
          chips.innerHTML = c.map((x) => `<span class="chip">${x}</span>`).join('');
          return;
        }
        const time = r.time || (r.date ? null : preset.time);
        if (date) c.push(`📅 ${fmtDay(date)}${time ? ' ' + fmtTime(time) : kind === 'event' ? ' · all day' : ''}`);
        const dur = r.duration || (kind === 'event' && time ? 60 : null);
        if (dur && (kind === 'event' ? time : true)) c.push(`⏱ ${fmtMins(dur)}`);
        if (kind === 'task') {
          const quad = r.quad || preset.quad;
          if (quad) c.push(`<i class="dot q${quad}"></i>${QUADS[quad].hint}`);
        }
        if (r.repeat) c.push(`${icon('repeat')} ${esc(describeRepeat(repeatFromParse(r, date || today())))}`);
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
        if (kind === 'exam') {
          const date = r.date || preset.date;
          if (!date) { toast('Add the exam date, e.g. “Calculus 15.12 9am”'); return; }
          addExam({ title: r.title, date, time, ...(r.duration ? { duration: r.duration } : {}) });
          toast(`Exam added: ${fmtDay(date)}`);
        } else if (kind === 'event') {
          const date = r.date || preset.date || today();
          addEvent({ title: r.title, date, time, duration: r.duration || 60, color, repeat: r.repeat ? repeatFromParse(r, date) : null });
          toast(`Event added to ${fmtDay(date)}`);
        } else {
          const q = r.quad || preset.quad;
          addTask({
            title: r.title, date: r.date || preset.date || null, time, repeat: r.repeat,
            duration: r.duration || null, remind: time ? 0 : null, ...(q ? quadFlags(q) : {}),
            ...(r.interval > 1 ? { repeatEvery: r.interval } : {}),
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

const time0 = (r, preset) => r.time || (r.date ? null : preset.time);

/* ---------- Exam editor ---------- */
const EXAM_REMINDERS = [['', 'No reminder'], ['60', '1 hour before'], ['180', '3 hours before'], ['1440', '1 day before'], ['2880', '2 days before']];
const EXAM_DURATIONS = [['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1.5 hours'], ['120', '2 hours'], ['150', '2.5 hours'], ['180', '3 hours'], ['240', '4 hours']];

/** Create (no id) or edit an exam. */
export function openExamEditor(id, preset = {}) {
  const ex = id ? getEvent(id) : null;
  if (id && (!ex || ex.deleted)) return;
  const v = ex || { title: '', examType: 'exam', date: preset.date || '', time: null, duration: 120, remind: 1440, location: '', color: '#e5484d', notes: '', grade: '' };
  const past = v.date && v.date < today();
  openSheet(`
    <form class="editor" autocomplete="off">
      <div class="editor-head">
        <span class="ev-swatch" style="background:${esc(v.color)}"></span>
        <input name="title" class="title-input" value="${esc(v.title)}" required placeholder="Subject, e.g. Calculus II" aria-label="Subject">
      </div>
      <div class="grid2">
        <label>Type<select name="examType">${Object.entries(EXAM_TYPES).map(([k, l]) => `<option value="${k}" ${v.examType === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Date<input type="date" name="date" value="${esc(v.date)}" required></label>
        <label>Start time <small class="hint">(optional)</small><input type="time" name="time" value="${esc(v.time || '')}"></label>
        <label>Duration<select name="duration">${opts(EXAM_DURATIONS, String(v.duration || 120))}</select></label>
        <label>Room / place<input name="location" value="${esc(v.location)}" placeholder="e.g. Room 204"></label>
        <label>Reminder<select name="remind">${opts(EXAM_REMINDERS, v.remind)}</select></label>
      </div>
      <div class="field-label">Color</div>
      <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === v.color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
      <textarea name="notes" rows="3" placeholder="Topics, materials, what to bring…">${esc(v.notes)}</textarea>
      <div class="grid2 grade-row" ${past || v.grade ? '' : 'hidden'}><label class="span2">Grade / result<input name="grade" value="${esc(v.grade || '')}" placeholder="e.g. 9.50 or Passed"></label></div>
      <div class="editor-foot">
        ${ex ? `<button type="button" class="btn danger ghost" data-x="delete">${icon('trash')} Delete</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-x="cancel">Cancel</button>
        <button type="submit" class="btn primary">${ex ? 'Save' : 'Add exam'}</button>
      </div>
    </form>`, {
    onMount(el) {
      const f = $('form', el);
      const sync = () => { $('.grade-row', el).hidden = !(f.date.value && f.date.value < today()) && !f.grade.value; };
      f.addEventListener('change', (e) => {
        if (e.target.name === 'color') $('.ev-swatch', el).style.background = e.target.value;
        sync();
      });
      if (!ex) setTimeout(() => f.title.focus(), 50);
      f.onsubmit = (e) => {
        e.preventDefault();
        const fields = {
          title: f.title.value.trim(), examType: f.examType.value, date: f.date.value, time: f.time.value || null,
          duration: Number(f.duration.value) || 120, location: f.location.value.trim(),
          remind: f.remind.value !== '' ? Number(f.remind.value) : null, color: f.color.value || v.color,
          notes: f.notes.value, grade: f.grade.value.trim(),
        };
        if (!fields.title || !fields.date) return;
        if (ex) updateEvent(id, fields); else { addExam(fields); toast(`Exam added: ${fmtDay(fields.date)}`); }
        closeSheet();
      };
      el.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]')?.dataset.x;
        if (x === 'cancel') closeSheet();
        if (x === 'delete') {
          deleteEvent(id); closeSheet();
          toast('Exam deleted', { action: 'Undo', onAction: () => updateEvent(id, { deleted: false }) });
        }
      });
    },
  });
}

/* ---------- Repeat rules for events ---------- */
/** Quick-add result → event repeat rule. */
export function repeatFromParse(r, date) {
  if (!r.repeat) return null;
  const interval = Math.max(1, r.interval || 1);
  if (r.repeat === 'weekdays') return { freq: 'weekly', interval, days: [1, 2, 3, 4, 5] };
  if (r.repeat === 'weekly') return { freq: 'weekly', interval, days: [weekday(date)] };
  return { freq: r.repeat, interval };
}

const UNITS = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };
export function describeRepeat(rep) {
  if (!rep?.freq) return 'Does not repeat';
  const n = Math.max(1, rep.interval || 1);
  const [one, many] = UNITS[rep.freq] || ['', ''];
  let txt = n === 1 ? `Every ${one}` : `Every ${n} ${many}`;
  if (rep.freq === 'weekly' && rep.days?.length) {
    const d = [...rep.days].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
    txt = d.join() === '1,2,3,4,5' && n === 1 ? 'Every weekday' : `${txt} on ${d.map((x) => WD_SHORT[x]).join(', ')}`;
  }
  if (rep.until) txt += ` until ${fmtDay(rep.until)}`;
  return txt;
}

const REPEAT_PRESETS = [
  ['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'],
  ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'], ['yearly', 'Every year'], ['custom', 'Custom…'],
];
function presetOf(rep) {
  if (!rep?.freq) return 'none';
  const n = rep.interval || 1;
  const days = (rep.days || []).join();
  if (rep.freq === 'daily' && n === 1) return 'daily';
  if (rep.freq === 'weekly' && n === 1 && days === '1,2,3,4,5') return 'weekdays';
  if (rep.freq === 'weekly' && (rep.days || []).length <= 1) return n === 1 ? 'weekly' : n === 2 ? 'biweekly' : 'custom';
  if (rep.freq === 'monthly' && n === 1) return 'monthly';
  if (rep.freq === 'yearly' && n === 1) return 'yearly';
  return 'custom';
}

/* ---------- Event editor (no completion: events just happen) ---------- */
/** `occ` is the occurrence date that was clicked (for repeating events). */
export function openEventEditor(id, occ) {
  const ev = getEvent(id);
  if (!ev || ev.deleted) return;
  const repeating = isRepeating(ev);
  const shownDate = repeating && occ ? occ : ev.date;
  const rep = ev.repeat || null;
  const order = settings.weekStart === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const repDays = rep?.days?.length ? rep.days : [weekday(shownDate)];
  openSheet(`
    <form class="editor" autocomplete="off">
      <div class="editor-head">
        <span class="ev-swatch" style="background:${esc(ev.color)}"></span>
        <input name="title" class="title-input" value="${esc(ev.title)}" required aria-label="Title">
      </div>
      ${repeating ? `<div class="repeat-note">${icon('repeat')} ${esc(describeRepeat(rep))} · you opened ${esc(new Date(shownDate + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</div>` : ''}
      <div class="grid2">
        <label>Date<input type="date" name="date" value="${shownDate}" required></label>
        <label>Start time<input type="time" name="time" value="${ev.time || ''}"></label>
        <label class="span2 inline-check"><input type="checkbox" name="allday" ${ev.time ? '' : 'checked'}> All day</label>
        <label>Duration<select name="duration">${opts(DURATIONS, String(ev.duration || 60))}</select></label>
        <label>Reminder<select name="remind">${opts(REMINDERS, ev.remind)}</select></label>
        <label class="span2">Repeat<select name="preset">${REPEAT_PRESETS.map(([k, l]) => `<option value="${k}" ${presetOf(rep) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="repeat-box" hidden>
        <div class="repeat-line">Every <input type="number" name="interval" min="1" max="99" value="${rep?.interval || 1}">
          <select name="freq">${[['daily', 'day(s)'], ['weekly', 'week(s)'], ['monthly', 'month(s)'], ['yearly', 'year(s)']].map(([k, l]) => `<option value="${k}" ${(rep?.freq || 'weekly') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="days repeat-days">${order.map((d) => `<label><input type="checkbox" name="rdays" value="${d}" ${repDays.includes(d) ? 'checked' : ''}><span>${WD_MIN[d]}</span></label>`).join('')}</div>
        <label class="repeat-line">Ends <select name="ends"><option value="never" ${rep?.until ? '' : 'selected'}>Never</option><option value="on" ${rep?.until ? 'selected' : ''}>On date</option></select>
          <input type="date" name="until" value="${rep?.until || ''}"></label>
        <p class="small faint repeat-summary"></p>
      </div>
      <div class="grid2"><label class="span2">Location<input name="location" value="${esc(ev.location)}" placeholder="Optional"></label></div>
      <div class="field-label">Color</div>
      <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === ev.color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
      <textarea name="notes" rows="3" placeholder="Notes">${esc(ev.notes)}</textarea>
      <div class="editor-foot ${repeating ? 'wrap' : ''}">
        ${repeating
    ? `<button type="button" class="btn danger ghost" data-x="delete-one">${icon('trash')} This event</button>
           <button type="button" class="btn danger ghost" data-x="delete-all">All events</button>`
    : `<button type="button" class="btn danger ghost" data-x="delete">${icon('trash')} Delete</button>`}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-x="cancel">Cancel</button>
        ${repeating
    ? `<button type="button" class="btn" data-x="save-one">Save this event</button><button type="submit" class="btn primary">Save all</button>`
    : '<button type="submit" class="btn primary">Save</button>'}
      </div>
    </form>`, {
    onMount(el) {
      const f = $('form', el);
      let lastTime = ev.time || '09:00';
      const readRepeat = () => {
        const p = f.preset.value;
        const d = f.date.value || shownDate;
        if (p === 'none') return null;
        let r;
        if (p === 'custom') {
          r = { freq: f.freq.value, interval: Math.max(1, Math.min(99, +f.interval.value || 1)) };
          if (r.freq === 'weekly') {
            const days = $$('input[name=rdays]:checked', f).map((c) => +c.value);
            r.days = days.length ? days.sort() : [weekday(d)];
          }
        } else if (p === 'weekdays') r = { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] };
        else if (p === 'weekly' || p === 'biweekly') r = { freq: 'weekly', interval: p === 'biweekly' ? 2 : 1, days: [weekday(d)] };
        else r = { freq: p, interval: 1 };
        if (f.ends.value === 'on' && f.until.value) r.until = f.until.value;
        return r;
      };
      const sync = () => {
        f.time.disabled = f.allday.checked;
        f.duration.disabled = f.allday.checked || !f.time.value;
        const custom = f.preset.value === 'custom';
        const none = f.preset.value === 'none';
        $('.repeat-box', el).hidden = none;
        $$('.repeat-line:first-child, .repeat-days', el).forEach((x) => { x.hidden = !custom; });
        $('.repeat-days', el).hidden = !custom || f.freq.value !== 'weekly';
        f.until.hidden = f.ends.value !== 'on';
        $('.repeat-summary', el).textContent = none ? '' : describeRepeat(readRepeat());
      };
      f.allday.onchange = () => {
        if (f.allday.checked) { lastTime = f.time.value || lastTime; f.time.value = ''; } else if (!f.time.value) f.time.value = lastTime;
        sync();
      };
      f.time.oninput = () => { if (f.time.value) f.allday.checked = false; sync(); };
      f.addEventListener('change', (e) => {
        if (e.target.name === 'color') $('.ev-swatch', el).style.background = e.target.value;
        if (e.target.name === 'ends' && f.ends.value === 'on' && !f.until.value) f.until.value = addDays(f.date.value || shownDate, 28);
        sync();
      });
      f.addEventListener('input', sync);
      sync();

      const fields = () => ({
        title: f.title.value.trim() || ev.title, time: f.allday.checked ? null : (f.time.value || null),
        duration: Number(f.duration.value) || 60, remind: f.remind.value !== '' ? Number(f.remind.value) : null,
        location: f.location.value.trim(), color: f.color.value || ev.color, notes: f.notes.value,
      });
      const saveAll = () => {
        const newRepeat = readRepeat();
        const newDate = f.date.value || shownDate;
        if (repeating && newRepeat) {
          // moving the clicked occurrence shifts the whole series by the same number of days
          const delta = diffDays(shownDate, newDate);
          updateEvent(id, { ...fields(), repeat: newRepeat, date: delta ? addDays(ev.date, delta) : ev.date });
        } else {
          updateEvent(id, { ...fields(), repeat: newRepeat, date: newDate, ...(newRepeat ? {} : { exdates: [] }) });
        }
        closeSheet();
      };
      f.onsubmit = (e) => { e.preventDefault(); saveAll(); };
      el.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]')?.dataset.x;
        if (x === 'cancel') closeSheet();
        if (x === 'save-one') {
          detachOccurrence(id, shownDate, { ...fields(), date: f.date.value || shownDate });
          closeSheet();
          toast('Changed this event only');
        }
        if (x === 'delete' || x === 'delete-all') {
          deleteEvent(id); closeSheet();
          toast(repeating ? 'All events deleted' : 'Event deleted', { action: 'Undo', onAction: () => updateEvent(id, { deleted: false }) });
        }
        if (x === 'delete-one') {
          const before = [...(ev.exdates || [])];
          deleteOccurrence(id, shownDate); closeSheet();
          toast('This event deleted', { action: 'Undo', onAction: () => updateEvent(id, { exdates: before }) });
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
