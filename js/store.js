import { uid } from './util.js';
import { today, addDays, nextOccurrence } from './dates.js';
import { mergeState } from './shared.js';

const KEY = 'ppp-data-v1';
const SKEY = 'ppp-settings-v1';

const defaultSettings = {
  theme: 'auto', // auto | light | dark
  weekStart: 1, // 1 = Monday, 0 = Sunday
  notify: false,
  push: false,
  remindAllDay: '09:00',
  dayStart: '08:00', // free-time window in the week grid
  dayEnd: '22:00',
  apiUrl: '',
  apiToken: '',
  lastSync: 0,
  syncError: '',
  shortcuts: { task: 'N', event: 'E' }, // keyboard shortcuts for quick add
  units: 'auto', // weather units: auto | metric | imperial
  weatherLoc: null, // { name, lat, lon } for the dashboard weather
  burnIn: true, // Dashboard drifts a few pixels now and then (protects screens left on)
  music: false, // show now playing from the local helper (extras/now-playing)
  musicUrl: 'http://127.0.0.1:8971',
};

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export const db = load(KEY) || { tasks: [], habits: [], dirty: false, rev: 0, seeded: false };
db.rev ??= 0;
db.events ??= [];
export const settings = { ...defaultSettings, ...(load(SKEY) || {}) };
settings.shortcuts = { ...defaultSettings.shortcuts, ...(settings.shortcuts || {}) };

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (kind) => listeners.forEach((fn) => fn(kind));

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.error('Save failed', e); }
}
function changed() { db.dirty = true; db.rev++; persist(); emit('data'); }

export function saveSettings(patch) {
  Object.assign(settings, patch);
  localStorage.setItem(SKEY, JSON.stringify(settings));
  emit('settings');
}

/* ---------- Tasks ---------- */
export const tasks = () => db.tasks.filter((t) => !t.deleted);
export const getTask = (id) => db.tasks.find((t) => t.id === id);
export const quadrant = (t) => (t.important ? (t.urgent ? 1 : 2) : (t.urgent ? 3 : 4));
export const QUADS = {
  1: { name: 'Urgent & Important', hint: 'Do first', important: true, urgent: true },
  2: { name: 'Not Urgent & Important', hint: 'Schedule', important: true, urgent: false },
  3: { name: 'Urgent & Not Important', hint: 'Delegate', important: false, urgent: true },
  4: { name: 'Not Urgent & Not Important', hint: 'Eliminate', important: false, urgent: false },
};
export const quadFlags = (q) => ({ important: QUADS[q].important, urgent: QUADS[q].urgent });

export function addTask(fields) {
  const now = Date.now();
  const t = {
    id: uid(), title: '', notes: '', date: null, time: null,
    important: false, urgent: false, done: false, doneAt: null,
    repeat: '', remind: null, createdAt: now, updatedAt: now, ...fields,
  };
  db.tasks.push(t);
  changed();
  return t;
}

export function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: Date.now() });
  changed();
  return t;
}

export const deleteTask = (id) => updateTask(id, { deleted: true });

/** Snapshot of tasks for undo. */
export const snapshot = () => JSON.stringify(db.tasks);
export function restore(snap) {
  const old = new Map(JSON.parse(snap).map((t) => [t.id, t]));
  const now = Date.now();
  db.tasks = db.tasks.map((t) => {
    const o = old.get(t.id);
    if (!o) return { ...t, deleted: true, updatedAt: now };
    return JSON.stringify(o) === JSON.stringify(t) ? t : { ...o, updatedAt: now };
  });
  changed();
}

/** Toggle completion. Repeating tasks log a completed copy and roll forward. */
export function toggleTask(id) {
  const t = getTask(id);
  if (!t) return;
  const now = Date.now();
  if (!t.done && t.repeat && t.date) {
    db.tasks.push({ ...t, id: uid(), done: true, doneAt: now, repeat: '', remind: null, gcal: null, createdAt: now, updatedAt: now, repeatOf: t.id });
    Object.assign(t, { date: nextOccurrence(t.date, t.repeat, t.repeatEvery || 1), updatedAt: now });
    changed();
    return 'rolled';
  }
  Object.assign(t, { done: !t.done, doneAt: t.done ? null : now, updatedAt: now });
  changed();
  return t.done ? 'done' : 'undone';
}

export function sortTasks(list) {
  return list.sort((a, b) =>
    (a.date || '9999').localeCompare(b.date || '9999') ||
    (a.time || '99').localeCompare(b.time || '99') ||
    quadrant(a) - quadrant(b) ||
    a.createdAt - b.createdAt);
}

/* ---------- Events (calendar only: no completion) ---------- */
export const events = () => db.events.filter((e) => !e.deleted);
export const getEvent = (id) => db.events.find((e) => e.id === id);

export function addEvent(fields) {
  const now = Date.now();
  const e = {
    id: uid(), title: '', date: today(), time: null, duration: 60, color: '#4f6bed',
    location: '', notes: '', remind: null, createdAt: now, updatedAt: now, ...fields,
  };
  db.events.push(e);
  changed();
  return e;
}

export function updateEvent(id, patch) {
  const e = getEvent(id);
  if (!e) return null;
  Object.assign(e, patch, { updatedAt: Date.now() });
  changed();
  return e;
}

export const deleteEvent = (id) => updateEvent(id, { deleted: true });

/* ---------- Exams (stored as events with kind: 'exam', so they sync and remind like events) ---------- */
export const EXAM_TYPES = {
  exam: 'Exam', midterm: 'Midterm', test: 'Test / quiz', oral: 'Oral exam', presentation: 'Presentation', project: 'Project due',
};
export const isExam = (e) => e?.kind === 'exam';
export const exams = () => events().filter(isExam)
  .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
export const addExam = (fields) => addEvent({
  duration: 120, color: '#e5484d', remind: 1440, examType: 'exam', grade: '', ...fields, kind: 'exam', repeat: null,
});
export const isRepeating = (e) => !!e?.repeat?.freq;

/** Skip one occurrence of a repeating event. */
export function deleteOccurrence(id, date) {
  const e = getEvent(id);
  if (!e) return;
  updateEvent(id, { exdates: [...new Set([...(e.exdates || []), date])] });
}

/** Change just one occurrence: it becomes its own event, and the series skips that date. */
export function detachOccurrence(id, date, patch = {}) {
  const e = getEvent(id);
  if (!e) return null;
  const { repeat, exdates, id: _id, createdAt, updatedAt, ...rest } = e;
  deleteOccurrence(id, date);
  return addEvent({ ...rest, date, ...patch, repeat: null, exdates: [], seriesId: id });
}

/* ---------- Habits ---------- */
export const habits = () => db.habits.filter((h) => !h.deleted);
export const getHabit = (id) => db.habits.find((h) => h.id === id);

export function addHabit(fields) {
  const now = Date.now();
  const h = {
    id: uid(), name: '', icon: '✅', color: '#4f6bed', days: [0, 1, 2, 3, 4, 5, 6],
    goal: 1, remind: null, log: {}, archived: false, createdAt: now, updatedAt: now, ...fields,
  };
  db.habits.push(h);
  changed();
  return h;
}

export function updateHabit(id, patch) {
  const h = getHabit(id);
  if (!h) return null;
  Object.assign(h, patch, { updatedAt: Date.now() });
  changed();
  return h;
}

export const habitCount = (h, date) => h.log?.[date]?.c || 0;
export const isScheduled = (h, date) => !h.days?.length || h.days.includes(new Date(date + 'T12:00').getDay());

export function setHabitCount(id, date, c) {
  const h = getHabit(id);
  if (!h) return;
  h.log = { ...h.log, [date]: { c, t: Date.now() } };
  changed();
}

export function cycleHabit(id, date) {
  const h = getHabit(id);
  if (!h) return;
  const c = habitCount(h, date);
  setHabitCount(id, date, c >= (h.goal || 1) ? 0 : c + 1);
}

export function habitStats(h) {
  const done = (d) => habitCount(h, d) >= (h.goal || 1);
  const t = today();
  // current streak: scheduled days completed, counting back (today may still be pending)
  let cur = 0;
  let d = done(t) || !isScheduled(h, t) ? t : addDays(t, -1);
  for (let i = 0; i < 3650; i++, d = addDays(d, -1)) {
    if (!isScheduled(h, d)) continue;
    if (!done(d)) break;
    cur++;
  }
  // best streak + total over the log range
  const dates = Object.keys(h.log || {}).filter((k) => habitCount(h, k) > 0).sort();
  let best = 0, run = 0, total = 0;
  if (dates.length) {
    for (let x = dates[0]; x <= t; x = addDays(x, 1)) {
      if (done(x)) { total++; run++; best = Math.max(best, run); } else if (isScheduled(h, x) && x !== t) run = 0;
    }
  }
  // this month completion rate
  const mStart = t.slice(0, 8) + '01';
  let sched = 0, hit = 0;
  for (let x = mStart; x <= t; x = addDays(x, 1)) {
    if (!isScheduled(h, x)) continue;
    sched++;
    if (done(x)) hit++;
  }
  return { current: cur, best: Math.max(best, cur), total, monthRate: sched ? Math.round((hit / sched) * 100) : 0 };
}

/* ---------- Sync helpers ---------- */
export function applyRemote(remote, revAtSend) {
  const merged = mergeState(db, remote);
  db.tasks = merged.tasks;
  db.habits = merged.habits;
  db.events = merged.events;
  if (revAtSend === undefined || db.rev === revAtSend) db.dirty = false;
  persist();
  emit('remote');
}

export function replaceAll(data) {
  const now = Date.now();
  // Import: bump timestamps so the import wins on other devices too
  db.tasks = (data.tasks || []).map((t) => ({ ...t, updatedAt: now }));
  db.habits = (data.habits || []).map((h) => ({ ...h, updatedAt: now }));
  db.events = (data.events || []).map((e) => ({ ...e, updatedAt: now }));
  changed();
}

export function clearCompleted() {
  const now = Date.now();
  db.tasks.forEach((t) => { if (t.done && !t.deleted) Object.assign(t, { deleted: true, updatedAt: now }); });
  changed();
}

/* ---------- First-run sample data ---------- */
if (!db.seeded) {
  db.seeded = true;
  const t = today();
  const now = Date.now();
  const mk = (title, extra) => ({ id: uid(), title, notes: '', date: null, time: null, important: false, urgent: false, done: false, doneAt: null, repeat: '', remind: null, createdAt: now, updatedAt: now, ...extra });
  db.tasks.push(
    mk('Welcome! Tap the box to complete a task', { date: t, important: true, urgent: true }),
    mk('Try quick add: "Gym tomorrow 6pm !2"', { date: t, important: true }),
    mk('Drag tasks between quadrants in the Matrix', { date: addDays(t, 1), urgent: true }),
    mk('Set up notifications in Settings', { date: addDays(t, 2) }),
  );
  db.habits.push(
    { id: uid(), name: 'Drink water', icon: '💧', color: '#3b82f6', days: [0, 1, 2, 3, 4, 5, 6], goal: 4, remind: null, log: {}, archived: false, createdAt: now, updatedAt: now },
    { id: uid(), name: 'Read 20 minutes', icon: '📚', color: '#f5a524', days: [0, 1, 2, 3, 4, 5, 6], goal: 1, remind: null, log: {}, archived: false, createdAt: now, updatedAt: now },
  );
  persist();
}
