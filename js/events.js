// Calendar events = your own events (stored in the app) + Google Calendar events.
import { events, isExam } from './store.js';
import { eventsOn } from './gcal.js';
import { occursOn } from './shared.js';

const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? '')); return m ? Math.min(1440, +m[1] * 60 + +m[2]) : 0; };
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** App events on a date, shaped like Google events (plus `local: true`). */
export function localEventsOn(date) {
  return events().filter((e) => occursOn(e, date)).map((e) => {
    const time = /^\d{1,2}:\d{2}/.test(String(e.time ?? '')) ? String(e.time).slice(0, 5).padStart(5, '0') : null;
    const end = time ? Math.min(1440, toMin(time) + (Number(e.duration) || 60)) : null;
    return {
      id: e.id, occ: date, repeating: !!e.repeat?.freq, cal: 'local', local: true, exam: isExam(e),
      title: `${isExam(e) ? '🎓 ' : ''}${e.title || '(No title)'}`, allDay: !time,
      time, endTime: time ? fromMin(end) : null, color: e.color || '#4f6bed',
      location: e.location || '', link: '', duration: Number(e.duration) || 60,
    };
  });
}

/** Everything that should appear on the calendar for a date. */
export function allEventsOn(date) {
  return [...localEventsOn(date), ...eventsOn(date)]
    .sort((a, b) => (b.allDay - a.allDay) || (a.time || '').localeCompare(b.time || ''));
}
