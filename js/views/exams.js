// Exams: upcoming exams with countdowns, past exams with grades.
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { today, diffDays, parseYmd, fmtTime } from '../dates.js';
import { exams, EXAM_TYPES } from '../store.js';
import { toMin } from './timegrid.js';

const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const fmtHM = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m} min`);

/** Countdown for an exam: { big, unit, label, level: 'now'|'hot'|'warm'|'cool'|'past' }. */
export function countdown(e) {
  const days = diffDays(today(), e.date);
  if (days < 0) return { big: '✓', unit: '', label: 'Done', level: 'past' };
  if (days === 0) {
    if (!e.time) return { big: 'Today', unit: '', label: 'Today', level: 'now' };
    const left = toMin(e.time) - nowMin();
    const end = toMin(e.time) + (Number(e.duration) || 120) - nowMin();
    if (left > 0) return { big: fmtHM(left), unit: 'to go', label: `Today in ${fmtHM(left)}`, level: 'now' };
    if (end > 0) return { big: 'Now', unit: '', label: 'Happening now. Good luck!', level: 'now' };
    return { big: '✓', unit: '', label: 'Done today', level: 'past' };
  }
  const level = days <= 3 ? 'hot' : days <= 7 ? 'warm' : 'cool';
  if (days === 1) return { big: '1', unit: 'day', label: 'Tomorrow', level };
  return { big: String(days), unit: 'days', label: `In ${days} days${days >= 14 ? ` (${Math.round(days / 7)} weeks)` : ''}`, level };
}

const isUpcoming = (e) => countdown(e).level !== 'past';
export const upcomingExams = () => exams().filter(isUpcoming);

export const whenText = (e) => {
  const d = parseYmd(e.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(e.date.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' } : {}) });
  return e.time ? `${d} · ${fmtTime(e.time)}` : `${d} · time TBA`;
};

function examCard(e) {
  const c = countdown(e);
  return `<article class="exam ${c.level}" style="--ec:${esc(e.color)}" data-action="exam-edit" data-id="${esc(e.id)}" role="button" tabindex="0">
    <div class="exam-count"><b>${esc(c.big)}</b>${c.unit ? `<small>${c.unit}</small>` : ''}</div>
    <div class="exam-body">
      <div class="exam-title">${esc(e.title)}<span class="tag">${esc(EXAM_TYPES[e.examType] || 'Exam')}</span></div>
      <div class="exam-meta">${esc(whenText(e))}${e.location ? ` · ${esc(e.location)}` : ''}</div>
      <div class="exam-meta strong">${esc(c.label)}</div>
      ${e.notes ? `<div class="exam-notes">${esc(e.notes.split('\n')[0].slice(0, 120))}</div>` : ''}
    </div>
  </article>`;
}

function pastRow(e) {
  return `<div class="exam-past" data-action="exam-edit" data-id="${esc(e.id)}" role="button" tabindex="0" style="--ec:${esc(e.color)}">
    <span class="dot" style="--c:${esc(e.color)}"></span>
    <span class="exam-past-title">${esc(e.title)} <small>${esc(EXAM_TYPES[e.examType] || 'Exam')} · ${esc(parseYmd(e.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</small></span>
    ${e.grade ? `<b class="grade">${esc(e.grade)}</b>` : '<span class="link">Add grade</span>'}
  </div>`;
}

export function renderExams() {
  const all = exams();
  const up = all.filter(isUpcoming);
  const past = all.filter((e) => !isUpcoming(e)).reverse();
  if (!all.length) {
    return `<div class="empty"><div class="empty-art">${icon('exam')}</div><p>No exams yet. Add one and it gets a countdown on the Dashboard and a reminder the day before.</p>
      <button class="btn primary" data-action="exam-new">${icon('plus')} Add an exam</button></div>`;
  }
  const soon = up.filter((e) => diffDays(today(), e.date) <= 14).length;
  let html = up.length
    ? `<p class="exam-summary">${up.length} upcoming${soon ? ` · <b>${soon} in the next 2 weeks</b>` : ''}</p><div class="exam-list">${up.map(examCard).join('')}</div>`
    : '<div class="empty"><p>No upcoming exams. Enjoy the break! 🎉</p></div>';
  if (past.length) {
    html += `<section class="group"><h3 class="group-title">Past<span class="count">${past.length}</span></h3><div class="card exam-past-list">${past.map(pastRow).join('')}</div></section>`;
  }
  return html;
}
