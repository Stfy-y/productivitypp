import { $, $$, toast } from './util.js';
import { icon } from './icons.js';
import { today } from './dates.js';
import {
  db, settings, saveSettings, subscribe, updateTask, quadFlags, getHabit, updateHabit, cycleHabit,
  clearCompleted, replaceAll,
} from './store.js';
import { openQuickAdd, openTaskEditor, openHabitEditor, doToggle, confirmDialog, closeSheet } from './ui.js';
import { enableDrag } from './drag.js';
import { renderList, LISTS } from './views/tasks.js';
import { renderCalendar, calAction, calSelected } from './views/calendar.js';
import { renderMatrix, toggleMatrixDone } from './views/matrix.js';
import { renderHabits, renderHabitDetail, habitAction } from './views/habits.js';
import { renderSettings, install } from './views/settings.js';
import { scheduleSync, syncNow, connect, writeSwConfig } from './sync.js';
import {
  requestPermission, testLocal, startScheduler, enablePush, disablePush, testPush, refreshBadgeAndWidget,
} from './notify.js';
import {
  setGcalListener, refreshGcalStatus, connectGcal, disconnectGcal, clearGcalCache, saveGcalPrefs, scheduleReconcile,
} from './gcal.js';

/* ---------- Navigation ---------- */
const NAV = [
  { key: 'today', title: 'Today', icon: 'today' },
  { key: 'week', title: 'Next 7 Days', icon: 'week' },
  { key: 'inbox', title: 'All Tasks', icon: 'inbox' },
  { key: 'calendar', title: 'Calendar', icon: 'calendar' },
  { key: 'matrix', title: 'Matrix', icon: 'matrix' },
  { key: 'habits', title: 'Habits', icon: 'habits' },
  { key: 'done', title: 'Completed', icon: 'done' },
  { key: 'settings', title: 'Settings', icon: 'settings' },
];
const TABS = [
  { key: 'today', title: 'Tasks', icon: 'today', match: ['today', 'week', 'inbox', 'done'] },
  { key: 'calendar', title: 'Calendar', icon: 'calendar' },
  { key: 'matrix', title: 'Matrix', icon: 'matrix' },
  { key: 'habits', title: 'Habits', icon: 'habits', match: ['habits', 'habit'] },
  { key: 'settings', title: 'Settings', icon: 'settings' },
];

$('#sidebar').innerHTML = `<div class="brand">${'<img src="icons/icon.svg" alt="" width="28" height="28">'}<span>Productivity++</span></div>
  <button class="btn primary block" data-action="quick-add">${icon('plus')} Add task</button>
  <nav>${NAV.map((n) => `<a href="#/${n.key}" data-nav="${n.key}">${icon(n.icon)}<span>${n.title}</span><em class="badge" data-badge="${n.key}"></em></a>`).join('')}</nav>`;
$('#tabbar').innerHTML = TABS.map((t) => `<a href="#/${t.key}" data-tab="${t.key}">${icon(t.icon)}<span>${t.title}</span></a>`).join('');
$('#fab').innerHTML = icon('plus');

let route = { name: 'today', arg: null };
let lastViewHash = '#/today';

function parseRoute() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'today', arg: rest.join('/') || null };
}

function onRoute() {
  const r = parseRoute();
  if (r.name === 'task') {
    history.replaceState(null, '', lastViewHash);
    route = parseRoute();
    render();
    openTaskEditor(r.arg);
    return;
  }
  if (r.name === 'add') { history.replaceState(null, '', '#/today'); route = parseRoute(); render(); openQuickAdd({ date: today() }); return; }
  if (r.name === 'check') {
    const [id, date] = (r.arg || '').split('/');
    if (getHabit(id)) cycleHabit(id, date || today());
    history.replaceState(null, '', '#/habits');
    route = parseRoute();
    render();
    return;
  }
  closeSheet();
  route = r;
  lastViewHash = location.hash || '#/today';
  $('#view').scrollTop = 0;
  $('#main').scrollTop = 0;
  render();
}

/* ---------- Render ---------- */
function render() {
  const { name, arg } = route;
  let title = NAV.find((n) => n.key === name)?.title || '';
  let html = '';
  let actions = '';
  if (LISTS[name]) html = renderList(name);
  else if (name === 'calendar') html = renderCalendar();
  else if (name === 'matrix') { html = renderMatrix(); title = 'Eisenhower Matrix'; }
  else if (name === 'habits') { html = renderHabits(); actions = `<button class="icon-btn" data-action="habit-new" aria-label="New habit">${icon('plus')}</button>`; }
  else if (name === 'habit') { html = renderHabitDetail(arg); title = 'Habit'; }
  else if (name === 'settings') html = renderSettings();
  else { html = renderList('today'); title = 'Today'; }

  $('#view-title').textContent = title;
  $('#view-actions').innerHTML = actions;
  $('#view').innerHTML = html;
  $('#view').dataset.view = name;
  document.body.dataset.view = name;
  $('#fab').hidden = ['settings', 'habit', 'habits'].includes(name);

  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name || (name === 'habit' && a.dataset.nav === 'habits')));
  $$('[data-tab]').forEach((a) => {
    const t = TABS.find((x) => x.key === a.dataset.tab);
    a.classList.toggle('on', (t.match || [t.key]).includes(name));
  });
  updateBadges();
}

function updateBadges() {
  const t = today();
  const open = db.tasks.filter((x) => !x.deleted && !x.done);
  const counts = {
    today: open.filter((x) => x.date && x.date <= t).length,
    inbox: open.length,
  };
  $$('[data-badge]').forEach((b) => { b.textContent = counts[b.dataset.badge] || ''; });
}

/* ---------- Actions ---------- */
function quickAddPreset(el) {
  if (el?.dataset.date) return { date: el.dataset.date };
  if (el?.dataset.quad) return { quad: +el.dataset.quad };
  if (route.name === 'today') return { date: today() };
  if (route.name === 'calendar') return { date: calSelected() };
  return {};
}

async function handleAction(action, el, e) {
  const id = el.dataset.id;
  switch (action) {
    case 'toggle-task': doToggle(id); break;
    case 'edit-task': openTaskEditor(id); break;
    case 'quick-add': openQuickAdd(quickAddPreset(el)); break;
    case 'clear-completed':
      if (await confirmDialog('Delete all completed tasks?')) clearCompleted();
      break;

    case 'habit-cycle': cycleHabit(id, el.dataset.date); navigator.vibrate?.(8); break;
    case 'habit-open': location.hash = `#/habit/${id}`; break;
    case 'habit-new': openHabitEditor(); break;
    case 'habit-edit': openHabitEditor(id); break;
    case 'habit-archive': updateHabit(id, { archived: !getHabit(id).archived }); break;
    case 'habit-delete':
      if (await confirmDialog(`Delete “${getHabit(id).name}” and its history?`)) { updateHabit(id, { deleted: true }); location.hash = '#/habits'; }
      break;
    case 'habit-date': case 'habit-month-prev': case 'habit-month-next': case 'habit-archived':
      habitAction(action, el); render(); break;

    case 'cal-mode': case 'cal-prev': case 'cal-next': case 'cal-today': case 'cal-select':
      calAction(action, el); render(); break;

    case 'matrix-done': toggleMatrixDone(); render(); break;

    case 'install':
      if (install.prompt) { install.prompt.prompt(); await install.prompt.userChoice; install.prompt = null; render(); }
      break;
    case 'notify-enable': {
      const r = await requestPermission();
      toast(r === 'granted' ? 'Notifications enabled' : 'Permission not granted');
      render(); break;
    }
    case 'notify-test': testLocal(); break;
    case 'sync-now': await syncNow(); toast(settings.syncError ? 'Sync failed' : 'Synced'); break;
    case 'sync-disconnect':
      if (settings.push) await disablePush().catch(() => {});
      saveSettings({ apiUrl: '', apiToken: '', lastSync: 0, syncError: '', push: false, gcal: null });
      await writeSwConfig(); render(); break;
    case 'push-enable':
      try { await enablePush(); toast('Background push enabled'); } catch (err) { toast(err.message, { ms: 6000 }); }
      render(); break;
    case 'push-disable': await disablePush(); render(); break;
    case 'push-test':
      try { await testPush(); toast('Test push sent. It should arrive in a few seconds.'); } catch (err) { toast(err.message, { ms: 6000 }); }
      break;
    case 'gcal-connect':
      try { await connectGcal(); toast('Finish signing in with Google, then come back here', { ms: 6000 }); } catch (err) { toast(err.message, { ms: 6000 }); }
      break;
    case 'gcal-refresh': await refreshGcalStatus(); render(); break;
    case 'gcal-reload': clearGcalCache(); render(); toast('Reloading Google events…'); break;
    case 'gcal-disconnect':
      if (await confirmDialog('Disconnect Google Calendar? Events already created in Google stay there.', 'Disconnect')) {
        try { await disconnectGcal(); } catch (err) { toast(err.message); }
        render();
      }
      break;
    case 'copy':
      await navigator.clipboard?.writeText(el.dataset.value); toast('Copied'); break;
    case 'export': {
      const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks: db.tasks, habits: db.habits }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `productivity-backup-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      break;
    }
    case 'reset':
      if (await confirmDialog('Erase all tasks, habits and settings on this device? Synced data on the server is kept.', 'Erase')) {
        localStorage.clear();
        location.reload();
      }
      break;
    default: return false;
  }
  return true;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#sheet-root')) return;
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  e.preventDefault();
  handleAction(el.dataset.action, el, e);
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.closest('#sheet-root')) return;
  if (el.dataset.action === 'matrix-done') return handleAction('matrix-done', el, e);
  if (el.dataset.action === 'import') {
    const file = el.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.tasks) || !Array.isArray(data.habits)) throw new Error('Not a Productivity++ backup');
      if (await confirmDialog(`Replace everything with ${data.tasks.length} tasks and ${data.habits.length} habits from the backup?`, 'Import')) {
        replaceAll(data); toast('Backup imported');
      }
    } catch (err) { toast(err.message); }
    el.value = '';
    return;
  }
  if (el.dataset.gcalShow !== undefined) {
    const show = $$('[data-gcal-show]').filter((c) => c.checked).map((c) => c.dataset.gcalShow);
    saveGcalPrefs({ show }).catch((err) => toast(err.message));
    return;
  }
  if (el.dataset.gcalTarget !== undefined) {
    saveGcalPrefs({ target: el.value }).then(() => toast('Saved')).catch((err) => toast(err.message));
    return;
  }
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    saveSettings({ [k]: k === 'weekStart' ? +el.value : el.value });
    if (k === 'remindAllDay') { db.dirty = true; scheduleSync(); }
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'sync-form') return;
  e.preventDefault();
  const f = e.target;
  const apiUrl = f.apiUrl.value.trim().replace(/\/+$/, '');
  const apiToken = f.apiToken.value.trim();
  if (!/^https:\/\//.test(apiUrl) || !apiToken) { toast('Enter the https:// worker URL and your token'); return; }
  saveSettings({ apiUrl, apiToken });
  try {
    await connect();
    if (settings.syncError) throw new Error(settings.syncError);
    toast('Connected and synced ✓');
  } catch (err) {
    toast(`Could not connect: ${err.message}`, { ms: 7000 });
  }
  render();
});

$('#fab').addEventListener('click', () => openQuickAdd(quickAddPreset()));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'q') { e.preventDefault(); openQuickAdd(quickAddPreset()); }
});

/* ---------- Drag & drop (matrix quadrants, calendar days, task groups) ---------- */
enableDrag($('#view'), (taskId, kind, value) => {
  if (kind === 'quad') updateTask(taskId, quadFlags(+value));
  if (kind === 'date') updateTask(taskId, { date: value || null, ...(value ? {} : { repeat: '', remind: null }) });
});

/* ---------- Theme ---------- */
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = settings.theme;
}

/* ---------- Store events ---------- */
subscribe((kind) => {
  if (kind === 'settings') {
    applyTheme();
    if (route.name === 'settings' && !document.activeElement?.closest('#sync-form')) render();
    return;
  }
  render();
  refreshBadgeAndWidget();
  if (kind === 'data') scheduleSync();
  scheduleReconcile();
});
setGcalListener(() => render());

/* ---------- PWA plumbing ---------- */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  install.prompt = e;
  if (route.name === 'settings') render();
});
window.addEventListener('appinstalled', () => { install.prompt = null; toast('Installed! Find it on your home screen.'); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    setInterval(() => reg.update(), 60 * 60 * 1000);
  }).catch((e) => console.warn('SW registration failed', e));
  let refreshing = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    toast('App updated', { action: 'Reload', onAction: () => location.reload(), ms: 10000 });
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { syncNow(); refreshGcalStatus().then(render); render(); }
});
window.addEventListener('online', () => syncNow());
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60 * 1000);

// Re-render after midnight so "Today" stays correct
let day = today();
setInterval(() => { if (today() !== day) { day = today(); render(); refreshBadgeAndWidget(); } }, 60 * 1000);

window.addEventListener('hashchange', onRoute);
applyTheme();
onRoute();
startScheduler();
refreshBadgeAndWidget();
syncNow();
if (settings.apiUrl) { writeSwConfig(); refreshGcalStatus().then(render); }
