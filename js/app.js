import { $, $$, toast } from './util.js';
import { icon } from './icons.js';
import { today } from './dates.js';
import {
  db, settings, saveSettings, subscribe, updateTask, updateEvent, getEvent, detachOccurrence, quadFlags, getHabit, updateHabit, cycleHabit,
  clearCompleted, replaceAll,
} from './store.js';
import { openQuickAdd, openTaskEditor, openHabitEditor, openEventSheet, openEventEditor, doToggle, confirmDialog, closeSheet } from './ui.js';
import { enableDrag, slotMinutesAt } from './drag.js';
import { afterTimeGrid, enableResize, updateNowLine, fromMin } from './views/timegrid.js';
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
  setGcalListener, findEvent, refreshGcalStatus, connectGcal, disconnectGcal, clearGcalCache, saveGcalPrefs, scheduleReconcile,
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
  <nav>${NAV.map((n) => `<a href="#/${n.key}" data-nav="${n.key}" aria-label="${n.title}">${icon(n.icon)}<span>${n.title}</span><em class="badge" data-badge="${n.key}"></em></a>`).join('')}</nav>`;
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
  if (r.name === 'add') { history.replaceState(null, '', '#/today'); route = parseRoute(); render(); openQuickAdd({ date: today(), kind: 'task' }); return; }
  if (r.name === 'add-event') { history.replaceState(null, '', '#/calendar'); route = parseRoute(); render(); openQuickAdd({ date: today(), kind: 'event' }); return; }
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
  try {
    renderView();
  } catch (err) {
    console.error(err);
    $('#view-title').textContent = NAV.find((n) => n.key === route.name)?.title || '';
    $('#view').innerHTML = `<div class="card error-card"><h3>⚠ This page couldn't be shown</h3>
      <p>Try a hard reload (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>). If it keeps happening, send this message:</p>
      <pre>${(String(err?.message || err) + '\n' + String(err?.stack || '')).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).slice(0, 1500)}</pre>
      <div class="row-actions"><button class="btn primary" onclick="location.reload()">Reload</button><a class="btn" href="#/today">Go to Today</a></div></div>`;
  }
}

function renderView() {
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
  if (name === 'calendar') afterTimeGrid($('#view'));
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
  const kind = route.name === 'calendar' ? 'event' : 'task';
  if (el?.dataset.date) return { date: el.dataset.date, kind };
  if (el?.dataset.quad) return { quad: +el.dataset.quad, kind: 'task' };
  if (route.name === 'today') return { date: today(), kind };
  if (route.name === 'calendar') return { date: calSelected(), kind };
  return { kind };
}

async function handleAction(action, el, e) {
  const id = el.dataset.id;
  switch (action) {
    case 'toggle-task': doToggle(id); break;
    case 'edit-task': openTaskEditor(id); break;
    case 'quick-add': openQuickAdd(quickAddPreset(el)); break;
    case 'edit-event': openEventEditor(id, el.dataset.date || null); break;
    case 'shortcut-record': startRecording(el.dataset.which); break;
    case 'shortcut-reset':
      saveSettings({ shortcuts: { task: 'N', event: 'E' } }); toast('Shortcuts reset'); break;
    case 'open-event': {
      const ev = findEvent(el.dataset.cal, el.dataset.id);
      if (ev) openEventSheet(ev); else toast('Event not found. Try Reload events in Settings.');
      break;
    }
    case 'tb-slot': {
      const m = Math.floor(slotMinutesAt(el, e.clientY, e.clientX) / 30) * 30;
      openQuickAdd({ date: el.dataset.date, time: fromMin(m), kind: 'event' });
      break;
    }
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

    case 'cal-mode': case 'cal-prev': case 'cal-next': case 'cal-today': case 'cal-select': case 'cal-day': case 'cal-axis':
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
      const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks: db.tasks, habits: db.habits, events: db.events }, null, 2)], { type: 'application/json' });
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
  const link = e.target.closest('a[href]');
  if (link && link !== el && el.contains(link)) return; // let links inside clickable areas work
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
      if (await confirmDialog(`Replace everything with ${data.tasks.length} tasks, ${(data.events || []).length} events and ${data.habits.length} habits from the backup?`, 'Import')) {
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

/* ---------- Keyboard shortcuts (configurable in Settings) ---------- */
const MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'];
function comboOf(e) {
  if (MODIFIERS.includes(e.key)) return null;
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && e.key.length !== 1 && 'Shift', e.shiftKey && e.key.length === 1 && /[a-z]/i.test(e.key) && 'Shift', e.metaKey && 'Meta', key]
    .filter(Boolean).join('+');
}
let recording = null;
function startRecording(which) {
  recording = which;
  const btn = document.querySelector(`[data-action="shortcut-record"][data-which="${which}"]`);
  if (btn) { btn.textContent = 'Press keys…'; btn.classList.add('recording'); }
}
document.addEventListener('keydown', (e) => {
  if (recording) {
    e.preventDefault();
    e.stopPropagation();
    const which = recording;
    if (e.key === 'Escape') { recording = null; render(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      recording = null; saveSettings({ shortcuts: { ...settings.shortcuts, [which]: '' } }); toast('Shortcut turned off'); return;
    }
    const combo = comboOf(e);
    if (!combo) return; // wait for a real key
    const other = which === 'task' ? 'event' : 'task';
    if (combo === settings.shortcuts[other]) { toast(`${combo} is already used for quick add ${other}`); return; }
    recording = null;
    saveSettings({ shortcuts: { ...settings.shortcuts, [which]: combo } });
    toast(`Quick add ${which}: ${combo}`);
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && ['open-event', 'edit-event'].includes(e.target.dataset?.action)) {
    e.preventDefault();
    handleAction(e.target.dataset.action, e.target, e);
    return;
  }
  const combo = comboOf(e);
  if (!combo) return;
  const plain = !/(Ctrl|Alt|Meta)\+/.test(combo);
  // plain-key shortcuts must not fire while typing or inside an open window
  if (plain && (e.target.closest('input, textarea, select, [contenteditable]') || e.target.closest('#sheet-root'))) return;
  const kind = combo === settings.shortcuts.task ? 'task' : combo === settings.shortcuts.event ? 'event' : null;
  if (!kind) return;
  e.preventDefault();
  openQuickAdd({ ...quickAddPreset(), kind });
}, true);

/* ---------- Drag & drop (matrix quadrants, calendar days, task groups) ---------- */
enableResize($('#view'));
enableDrag($('#view'), (dragId, kind, value, info) => {
  if (dragId.startsWith('ev:')) {
    const [id, occ] = dragId.slice(3).split('@');
    let patch = null;
    if (kind === 'slot') patch = { date: value, time: fromMin(slotMinutesAt(info.el, info.top, info.left)) };
    if (kind === 'allday') patch = { date: value, time: null };
    if (kind === 'date' && value) patch = { date: value };
    if (!patch) return; // events don't belong in the matrix or task lists
    const ev = getEvent(id);
    if (ev?.repeat?.freq && occ) {
      // dragging one occurrence moves only that occurrence (like Google Calendar)
      detachOccurrence(id, occ, patch);
      toast('Moved this event only');
    } else updateEvent(id, patch);
    return;
  }
  const taskId = dragId;
  if (kind === 'quad') updateTask(taskId, quadFlags(+value));
  if (kind === 'slot') updateTask(taskId, { date: value, time: fromMin(slotMinutesAt(info.el, info.top, info.left)) });
  if (kind === 'allday') updateTask(taskId, { date: value, time: null });
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
setInterval(updateNowLine, 60 * 1000);
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (route.name === 'calendar') render(); }, 250);
});

let day = today();
setInterval(() => { if (today() !== day) { day = today(); render(); refreshBadgeAndWidget(); } }, 60 * 1000);

window.addEventListener('hashchange', onRoute);
applyTheme();
onRoute();
startScheduler();
refreshBadgeAndWidget();
syncNow();
if (settings.apiUrl) { writeSwConfig(); refreshGcalStatus().then(render); }
window.__appStarted = true;
