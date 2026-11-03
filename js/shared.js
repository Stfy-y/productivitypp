// Logic shared with the sync worker (worker/worker.js keeps a copy — keep them in sync).

const TOMBSTONE_TTL = 60 * 864e5; // forget deleted items after 60 days

export function mergeLog(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (!out[k] || (v?.t || 0) > (out[k]?.t || 0)) out[k] = v;
  }
  return out;
}

export function mergeItems(a = [], b = [], withLog = false) {
  const map = new Map();
  for (const x of a) map.set(x.id, x);
  for (const y of b) {
    const x = map.get(y.id);
    if (!x) { map.set(y.id, y); continue; }
    const win = (y.updatedAt || 0) > (x.updatedAt || 0) ? y : x;
    map.set(y.id, withLog ? { ...win, log: mergeLog(x.log, y.log) } : win);
  }
  const cutoff = Date.now() - TOMBSTONE_TTL;
  return [...map.values()].filter((i) => !(i.deleted && (i.updatedAt || 0) < cutoff));
}

export function mergeState(a, b) {
  return {
    tasks: mergeItems(a?.tasks, b?.tasks),
    habits: mergeItems(a?.habits, b?.habits, true),
    events: mergeItems(a?.events, b?.events),
  };
}

/* ---------- Repeating events ---------- */
// e.repeat = { freq: 'daily'|'weekly'|'monthly'|'yearly', interval: 1, days: [0-6] (weekly), until: 'YYYY-MM-DD' }
// e.exdates = ['YYYY-MM-DD', ...] occurrences that were deleted or moved
const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const wdOf = (n) => (((n % 7) + 7 + 4) % 7); // day 0 (1970-01-01) was a Thursday
const weekIdx = (n) => Math.floor((n - ((wdOf(n) + 6) % 7)) / 7); // Monday-based weeks

export function occursOn(e, d) {
  if (!e || e.deleted || !e.date || !d) return false;
  const r = e.repeat;
  if (!r || !r.freq) return e.date === d;
  if (d < e.date || (r.until && d > r.until) || (e.exdates || []).includes(d)) return false;
  const n = Math.max(1, Math.floor(Number(r.interval)) || 1);
  const a = dayNum(e.date), b = dayNum(d);
  switch (r.freq) {
    case 'daily': return (b - a) % n === 0;
    case 'weekly': {
      const days = Array.isArray(r.days) && r.days.length ? r.days : [wdOf(a)];
      return days.includes(wdOf(b)) && (weekIdx(b) - weekIdx(a)) % n === 0;
    }
    case 'monthly': {
      if (d.slice(8) !== e.date.slice(8)) return false;
      const months = (+d.slice(0, 4) * 12 + +d.slice(5, 7)) - (+e.date.slice(0, 4) * 12 + +e.date.slice(5, 7));
      return months % n === 0;
    }
    case 'yearly': return d.slice(5) === e.date.slice(5) && (+d.slice(0, 4) - +e.date.slice(0, 4)) % n === 0;
    default: return false;
  }
}

const addDaysStr = (s, k) => new Date((dayNum(s) + k) * 864e5).toISOString().slice(0, 10);

/** Shift a naive local 'YYYY-MM-DDTHH:MM' key by minutes. */
export function shiftMinutes(key, mins) {
  const [d, hm] = key.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [H, M] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, H, M) + mins * 60000).toISOString().slice(0, 16);
}

/** Current wall-clock minute as 'YYYY-MM-DDTHH:MM', in the device zone or a given IANA zone. */
export function localMinuteKey(date = new Date(), timeZone) {
  if (!timeZone) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Reminders that should fire exactly at the given local minute key. */
export function remindersAt(state, minuteKey, allDayTime = '09:00') {
  const out = [];
  const [date, hm] = minuteKey.split('T');
  for (const t of state.tasks || []) {
    if (t.deleted || t.done || !t.date || t.remind == null || t.remind === '') continue;
    const at = shiftMinutes(`${t.date}T${t.time || allDayTime}`, -Number(t.remind));
    if (at !== minuteKey) continue;
    const when = t.time ? `Due ${t.date === date ? 'today' : t.date} at ${t.time}` : `Due ${t.date === date ? 'today' : t.date}`;
    out.push({ tag: `t-${t.id}-${t.date}`, title: t.title, body: t.notes ? `${when} · ${t.notes.slice(0, 80)}` : when, url: `./#/task/${t.id}`, kind: 'task', id: t.id });
  }
  for (const ev of state.events || []) {
    if (ev.deleted || !ev.date || ev.remind == null || ev.remind === '') continue;
    // the occurrence can be today or up to 2 days ahead (reminders go up to 1 day early)
    for (let k = 0; k <= 2; k++) {
      const occ = addDaysStr(date, k);
      if (!occursOn(ev, occ)) continue;
      const at = shiftMinutes(`${occ}T${ev.time || allDayTime}`, -Number(ev.remind));
      if (at !== minuteKey) continue;
      const when = ev.time ? `${occ === date ? 'Today' : occ} at ${ev.time}` : `${occ === date ? 'Today' : occ} (all day)`;
      out.push({ tag: `e-${ev.id}-${occ}`, title: ev.title, body: [when, ev.location].filter(Boolean).join(' · '), url: './#/calendar', kind: 'event', id: ev.id });
    }
  }
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  for (const h of state.habits || []) {
    if (h.deleted || h.archived || !h.remind || h.remind !== hm) continue;
    if (Array.isArray(h.days) && h.days.length && !h.days.includes(wd)) continue;
    if ((h.log?.[date]?.c || 0) >= (h.goal || 1)) continue;
    out.push({ tag: `h-${h.id}-${date}`, title: `${h.icon || ''} ${h.name}`.trim(), body: 'Time for your habit. Tap to check in.', url: './#/habits', kind: 'habit', id: h.id, date });
  }
  return out;
}
