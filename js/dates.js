export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => ymd(new Date());
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
/** whole days from a to b (b - a) */
export const diffDays = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
export const weekday = (s) => parseYmd(s).getDay();
export const startOfWeek = (s, weekStart = 1) => addDays(s, -((weekday(s) - weekStart + 7) % 7));
export const startOfMonth = (s) => s.slice(0, 8) + '01';
export function addMonths(s, n) {
  const d = parseYmd(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
}

export const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WD_MIN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(s, { long = false } = {}) {
  const n = diffDays(today(), s);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  const d = parseYmd(s);
  if (n > 1 && n < 7 && !long) return WD_SHORT[d.getDay()];
  const opts = { month: 'short', day: 'numeric' };
  if (long) opts.weekday = 'short';
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

export const fmtDue = (date, time) => (date ? fmtDay(date) : '') + (time ? ' ' + fmtTime(time) : '');

/** Next occurrence for a repeating task, never earlier than tomorrow-ish (today excluded only if date is today). */
export function nextOccurrence(date, repeat, every = 1) {
  const step = (d) => {
    switch (repeat) {
      case 'daily': return addDays(d, 1);
      case 'weekdays': { let n = addDays(d, 1); while ([0, 6].includes(weekday(n))) n = addDays(n, 1); return n; }
      case 'weekly': return addDays(d, 7);
      case 'monthly': return addMonths(d, 1);
      case 'yearly': return addMonths(d, 12);
      default: return d;
    }
  };
  let n = date;
  for (let i = 0; i < Math.max(1, every | 0); i++) n = step(n);
  const t = today();
  let guard = 0;
  while (n < t && guard++ < 1000) for (let i = 0; i < Math.max(1, every | 0); i++) n = step(n);
  return n;
}
