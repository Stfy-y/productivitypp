import { db, settings, saveSettings, applyRemote, tasks, habits, deleteTask, updateHabit } from './store.js';

const base = () => settings.apiUrl.trim().replace(/\/+$/, '');

export async function api(path, opts = {}) {
  if (!settings.apiUrl) throw new Error('Sync server not configured');
  const res = await fetch(base() + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiToken}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

let timer = null;
let running = false;
let again = false;

export function scheduleSync(delay = 2500) {
  if (!settings.apiUrl) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export async function syncNow() {
  if (!settings.apiUrl || !navigator.onLine) return;
  if (running) { again = true; return; }
  running = true;
  try {
    const rev = db.rev;
    const remote = db.dirty
      ? await api('/state', {
        method: 'PUT',
        body: JSON.stringify({
          tasks: db.tasks, habits: db.habits,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          allDay: settings.remindAllDay,
        }),
      })
      : await api('/state');
    applyRemote(remote, rev);
    saveSettings({ lastSync: Date.now(), syncError: '' });
  } catch (e) {
    saveSettings({ syncError: String(e.message || e) });
  } finally {
    running = false;
    if (again) { again = false; scheduleSync(500); }
  }
}

/** First connection: drop untouched sample items if the server already has data. */
export async function connect() {
  const remote = await api('/state');
  const hasRemote = (remote.tasks?.length || 0) + (remote.habits?.length || 0) > 0;
  if (hasRemote) {
    for (const t of tasks()) if (t.createdAt === t.updatedAt && isSample(t)) deleteTask(t.id);
    for (const h of habits()) if (h.createdAt === h.updatedAt && isSample(h) && !Object.keys(h.log || {}).length) updateHabit(h.id, { deleted: true });
  }
  db.dirty = true;
  await syncNow();
  await writeSwConfig();
}

const SAMPLE = ['Welcome! Tap the box', 'Try quick add:', 'Drag tasks between', 'Set up notifications', 'Drink water', 'Read 20 minutes'];
const isSample = (x) => SAMPLE.some((s) => (x.title || x.name || '').startsWith(s));

/** The service worker can't read localStorage, so mirror what it needs into Cache Storage. */
export async function writeSwConfig(extra = {}) {
  if (!('caches' in window)) return;
  const c = await caches.open('ppp-config');
  await c.put('./__config.json', new Response(JSON.stringify({ apiUrl: base(), apiToken: settings.apiToken, ...extra }), { headers: { 'Content-Type': 'application/json' } }));
}
