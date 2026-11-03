// Calendar events = your own events (stored in the app) + Google Calendar events.
import { events } from './store.js';
import { eventsOn } from './gcal.js';

const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** App events on a date, shaped like Google events (plus `local: true`). */
export function localEventsOn(date) {
  return events().filter((e) => e.date === date).map((e) => {
    const end = e.time ? Math.min(1440, toMin(e.time) + (Number(e.duration) || 60)) : null;
    return {
      id: e.id, cal: 'local', local: true, title: e.title || '(No title)', allDay: !e.time,
      time: e.time || null, endTime: e.time ? fromMin(end) : null, color: e.color || '#4f6bed',
      location: e.location || '', link: '', duration: Number(e.duration) || 60,
    };
  });
}

/** Everything that should appear on the calendar for a date. */
export function allEventsOn(date) {
  return [...localEventsOn(date), ...eventsOn(date)]
    .sort((a, b) => (b.allDay - a.allDay) || (a.time || '').localeCompare(b.time || ''));
}
