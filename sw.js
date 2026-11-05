/* Productivity++ service worker: offline cache, push reminders, notification clicks, Windows widgets. */
const VERSION = 'v1.8.2';
const SHELL_CACHE = `ppp-shell-${VERSION}`;
const CONFIG_CACHE = 'ppp-config';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/util.js', 'js/dates.js', 'js/shared.js', 'js/store.js', 'js/parse.js', 'js/sync.js',
  'js/notify.js', 'js/icons.js', 'js/ui.js', 'js/drag.js', 'js/gcal.js', 'js/events.js',
  'js/views/tasks.js', 'js/views/calendar.js', 'js/views/matrix.js', 'js/views/habits.js', 'js/views/settings.js', 'js/views/timegrid.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-72.png', 'icons/apple-touch-icon.png',
  'widgets/today-template.json',
];
const scoped = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so the offline copy is one consistent version
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ppp-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Widget data written by the app
  if (url.href.split('?')[0] === scoped('widgets/data.json')) {
    e.respondWith((async () => (await (await caches.open(CONFIG_CACHE)).match(scoped('widgets/data.json'))) || fetch(req))());
    return;
  }
  // Navigations: network first (fresh deploys), fall back to cached shell offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match(scoped('index.html'))) || (await caches.match(scoped('./')))));
    return;
  }
  // Assets: network first (always the files of one deploy), cached copy when offline.
  // Serving cached-then-updating copies could mix old and new modules and break the app.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});

/* ---------- Push ---------- */
async function getConfig() {
  const r = await (await caches.open(CONFIG_CACHE)).match(scoped('__config.json'));
  return r ? r.json() : null;
}

async function handlePush(event) {
  let items = [];
  try { const d = event.data?.json(); if (d) items = [].concat(d); } catch { /* payload-less push */ }
  if (!items.length) {
    const cfg = await getConfig();
    if (cfg?.apiUrl) {
      try {
        const r = await fetch(`${cfg.apiUrl}/due`, { headers: { Authorization: `Bearer ${cfg.apiToken}` } });
        if (r.ok) items = await r.json();
      } catch { /* offline */ }
    }
  }
  if (!items.length) items = [{ title: 'Productivity++', body: 'You have a reminder', tag: 'generic', url: './' }];
  await Promise.all(items.map((n) => self.registration.showNotification(n.title, {
    body: n.body,
    tag: n.tag,
    icon: scoped('icons/icon-192.png'),
    badge: scoped('icons/badge-72.png'),
    data: { url: n.url || './', kind: n.kind, id: n.id, date: n.date },
    actions: n.kind === 'habit' ? [{ action: 'check', title: '✓ Done' }] : n.kind === 'task' ? [{ action: 'open', title: 'Open' }] : [],
  })));
}
self.addEventListener('push', (e) => e.waitUntil(handlePush(e)));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  let target = d.url || './';
  if (e.action === 'check' && d.kind === 'habit') target = `./#/check/${d.id}/${d.date}`;
  const url = scoped(target);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        return w.navigate ? w.navigate(url).catch(() => {}) : undefined;
      }
    }
    return self.clients.openWindow(url);
  })());
});

/* ---------- Windows 11 widgets (Edge) ---------- */
async function renderWidget(widget) {
  const tpl = await (await fetch(scoped(widget.definition.msAcTemplate))).text();
  const data = await (await fetch(scoped(widget.definition.data))).text();
  await self.widgets.updateByTag(widget.definition.tag, { template: tpl, data });
}
async function refreshWidgets() {
  if (!self.widgets) return;
  const w = await self.widgets.getByTag('today');
  if (w) await renderWidget(w);
}
self.addEventListener('widgetinstall', (e) => e.waitUntil(renderWidget(e.widget)));
self.addEventListener('widgetresume', (e) => e.waitUntil(renderWidget(e.widget)));
self.addEventListener('widgetclick', (e) => {
  if (e.action === 'open') e.waitUntil(self.clients.openWindow(scoped('./#/today')));
});
self.addEventListener('periodicsync', (e) => { if (e.tag === 'widget-today') e.waitUntil(refreshWidgets()); });
self.addEventListener('message', (e) => {
  if (e.data?.type === 'refresh-widgets') e.waitUntil(refreshWidgets());
});
