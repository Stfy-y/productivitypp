// TickTick-style "smart recognition" for quick add.
import { today, addDays, weekday, pad, ymd } from './dates.js';

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WD_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function futureDate(m, d, y) {
  const t = today();
  let s = `${y ?? t.slice(0, 4)}-${pad(m)}-${pad(d)}`;
  if (y == null && s < t) s = `${+t.slice(0, 4) + 1}-${pad(m)}-${pad(d)}`;
  const check = new Date(s + 'T12:00');
  return check.getDate() === d ? s : null;
}

export function parseQuick(text, { weekStart = 1 } = {}) {
  let s = ` ${text} `;
  const out = { title: '', date: null, time: null, duration: null, quad: null, repeat: '', interval: 1, tokens: [] };
  const take = (re, fn) => {
    s = s.replace(re, (...m) => {
      if (fn(...m) === false) return m[0];
      out.tokens.push(m[0].trim());
      return ' ';
    });
  };
  const B = '(?=[\\s,.!?]|$)';
  const t = today();

  // Quadrant / priority: !1 .. !4
  take(new RegExp(`\\s!([1-4])${B}`), (_, n) => { out.quad = +n; });

  // Repeat
  const UNIT = { day: 'daily', days: 'daily', week: 'weekly', weeks: 'weekly', month: 'monthly', months: 'monthly', year: 'yearly', years: 'yearly' };
  take(new RegExp(`\\severy\\s(\\d{1,2})\\s(days?|weeks?|months?|years?)${B}`, 'i'), (_, n, u) => {
    if (+n < 1) return false;
    out.repeat = UNIT[u.toLowerCase()]; out.interval = +n;
  });
  take(new RegExp(`\\s(biweekly|fortnightly|every\\sother\\sweek|every\\stwo\\sweeks)${B}`, 'i'), () => { out.repeat = 'weekly'; out.interval = 2; });
  take(new RegExp(`\\s(every\\s?day|daily)${B}`, 'i'), () => { out.repeat = 'daily'; });
  take(new RegExp(`\\s(every\\s?weekday|weekdays)${B}`, 'i'), () => { out.repeat = 'weekdays'; });
  take(new RegExp(`\\severy\\s${WD_RE}${B}`, 'i'), (_, w) => {
    out.repeat = 'weekly';
    const target = WD.indexOf(w.slice(0, 3).toLowerCase());
    out.date = addDays(t, (target - weekday(t) + 7) % 7);
  });
  take(new RegExp(`\\s(every\\s?week|weekly)${B}`, 'i'), () => { out.repeat = 'weekly'; });
  take(new RegExp(`\\s(every\\s?month|monthly)${B}`, 'i'), () => { out.repeat = 'monthly'; });
  take(new RegExp(`\\s(every\\s?year|yearly|annually)${B}`, 'i'), () => { out.repeat = 'yearly'; });

  // Duration: for 2h, for 90 min, for 1.5 hours
  take(new RegExp(`\\sfor\\s(\\d+(?:[.,]\\d+)?)\\s?(h|hr|hrs|hours?|m|min|mins|minutes?)${B}`, 'i'), (_, n, u) => {
    const v = parseFloat(n.replace(',', '.')) * (/^h/i.test(u) ? 60 : 1);
    if (!v || v > 1440) return false;
    out.duration = Math.max(5, Math.round(v / 5) * 5);
  });

  // Time: 3pm, 3:30pm, at 15:30, 15h30, at 9
  take(new RegExp(`\\s(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm)${B}`, 'i'), (_, h, m = '00', ap) => {
    h = +h; if (h < 1 || h > 12 || +m > 59) return false;
    if (/pm/i.test(ap) && h < 12) h += 12;
    if (/am/i.test(ap) && h === 12) h = 0;
    out.time = `${pad(h)}:${m}`;
  });
  if (!out.time) take(new RegExp(`\\s(?:at\\s+)?([01]?\\d|2[0-3])[:h]([0-5]\\d)${B}`, 'i'), (_, h, m) => { out.time = `${pad(+h)}:${m}`; });
  if (!out.time) take(new RegExp(`\\sat\\s+([01]?\\d|2[0-3])${B}`, 'i'), (_, h) => { out.time = `${pad(+h)}:00`; });
  if (!out.time) take(new RegExp(`\\s(noon|midday)${B}`, 'i'), () => { out.time = '12:00'; });
  if (!out.time) take(new RegExp(`\\s(tonight)${B}`, 'i'), () => { out.time = '20:00'; out.date ??= t; });

  // Dates
  if (!out.date) take(new RegExp(`\\s(today|tod)${B}`, 'i'), () => { out.date = t; });
  if (!out.date) take(new RegExp(`\\s(day after tomorrow)${B}`, 'i'), () => { out.date = addDays(t, 2); });
  if (!out.date) take(new RegExp(`\\s(tomorrow|tmrw?|tmr)${B}`, 'i'), () => { out.date = addDays(t, 1); });
  if (!out.date) take(new RegExp(`\\s(next week)${B}`, 'i'), () => {
    out.date = addDays(t, ((weekStart - weekday(t) + 7) % 7) || 7);
  });
  if (!out.date) take(new RegExp(`\\s(next month)${B}`, 'i'), () => {
    const d = new Date(); out.date = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  });
  if (!out.date) take(new RegExp(`\\sin\\s(\\d{1,3})\\s(day|days|week|weeks)${B}`, 'i'), (_, n, u) => {
    out.date = addDays(t, +n * (/week/i.test(u) ? 7 : 1));
  });
  if (!out.date) take(new RegExp(`\\s(?:(next|this|on)\\s)?${WD_RE}${B}`, 'i'), (_, mod, w) => {
    const target = WD.indexOf(w.slice(0, 3).toLowerCase());
    let n = (target - weekday(t) + 7) % 7;
    if (mod && mod.toLowerCase() === 'next' && n === 0) n = 7;
    out.date = addDays(t, n);
  });
  if (!out.date) take(new RegExp(`\\s(\\d{4})-(\\d{2})-(\\d{2})${B}`), (_, y, m, d) => {
    const r = futureDate(+m, +d, +y); if (!r) return false; out.date = r;
  });
  if (!out.date) take(new RegExp(`\\s(?:on\\s)?${MON_RE}\\s(\\d{1,2})(?:st|nd|rd|th)?${B}`, 'i'), (_, mo, d) => {
    const r = futureDate(MON.indexOf(mo.slice(0, 3).toLowerCase()) + 1, +d); if (!r) return false; out.date = r;
  });
  if (!out.date) take(new RegExp(`\\s(?:on\\s)?(\\d{1,2})(?:st|nd|rd|th)?\\s${MON_RE}${B}`, 'i'), (_, d, mo) => {
    const r = futureDate(MON.indexOf(mo.slice(0, 3).toLowerCase()) + 1, +d); if (!r) return false; out.date = r;
  });
  // European day.month or day/month (optionally .year)
  if (!out.date) take(new RegExp(`\\s(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?${B}`), (_, d, m, y) => {
    if (+m < 1 || +m > 12) return false;
    if (y && y.length === 2) y = '20' + y;
    const r = futureDate(+m, +d, y ? +y : undefined); if (!r) return false; out.date = r;
  });

  if ((out.time || out.repeat) && !out.date) out.date = t;
  out.title = s.replace(/\s+/g, ' ').trim();
  return out;
}
