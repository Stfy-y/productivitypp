import { esc, isIOS, isStandalone } from '../util.js';
import { icon } from '../icons.js';
import { settings } from '../store.js';
import { canNotify, canPush } from '../notify.js';
import { calendars, loadCalendars } from '../gcal.js';

export const VERSION = '1.6.1';
export const install = { prompt: null };

const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ts).toLocaleString();
};

let calLoading = false;
function gcalCard(connected) {
  const g = settings.gcal || {};
  let body;
  if (!connected) body = `<p>Connect the sync server above first. Google Calendar goes through it, so you sign in once and every device sees your events.</p>`;
  else if (g.configured === false) body = `<p>Your worker doesn't have Google credentials yet. Follow the <a href="worker/#google-calendar" target="_blank" rel="noopener">Google Calendar setup</a> (about 10 min, free), then tap Refresh.</p>
    <div class="row-actions"><button class="btn" data-action="gcal-refresh">Refresh</button></div>`;
  else if (!g.connected) body = `<p>See your Google events in Calendar, Today and Next 7 Days, and send tasks to Google Calendar.</p>
    <div class="row-actions"><button class="btn primary" data-action="gcal-connect">Connect Google Calendar</button><button class="btn ghost" data-action="gcal-refresh">I've connected, refresh</button></div>`;
  else {
    if (!calendars && !calLoading) {
      calLoading = true;
      loadCalendars().catch(() => {}).finally(() => { calLoading = false; });
    }
    const list = calendars
      ? calendars.map((c) => `<label class="cal-item"><input type="checkbox" data-gcal-show="${esc(c.id)}" ${c.show ? 'checked' : ''}>
          <i style="background:${esc(c.color)}"></i><span>${esc(c.name)}</span></label>`).join('')
      : '<p class="small faint">Loading calendars…</p>';
    const writable = (calendars || []).filter((c) => c.writable);
    body = `<p class="ok small">✓ Connected${g.email ? ` as <b>${esc(g.email)}</b>` : ''}</p>
      <div class="field-label">Show these calendars</div><div class="cal-list">${list}</div>
      ${writable.length ? `<label class="row">Add tasks to<select data-gcal-target>${writable.map((c) => `<option value="${esc(c.id)}" ${(g.target === c.id || (g.target === 'primary' && c.primary)) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      <p class="small faint">To put a task in Google Calendar, open it and tick “Add to Google Calendar”.</p>
      <div class="row-actions"><button class="btn" data-action="gcal-reload">Reload events</button><button class="btn ghost danger" data-action="gcal-disconnect">Disconnect</button></div>`;
  }
  const problem = connected && g.problem ? `<p class="warn small">⚠ ${esc(g.problem)}</p>` : '';
  const debug = connected && g.configured && !g.connected && g.clientIdEnd
    ? `<p class="small faint">Worker is using Client ID …${esc(g.clientIdEnd)}<br>Redirect URI to register in Google: <code>${esc(g.redirectUri || '')}</code></p>` : '';
  return `<section class="card"><h3>${icon('calendar')} Google Calendar</h3>${problem}${body}${debug}</section>`;
}

export function renderSettings() {
  const perm = canNotify() ? Notification.permission : 'unsupported';
  const connected = !!settings.apiUrl;
  const widgetUrl = connected ? `${settings.apiUrl.replace(/\/+$/, '')}/widget?token=${encodeURIComponent(settings.apiToken)}` : '';

  let installBlock;
  if (isStandalone()) installBlock = `<p class="ok">✓ Running as an installed app.</p>`;
  else if (install.prompt) installBlock = `<p>Install for a full-screen app with its own icon.</p><button class="btn primary" data-action="install">${icon('download')} Install app</button>`;
  else if (isIOS()) installBlock = `<p>On iPhone/iPad: open this page in <b>Safari</b>, tap <b>Share</b> → <b>Add to Home Screen</b>. Notifications on iOS only work from the installed app.</p>`;
  else installBlock = `<p>Use your browser menu → <b>Install app</b> / <b>Add to Home screen</b>.</p>`;

  return `<div class="settings">
  <section class="card"><h3>Install</h3>${installBlock}</section>

  <section class="card"><h3>Appearance</h3>
    <label class="row">Theme<select data-setting="theme">
      ${['auto', 'light', 'dark'].map((v) => `<option ${settings.theme === v ? 'selected' : ''} value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label>
    <label class="row">Week starts on<select data-setting="weekStart">
      <option value="1" ${settings.weekStart === 1 ? 'selected' : ''}>Monday</option><option value="0" ${settings.weekStart === 0 ? 'selected' : ''}>Sunday</option></select></label>
    <label class="row">Day starts (free time counted from)<input type="time" data-setting="dayStart" value="${settings.dayStart}"></label>
    <label class="row">Day ends<input type="time" data-setting="dayEnd" value="${settings.dayEnd}"></label>
  </section>

  <section class="card"><h3>⌨️ Keyboard shortcuts</h3>
    <p class="small">Click a shortcut, then press the keys you want (letters, or combos like <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>). <kbd>Backspace</kbd> turns it off, <kbd>Esc</kbd> cancels. Some browser shortcuts, like <kbd>Ctrl</kbd>+<kbd>N</kbd>, can't be taken over.</p>
    <div class="row">Quick add task<button class="btn small shortcut-btn" data-action="shortcut-record" data-which="task">${settings.shortcuts.task ? settings.shortcuts.task.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('+') : 'Off'}</button></div>
    <div class="row">Quick add event<button class="btn small shortcut-btn" data-action="shortcut-record" data-which="event">${settings.shortcuts.event ? settings.shortcuts.event.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('+') : 'Off'}</button></div>
    <div class="row-actions"><button class="btn ghost small" data-action="shortcut-reset">Reset to N / E</button></div>
  </section>

  <section class="card"><h3>${icon('bell')} Notifications</h3>
    ${perm === 'unsupported' ? `<p class="warn">Notifications aren't available here.${isIOS() && !isStandalone() ? ' Install the app to your Home Screen first.' : ''}</p>` : `
    <p>Permission: <b>${perm}</b>. Reminders fire while the app is open. For reminders when it's <i>closed</i>, connect the free sync server below and turn on background push.</p>
    <div class="row-actions">
      ${perm !== 'granted' ? `<button class="btn primary" data-action="notify-enable">Enable notifications</button>` : `<button class="btn" data-action="notify-test">Send test notification</button>`}
    </div>`}
    <label class="row">Reminder time for tasks without a time<input type="time" data-setting="remindAllDay" value="${settings.remindAllDay}"></label>
  </section>

  <section class="card"><h3>${icon('cloud')} Sync &amp; background push <span class="tag">optional · free</span></h3>
    <p>Keeps phone and laptop in sync and sends reminders when the app is closed. Uses your own free Cloudflare Worker. <a href="worker/" target="_blank" rel="noopener">Setup guide (5 min)</a></p>
    <form id="sync-form" class="stack" autocomplete="off">
      <label>Worker URL<input name="apiUrl" type="url" placeholder="https://productivity-sync.yourname.workers.dev" value="${esc(settings.apiUrl)}"></label>
      <label>Secret token<input name="apiToken" type="password" placeholder="The TOKEN you set in Cloudflare" value="${esc(settings.apiToken)}"></label>
      <div class="row-actions">
        <button class="btn primary" type="submit">${connected ? 'Save & reconnect' : 'Connect'}</button>
        ${connected ? `<button class="btn" type="button" data-action="sync-now">Sync now</button><button class="btn ghost danger" type="button" data-action="sync-disconnect">Disconnect</button>` : ''}
      </div>
    </form>
    ${connected ? `<p class="small">Last sync: ${ago(settings.lastSync)}${settings.syncError ? ` · <span class="warn">${esc(settings.syncError)}</span>` : ''}</p>
    <div class="sub"><b>Background push on this device</b>
      ${!canPush() ? `<p class="warn small">Not supported in this browser${isIOS() && !isStandalone() ? '. Install to Home Screen first (iOS 16.4+)' : ''}.</p>` : settings.push
        ? `<p class="ok small">✓ Enabled</p><div class="row-actions"><button class="btn" data-action="push-test">Send test push</button><button class="btn ghost" data-action="push-disable">Turn off</button></div>`
        : `<div class="row-actions"><button class="btn primary" data-action="push-enable">Enable background push</button></div>`}
    </div>` : ''}
  </section>

  ${gcalCard(connected)}

  <section class="card"><h3>Widgets</h3>
    <ul class="plain">
      <li><b>Android:</b> long-press the app icon for shortcuts (Add task, Add event, Today, Matrix, Habits), and drag any of them onto your home screen.</li>
      <li><b>iPhone:</b> install the free <i>Scriptable</i> app and use <a href="extras/scriptable-widget.js" target="_blank">this widget script</a> (needs sync).</li>
      <li><b>Windows 11:</b> install the app with Edge; it shows up in the Widgets board.</li>
    </ul>
    ${connected ? `<label>Your widget data URL (keep private)<div class="copy"><input readonly value="${esc(widgetUrl)}"><button class="btn small" data-action="copy" data-value="${esc(widgetUrl)}">Copy</button></div></label>` : '<p class="small faint">Connect sync to get a widget data URL.</p>'}
  </section>

  <section class="card"><h3>Data</h3>
    <p class="small">Everything is stored on this device${connected ? ' and in your sync worker' : ''}. Back it up now and then.</p>
    <div class="row-actions">
      <button class="btn" data-action="export">${icon('download')} Export JSON</button>
      <label class="btn">Import JSON<input type="file" accept="application/json" data-action="import" hidden></label>
      <button class="btn ghost danger" data-action="reset">Erase this device</button>
    </div>
  </section>
  <p class="center faint small">Productivity++ v${VERSION} · <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · free &amp; open</p>
  </div>`;
}
