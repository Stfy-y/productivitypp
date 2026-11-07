import { esc, isIOS, isStandalone } from '../util.js';
import { icon } from '../icons.js';
import { settings } from '../store.js';
import { canNotify, canPush } from '../notify.js';
import { calendars, loadCalendars } from '../gcal.js';
import { locationForm } from './dashboard.js';
import { musicError, installCommand, waitingForHelper, phoneInfo, ensurePhoneInfo, isLinuxDesktop, viaSync } from '../music.js';
import { whatsApp, waError, waInstallCommand, waWaiting, ensureWhatsApp } from '../whatsapp.js';

export const VERSION = '1.16.0';
export const install = { prompt: null };

const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ts).toLocaleString();
};

let calLoading = false;
/* ---------- Now playing on the phone ---------- */
/** On the computer with the helper: share the song with the phone through the sync server. */
function phoneBlock() {
  ensurePhoneInfo();
  const head = '<h4 class="np-phone-h">📱 On your phone</h4>';
  if (!settings.apiUrl) {
    return `${head}<p class="small">See what's playing here on your phone, with play/pause/skip and volume. It goes through your sync server, so first set up <b>Sync &amp; background push</b> below, here and on the phone.</p>`;
  }
  const r = phoneInfo;
  if (!r) return '';
  if (r.outdated) {
    return `${head}<p class="small">See what's playing here on your phone. First update the helper: run the setup command again.</p>
      <div class="copy"><input readonly value="${esc(installCommand())}" aria-label="Setup command"><button class="btn small" data-action="music-copy">Copy</button></div>`;
  }
  if (!r.enabled) {
    return `${head}<p class="small">See what's playing here on your phone, with play/pause/skip and volume. The song goes through your sync server, so taps take a second or two.</p>
      <div class="row-actions"><button class="btn" data-action="music-phone-on">Show on my phone</button></div>`;
  }
  return `${head}
    ${r.error ? `<p class="warn small">⚠ ${esc(r.error)}</p>` : `<p class="ok small">✓ On. Open the app on your phone: the song shows above the tab bar. Tap it for the full-screen player.${r.sent ? ` Last sent ${esc(ago(r.sent * 1000))}.` : ''}</p>`}
    <div class="row-actions"><button class="btn ghost" data-action="music-phone-off">Stop showing on my phone</button></div>`;
}

/** On the phone (or any device without the helper). */
function musicOnPhoneCard() {
  return `<section class="card" id="music"><h3>${icon('music')} Now playing</h3>
    <p>See what your Linux computer is playing, above the tab bar, with a full-screen player. Set it up on the computer: <b>Settings → Now playing</b>, then <b>Show on my phone</b>.</p>
    ${!settings.apiUrl ? '<p class="small faint">It goes through your sync server: set up <b>Sync &amp; background push</b> below first.</p>'
      : musicError && viaSync() ? `<p class="warn small">⚠ ${esc(musicError)}</p>` : ''}
    <label class="row"><span>Show music from my computer</span><span class="switch"><input type="checkbox" data-setting-bool="musicPhone" ${settings.musicPhone !== false ? 'checked' : ''}><span></span></span></label>
  </section>`;
}

/* ---------- WhatsApp (Linux computer with the helper) ---------- */
function whatsappCard() {
  const cmd = `<div class="copy"><input readonly value="${esc(waInstallCommand())}" aria-label="Setup command"><button class="btn small ${settings.whatsapp ? '' : 'primary'}" data-action="wa-copy">Copy</button></div>`;
  const intro = '<p>Show your unread WhatsApp chats on the Dashboard: pinned chats first, then people, then groups, newest first. A small helper on this computer links to WhatsApp like WhatsApp Web does. It only reads: it never sends anything or marks messages as read.</p>';
  let body;
  if (settings.whatsapp) {
    ensureWhatsApp();
    const d = whatsApp();
    const status = waError ? `<p class="warn small">⚠ ${esc(waError)} Run the setup command below again.</p>${cmd}`
      : !d ? '<p class="small faint">Connecting…</p>'
      : d.status === 'ready' ? `<p class="ok small">✓ Linked${d.me ? ` as <b>${esc(d.me)}</b>` : ''}. Look for it on the Dashboard.</p>`
      : d.status === 'qr' ? '<p class="small">Almost there: scan the code on the <a href="#/dashboard">Dashboard</a> with WhatsApp on your phone (<b>Settings → Linked devices → Link a device</b>).</p>'
      : d.status === 'error' ? `<p class="warn small">⚠ ${esc(d.error)}</p>`
      : '<p class="small faint">WhatsApp is starting…</p>';
    body = `${status}
      <div class="row-actions">${d?.status === 'ready' ? '<button class="btn ghost danger" data-action="wa-logout">Unlink from WhatsApp</button>' : ''}<button class="btn ghost" data-action="wa-disable">Turn off</button></div>
      <p class="small faint">If WhatsApp stops loading after one of its updates, run the setup command again: it also updates the helper.</p>`;
  } else {
    body = `<ol class="steps">
        <li>It needs Node.js. If you don't have it: <code>sudo apt install nodejs npm</code></li>
        <li>Open a terminal (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>), then paste and run this:${cmd}</li>
        <li>${waWaiting ? '<span class="pulse"></span> Waiting for it to finish. This page connects by itself.' : 'Come back here. This page connects by itself.'}
          Then scan the code on the Dashboard with your phone.</li>
      </ol>
      <p class="small faint">Already set up? <button class="link" data-action="wa-enable">Connect now</button> · <a href="https://github.com/Stfy-y/productivitypp/tree/master/extras/whatsapp" target="_blank" rel="noopener">How it works</a></p>`;
  }
  return `<section class="card" id="whatsapp"><h3>${icon('chat')} WhatsApp</h3>${intro}${body}
    <p class="small faint">Uses whatsapp-web.js, an unofficial WhatsApp Web client. Messages stay on this computer; only this app can read them from the helper.</p></section>`;
}

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
  else if (/firefox|zen/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent)) installBlock = `<p>Firefox-based browsers like <b>Zen</b> can't install web apps on Linux yet, but everything else works in a tab (offline mode, notifications, sync).</p>
    <ul class="plain"><li><b>Zen:</b> right-click the tab → <b>Add to Essentials</b> (or pin it), so the app is always one click away.</li>
    <li><b>Want a separate app window with its own icon?</b> Open this page in Chrome, Chromium, Edge or Brave and choose <b>Install app</b>.</li></ul>`;
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
    <label class="row"><span>Dashboard burn-in protection<br><small class="hint">Shifts it a few pixels every 3 minutes, for screens left on</small></span><span class="switch"><input type="checkbox" data-setting-bool="burnIn" ${settings.burnIn !== false ? 'checked' : ''}><span></span></span></label>
  </section>

  <section class="card"><h3>${icon('sun')} Dashboard weather</h3>
    ${settings.weatherLoc ? `<p>Showing the weather for <b>${esc(settings.weatherLoc.full || settings.weatherLoc.name)}</b>. <button class="link" data-action="weather-clear">Remove</button></p>` : '<p>Pick a place to show the forecast on the Dashboard.</p>'}
    ${locationForm()}
    <label class="row">Units<select data-setting="units">
      ${[['auto', 'Automatic'], ['metric', '°C, km/h'], ['imperial', '°F, mph']].map(([v, l]) => `<option value="${v}" ${settings.units === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="small faint">Forecasts come from Open-Meteo, a free service. Only the place's coordinates are sent to it.</p>
  </section>

  ${!isLinuxDesktop() && !settings.music ? musicOnPhoneCard() : `<section class="card" id="music"><h3>${icon('music')} Now playing</h3>
    <p>Show the song playing on this computer on the Dashboard, with play/pause/skip, volume and a full-screen player, and on your phone too. Works on Linux with YouTube Music, Spotify, browser tabs, VLC and other players.</p>
    ${settings.music
      ? `${musicError ? `<p class="warn small">⚠ ${esc(musicError)} Run the setup command below again.</p>` : '<p class="ok small">✓ On. Look for it on the Dashboard.</p>'}
        ${musicError ? `<div class="copy"><input readonly value="${esc(installCommand())}" aria-label="Setup command"><button class="btn small" data-action="music-copy">Copy</button></div>` : ''}
        <div class="row-actions"><button class="btn ghost" data-action="music-disable">Turn off</button></div>
        ${musicError ? '' : phoneBlock()}`
      : `<ol class="steps">
          <li>Open a terminal (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>), then paste and run this:
            <div class="copy"><input readonly value="${esc(installCommand())}" aria-label="Setup command"><button class="btn small primary" data-action="music-copy">Copy</button></div></li>
          <li>${waitingForHelper ? '<span class="pulse"></span> Waiting for it to finish. This page connects by itself.' : 'Come back here. This page connects by itself.'}
            If Chrome asks to allow access to devices on your local network, click <b>Allow</b>.</li>
        </ol>
        <p class="small faint">Already set up? <button class="link" data-action="music-enable">Connect now</button> · <a href="https://github.com/Stfy-y/productivitypp/tree/master/extras/now-playing" target="_blank" rel="noopener">How it works</a></p>`}
  </section>`}

  ${isLinuxDesktop() || settings.whatsapp ? whatsappCard() : ''}

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
      <li><b>Linux (GNOME, e.g. Ubuntu):</b> a top-bar widget with today's schedule, tasks and habits. Run <code>linux-widget/install.sh</code> from the project folder and paste the URL below (<a href="https://github.com/Stfy-y/productivitypp/tree/master/linux-widget" target="_blank" rel="noopener">guide</a>).</li>
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
