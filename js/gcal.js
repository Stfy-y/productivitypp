// Google Calendar integration (through the sync worker, which holds the Google sign-in).
import { db, settings, saveSettings, updateTask } from './store.js';
import { api } from './sync.js';
import { ymd, addMonths, pad } from './dates.js';

const CK = 'ppp-gcal-cache-v1';
const FRESH_MS = 5 * 60 * 1000;
let cache = (() => { try { return JSON.parse(localStorage.getItem(CK)) || {}; } catch { return {}; } })();
const inflight = new Set();
let onUpdate = () => {};
export const setGcalListener = (fn) => { onUpdate = fn; };
export const gcalOn = () => !!(settings.apiUrl && settings.gcal?.connected);
export let calendars = null; // loaded on demand for Settings

const saveCache = () => { try { localStorage.setItem(CK, JSON.stringify(cache)); } catch { /* quota */ } };
export function clearGcalCache() { cache = {}; saveCache(); }

export async function refreshGcalStatus() {
  if (!settings.apiUrl) return;
  try {
    const s = await api('/gcal/status');
    const was = settings.gcal?.connected;
    saveSettings({ gcal: s });
    if (!s.connected) clearGcalCache();
    if (s.connected && !was) { clearGcalCache(); onUpdate(); }
  } catch { /* worker without gcal routes or offline */ }
}

export async function connectGcal() {
  const ret = location.href.split('#')[0] + '#/settings';
  const { url } = await api(`/gcal/auth-url?return=${encodeURIComponent(ret)}`);
  const w = window.open(url, '_blank');
  if (!w) location.href = url;
}

export async function disconnectGcal() {
  await api('/gcal/disconnect', { method: 'POST', body: '{}' });
  // Unlink tasks locally (events already in Google stay there)
  for (const t of db.tasks) if (t.gcal) updateTask(t.id, { gcal: null });
  calendars = null;
  clearGcalCache();
  saveSettings({ gcal: { ...settings.gcal, connected: false, email: '' } });
}

export async function loadCalendars() {
  calendars = await api('/gcal/calendars');
  onUpdate();
  return calendars;
}

export async function saveGcalPrefs(patch) {
  const prefs = await api('/gcal/prefs', { method: 'PUT', body: JSON.stringify(patch) });
  if (patch.show && calendars) calendars.forEach((c) => { c.show = patch.show.includes(c.id); });
  if (prefs.target) saveSettings({ gcal: { ...settings.gcal, target: prefs.target } });
  clearGcalCache();
  onUpdate();
}

/* ---------- Events ---------- */
const monthKey = (d) => d.slice(0, 7);

/** Make sure events covering [start, end] are loaded; re-renders when new data arrives. */
export function ensureRange(start, end) {
  if (!gcalOn()) return;
  for (let m = start.slice(0, 8) + '01'; monthKey(m) <= monthKey(end); m = addMonths(m, 1)) {
    const k = monthKey(m);
    if (!cache[k] || Date.now() - cache[k].ts > FRESH_MS) fetchMonth(k);
  }
}

async function fetchMonth(k) {
  if (inflight.has(k) || !navigator.onLine) return;
  inflight.add(k);
  try {
    const [y, m] = k.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const events = await api(`/gcal/events?start=${k}-01&end=${k}-${pad(last)}`);
    const changed = JSON.stringify(cache[k]?.events) !== JSON.stringify(events);
    cache[k] = { ts: Date.now(), events };
    saveCache();
    if (changed) onUpdate();
  } catch (e) {
    if (/409/.test(e.message)) refreshGcalStatus();
    console.warn('Google Calendar fetch failed', e);
  } finally {
    inflight.delete(k);
  }
}

const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Google events on a local date (tasks already linked to an event are hidden to avoid duplicates). */
export function eventsOn(date) {
  if (!gcalOn()) return [];
  const linked = new Set(db.tasks.filter((t) => t.gcal?.id && !t.deleted).map((t) => t.gcal.id));
  const keys = [addMonths(date.slice(0, 8) + '01', -1), date, addMonths(date.slice(0, 8) + '01', 1)].map(monthKey);
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    for (const e of cache[k]?.events || []) {
      const key = `${e.cal}|${e.id}`;
      if (seen.has(key) || linked.has(e.id)) continue;
      let ev = null;
      if (e.allDay) {
        if (e.start <= date && date < e.end) ev = { ...e, time: null, endTime: null };
      } else {
        const s = new Date(e.start), en = new Date(e.end);
        const sd = ymd(s), ed = ymd(new Date(en - 1));
        if (sd <= date && date <= ed) ev = { ...e, time: sd === date ? hm(s) : null, endTime: ed === date ? hm(en) : null, allDay: sd !== date && ed !== date };
      }
      if (ev) { seen.add(key); out.push(ev); }
    }
  }
  return out.sort((a, b) => (b.allDay - a.allDay) || (a.time || '').localeCompare(b.time || ''));
}

/* ---------- Tasks → Google Calendar ---------- */
// task.gcal = { want: true|false, cal, id, sig }. We reconcile after any change.
const sig = (t) => [t.title, t.notes, t.date, t.time].join('|');
let rtimer = null;
let running = false;

export function scheduleReconcile() {
  if (!gcalOn()) return;
  clearTimeout(rtimer);
  rtimer = setTimeout(reconcile, 1500);
}

async function reconcile() {
  if (running) { scheduleReconcile(); return; }
  running = true;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    for (const t of [...db.tasks]) {
      const g = t.gcal;
      if (!g) continue;
      const shouldExist = g.want && !t.deleted && !!t.date;
      if (!shouldExist) {
        if (g.id) await api('/gcal/task/delete', { method: 'POST', body: JSON.stringify({ cal: g.cal, id: g.id }) });
        updateTask(t.id, { gcal: null });
      } else if (!g.id) {
        const r = await api('/gcal/task', { method: 'POST', body: JSON.stringify({ task: t, tz }) });
        updateTask(t.id, { gcal: { want: true, cal: r.cal, id: r.id, sig: sig(t) } });
      } else if (g.sig !== sig(t)) {
        const r = await api('/gcal/task', { method: 'PUT', body: JSON.stringify({ task: t, tz, cal: g.cal, id: g.id }) });
        updateTask(t.id, { gcal: { want: true, cal: r.cal, id: r.id, sig: sig(t) } });
      }
    }
  } catch (e) {
    console.warn('Google Calendar update failed', e);
  } finally {
    running = false;
  }
}
