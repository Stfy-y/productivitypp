import { db, settings, saveSettings, tasks, habits, quadrant, habitCount, isScheduled } from './store.js';
import { remindersAt, localMinuteKey, shiftMinutes } from './shared.js';
import { api, writeSwConfig } from './sync.js';
import { b64urlToBytes } from './util.js';
import { today, fmtTime } from './dates.js';

export const canNotify = () => 'Notification' in window && 'serviceWorker' in navigator;
export const canPush = () => canNotify() && 'PushManager' in window;

export async function requestPermission() {
  if (!canNotify()) return 'unsupported';
  const r = await Notification.requestPermission();
  saveSettings({ notify: r === 'granted' });
  return r;
}

async function show(n) {
  const reg = await navigator.serviceWorker.ready;
  return reg.showNotification(n.title, {
    body: n.body, tag: n.tag, data: { url: n.url || './' },
    icon: 'icons/icon-192.png', badge: 'icons/badge-72.png',
  });
}

export const testLocal = () => show({ title: 'Productivity++', body: 'Notifications are working 🎉', tag: 'test' });

/* In-app scheduler: fires reminders while the app is open (or a laptop tab is in the background).
   Background delivery when the app is closed comes from the optional push worker. */
const LAST = 'ppp-last-minute';
async function tick() {
  if (!settings.notify || !canNotify() || Notification.permission !== 'granted') return;
  const now = localMinuteKey();
  let from = localStorage.getItem(LAST);
  const floor = shiftMinutes(now, -2); // small catch-up window only
  if (!from || from < floor) from = floor; else from = shiftMinutes(from, 1);
  const state = { tasks: db.tasks, habits: db.habits };
  for (let k = from; k <= now; k = shiftMinutes(k, 1)) {
    for (const n of remindersAt(state, k, settings.remindAllDay)) show(n).catch(console.error);
  }
  localStorage.setItem(LAST, now);
}
export function startScheduler() {
  tick();
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', tick);
}

/* ---------- Background push via the sync worker ---------- */
export async function enablePush() {
  if (!canPush()) throw new Error('Push is not supported here. On iPhone, install the app to the Home Screen first.');
  if (Notification.permission !== 'granted') {
    const r = await requestPermission();
    if (r !== 'granted') throw new Error('Notification permission was not granted');
  }
  const { publicKey } = await api('/vapid');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options?.applicationServerKey;
    const same = cur && btoa(String.fromCharCode(...new Uint8Array(cur))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === publicKey;
    if (!same) { await sub.unsubscribe(); sub = null; }
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await api('/subscribe', { method: 'POST', body: JSON.stringify({ sub: sub.toJSON(), device: deviceName() }) });
  await writeSwConfig();
  saveSettings({ push: true, notify: true });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe();
  }
  saveSettings({ push: false });
}

export const testPush = () => api('/test-push', { method: 'POST', body: '{}' });

function deviceName() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac/i.test(ua)) return 'Mac';
  return 'Linux';
}

/* ---------- App badge + Windows widget data ---------- */
export async function refreshBadgeAndWidget() {
  const t = today();
  const due = tasks().filter((x) => !x.done && x.date && x.date <= t);
  try {
    if ('setAppBadge' in navigator) due.length ? navigator.setAppBadge(due.length) : navigator.clearAppBadge();
  } catch { /* ignore */ }
  if (!('caches' in window)) return;
  const hs = habits().filter((h) => !h.archived && isScheduled(h, t));
  const data = {
    date: new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }),
    summary: `${due.length} task${due.length === 1 ? '' : 's'} · ${hs.filter((h) => habitCount(h, t) >= (h.goal || 1)).length}/${hs.length} habits`,
    tasks: due.sort((a, b) => quadrant(a) - quadrant(b)).slice(0, 6).map((x) => ({
      title: x.title, when: x.date < t ? 'Overdue' : (x.time ? fmtTime(x.time) : ''), q: quadrant(x),
    })),
    habits: hs.map((h) => ({ name: `${h.icon} ${h.name}`, done: habitCount(h, t) >= (h.goal || 1) })),
  };
  const c = await caches.open('ppp-config');
  await c.put('./widgets/data.json', new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  navigator.serviceWorker?.controller?.postMessage({ type: 'refresh-widgets' });
}
