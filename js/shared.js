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
  };
}

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
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  for (const h of state.habits || []) {
    if (h.deleted || h.archived || !h.remind || h.remind !== hm) continue;
    if (Array.isArray(h.days) && h.days.length && !h.days.includes(wd)) continue;
    if ((h.log?.[date]?.c || 0) >= (h.goal || 1)) continue;
    out.push({ tag: `h-${h.id}-${date}`, title: `${h.icon || ''} ${h.name}`.trim(), body: 'Time for your habit. Tap to check in.', url: './#/habits', kind: 'habit', id: h.id, date });
  }
  return out;
}
