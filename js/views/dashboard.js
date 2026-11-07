// Dashboard: an at-a-glance screen meant to stay open (clock, weather, now/next, today's plan).
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { today, addDays, parseYmd, fmtTime } from '../dates.js';
import { tasks, sortTasks, habits, habitCount, isScheduled, settings } from '../store.js';
import { taskRow, eventAttrs, openSheet, closeSheet } from '../ui.js';
import { ensureRange } from '../gcal.js';
import { allEventsOn } from '../events.js';
import { toMin, fmtDur, DEFAULT_DURATION } from './timegrid.js';
import { getWeather, weatherError, searchResults, wxIcon, wxLabel, isWet } from '../weather.js';
import { upcomingExams, countdown, whenText } from './exams.js';
import { EXAM_TYPES } from '../store.js';
import { nowPlaying, ensureMusic, musicError, livePosition, artUrl, isLinuxDesktop } from '../music.js';
import { whatsApp, ensureWhatsApp, waError, chatLink, loadAllUnread } from '../whatsapp.js';
import { PANELS, COLS, layout, isEditing } from '../dashlayout.js';

const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const deg = (v) => (v == null ? '–' : `${Math.round(v)}°`);
const fmtLeft = (m) => (m < 1 ? 'now' : m < 60 ? `${m} min` : fmtDur(Math.round(m)));

/* ---------- Clock ---------- */
function clockParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).formatToParts(d);
  const main = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  const period = parts.find((p) => p.type === 'dayPeriod')?.value || '';
  return { main, period, sec: String(d.getSeconds()).padStart(2, '0') };
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
}

/* ---------- Burn-in protection ---------- */
// Every few minutes the whole Dashboard drifts a few pixels around a small loop, so no pixel
// shows the same bright edge for hours. Slow enough (3 s glide) that you don't notice it.
const SHIFT_MS = 3 * 60 * 1000;
const SHIFT_PATH = [[0, 0], [3, 0], [3, 3], [0, 3], [-3, 3], [-3, 0], [-3, -3], [0, -3], [3, -3]];
let shiftStep = 0;
let lastShift = Date.now();
export function applyBurnIn() {
  const [x, y] = settings.burnIn === false ? [0, 0] : SHIFT_PATH[shiftStep % SHIFT_PATH.length];
  const root = document.documentElement.style;
  root.setProperty('--burn-x', `${x}px`);
  root.setProperty('--burn-y', `${y}px`);
}

let ticker = null;
/** Keeps the clock ticking every second and calls rerender when the minute changes. */
export function startDashTicker(isActive, rerender) {
  if (ticker) return;
  let minute = new Date().getMinutes();
  ticker = setInterval(() => {
    if (!isActive()) return;
    if (Date.now() - lastShift > SHIFT_MS) { lastShift = Date.now(); shiftStep++; applyBurnIn(); }
    const d = new Date();
    if (d.getMinutes() !== minute) { minute = d.getMinutes(); rerender(); return; }
    const el = document.querySelector('[data-dash-clock]');
    if (el) {
      const p = clockParts(d);
      el.querySelector('.clk-main').textContent = p.main;
      el.querySelector('.clk-sec').textContent = p.sec;
    }
    const s = nowPlaying();
    if (s?.length) {
      const pos = livePosition(s);
      const bar = document.querySelector('[data-music-prog]');
      const txt = document.querySelector('[data-music-pos]');
      if (bar) bar.style.width = `${Math.min(100, (pos / s.length) * 100).toFixed(2)}%`;
      if (txt) txt.textContent = mmss(pos);
    }
  }, 1000);
}

/* ---------- Keep screen awake & fullscreen ---------- */
let lock = null;
let lockPending = false;
const AWAKE_KEY = 'ppp-dash-awake';
export const canKeepAwake = () => 'wakeLock' in navigator;
export const awakeWanted = () => { try { return localStorage.getItem(AWAKE_KEY) === '1'; } catch { return false; } };
export function setAwakeWanted(on) { try { localStorage.setItem(AWAKE_KEY, on ? '1' : '0'); } catch { /* private mode */ } }

/** Hold a screen wake lock while the dashboard is visible and the option is on. */
export async function syncWakeLock(onDashboard) {
  const want = onDashboard && awakeWanted() && canKeepAwake() && document.visibilityState === 'visible';
  if (want && !lock && !lockPending) {
    lockPending = true;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch { lock = null; } finally { lockPending = false; }
  } else if (!want && lock) {
    const l = lock; lock = null;
    l.release().catch(() => {});
  }
}

export const canFullscreen = () => !!document.fullscreenEnabled;
export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

export function dashActions() {
  if (isEditing()) {
    return `<button class="btn small ghost" data-action="dash-reset" title="Put every panel back where it started">Reset</button>
      <button class="btn small primary" data-action="dash-edit-done">Done</button>`;
  }
  const awake = awakeWanted();
  const full = !!document.fullscreenElement;
  return `<button class="icon-btn" data-action="dash-edit" title="Edit the dashboard: add, remove and move panels" aria-label="Edit dashboard">${icon('layout')}</button>
    ${canKeepAwake() ? `<button class="icon-btn ${awake ? 'active' : ''}" data-action="dash-awake" aria-pressed="${awake}" title="${awake ? 'Screen stays on (click to allow sleep)' : 'Keep the screen on'}" aria-label="Keep screen on">${icon(awake ? 'eye' : 'eyeOff')}</button>` : ''}
    ${canFullscreen() ? `<button class="icon-btn" data-action="dash-fullscreen" title="${full ? 'Exit full screen' : 'Full screen'} (F)" aria-label="Full screen">${icon(full ? 'shrink' : 'expand')}</button>` : ''}`;
}

/* ---------- Data ---------- */
/** Timed items (events + timed tasks) for a date, in start order. */
function timedItems(d) {
  const out = [];
  for (const e of allEventsOn(d)) {
    if (e.allDay) continue;
    const s = e.time ? toMin(e.time) : 0;
    const en = e.endTime ? toMin(e.endTime) : 1440;
    out.push({ kind: 'event', e, s, en: Math.max(en, s + 1), title: e.title, color: e.color, sub: e.location });
  }
  for (const t of tasks()) {
    if (t.date !== d || !t.time) continue;
    const s = toMin(t.time);
    out.push({ kind: 'task', t, s, en: s + (Number(t.duration) || DEFAULT_DURATION), title: t.title, done: t.done, color: 'var(--accent)' });
  }
  return out.sort((a, b) => a.s - b.s || a.en - b.en);
}

const itemAttrs = (it) => (it.kind === 'event' ? eventAttrs(it.e) : `data-action="edit-task" data-id="${esc(it.t.id)}" role="button" tabindex="0"`);
const range = (it) => `${fmtTime(minToHm(it.s))} – ${fmtTime(minToHm(Math.min(it.en, 1439)))}`;
const minToHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Free minutes between now (or day start) and day end, after subtracting what's scheduled. */
function freeTime(items, now) {
  const from = Math.max(now, toMin(settings.dayStart));
  const to = toMin(settings.dayEnd);
  if (from >= to) return null;
  const busy = items.filter((i) => !i.done && i.en > from && i.s < to).map((i) => [Math.max(i.s, from), Math.min(i.en, to)]).sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [s, e] of busy) {
    if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e);
  }
  if (cur) total += cur[1] - cur[0];
  return { free: to - from - total, until: settings.dayEnd };
}

/* ---------- Cards ---------- */
function heroCard(now, items) {
  const p = clockParts();
  const t = today();
  const dateTxt = parseYmd(t).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const ds = toMin(settings.dayStart), de = toMin(settings.dayEnd);
  const pct = de > ds ? Math.max(0, Math.min(100, ((now - ds) / (de - ds)) * 100)) : 0;
  const ft = freeTime(items, now);
  return `<section class="card dash-hero">
    <div class="clk" data-dash-clock><span class="clk-main">${esc(p.main)}</span><span class="clk-side"><span class="clk-sec">${p.sec}</span><span class="clk-period">${esc(p.period)}</span></span></div>
    <div class="dash-date">${esc(dateTxt)}</div>
    <div class="dash-greet">${greeting()}${navigator.onLine ? '' : ' · <span class="warn">Offline</span>'}</div>
    <div class="dayline" title="${Math.round(pct)}% of your day (${esc(settings.dayStart)}–${esc(settings.dayEnd)})">
      <div class="dayline-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
      <small>${pct >= 100 ? 'Day window is over. Time to rest.' : pct <= 0 ? `Your day starts at ${esc(fmtTime(settings.dayStart))}` : ft ? `${fmtDur(ft.free)} free until ${esc(fmtTime(ft.until))}` : ''}</small>
    </div>
  </section>`;
}

function nowNextCard(now, items) {
  const t = today();
  const current = items.filter((i) => !i.done && i.s <= now && now < i.en);
  let next = items.find((i) => !i.done && i.s > now);
  let nextDay = null;
  if (!next) {
    const tm = addDays(t, 1);
    next = timedItems(tm).find((i) => !i.done);
    if (next) nextDay = tm;
  }
  const curHtml = current.map((c, i) => {
    const p = ((now - c.s) / (c.en - c.s)) * 100;
    return `<div class="nn-item now" ${i ? 'data-trim="nn"' : ''} ${itemAttrs(c)} style="--ec:${esc(c.color)}">
      <span class="nn-label">Now</span><b>${esc(c.title)}</b>
      <small>${esc(range(c))}${c.sub ? ` · ${esc(c.sub)}` : ''} · ${fmtLeft(c.en - now)} left</small>
      <div class="nn-prog"><span style="width:${p.toFixed(1)}%"></span></div></div>`;
  }).join('');
  const nextHtml = next ? `<div class="nn-item" ${itemAttrs(next)} style="--ec:${esc(next.color)}">
      <span class="nn-label">${nextDay ? 'Tomorrow' : `Next · in ${fmtLeft(next.s - now)}`}</span><b>${esc(next.title)}</b>
      <small>${esc(range(next))}${next.sub ? ` · ${esc(next.sub)}` : ''}</small></div>` : '';
  const body = curHtml + nextHtml || '<div class="faint pad">Nothing scheduled. Your time is your own.</div>';
  return `<section class="card dash-nn"><h3>${icon('clock')} Now &amp; next</h3>${body}</section>`;
}

function examsCard() {
  const up = upcomingExams();
  if (!up.length) return '';
  const [first, ...rest] = up;
  const c = countdown(first);
  const MAX = 30; // the list scrolls inside the card
  return `<section class="card dash-exams"><h3>${icon('exam')} Exams <a class="link" href="#/exams">All exams</a></h3>
    <div class="dx-next lvl-${c.level}" data-action="exam-edit" data-id="${esc(first.id)}" role="button" tabindex="0" style="--ec:${esc(first.color)}">
      <div class="dx-count"><b>${esc(c.big)}</b>${c.unit ? `<small>${c.unit}</small>` : ''}</div>
      <div class="dx-info"><span class="nn-label">Next ${esc((EXAM_TYPES[first.examType] || 'exam').toLowerCase())}</span>
        <b>${esc(first.title)}</b><small>${esc(whenText(first))}${first.location ? ` · ${esc(first.location)}` : ''}</small></div>
    </div>
    ${rest.length ? `<div class="dx-list">${rest.slice(0, MAX).map((e) => {
      const k = countdown(e);
      return `<div class="dx-row" data-action="exam-edit" data-id="${esc(e.id)}" role="button" tabindex="0">
        <span class="dot" style="--c:${esc(e.color)}"></span><span class="dx-row-title">${esc(e.title)}<small>${esc(whenText(e))}</small></span>
        <span class="dx-pill lvl-${k.level}">${esc(k.unit ? `${k.big} ${k.unit}` : k.big)}</span></div>`;
    }).join('')}</div>` : ''}
    ${moreLink('exams', Math.max(0, rest.length - MAX), '#/exams')}
  </section>`;
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export const MUSIC_HINT_KEY = 'ppp-music-hint-off';
function musicHint() {
  let off = false;
  try { off = localStorage.getItem(MUSIC_HINT_KEY) === '1'; } catch { /* private mode */ }
  if (off || !isLinuxDesktop()) return '';
  return `<section class="card dash-music hint" data-trim="hint"><div class="mu">
    <div class="mu-art ph small">${icon('music')}</div>
    <div class="mu-info"><b>Show what's playing</b><small>One command to set up.</small></div>
    <a class="btn small primary" href="#/settings/music">Set up</a>
    <button class="icon-btn small" data-action="music-hint-off" aria-label="Hide this">${icon('close')}</button></div></section>`;
}

function musicCard() {
  if (!settings.music) return musicHint();
  const s = nowPlaying();
  if (!s) {
    return `<section class="card dash-music"><h3>${icon('music')} Now playing</h3>
      <p class="small ${musicError ? 'warn' : 'faint'}">${esc(musicError || 'Connecting…')}${musicError ? ' <a href="#/settings">Help</a>' : ''}</p></section>`;
  }
  if (s.status === 'none') return `<section class="card dash-music"><h3>${icon('music')} Now playing <small class="faint">Nothing playing</small></h3></section>`;
  const art = artUrl(s);
  const playing = s.status === 'playing';
  const pos = livePosition(s);
  return `<section class="card dash-music ${playing ? 'playing' : 'paused'}">
    ${art ? `<img class="mu-bg" src="${esc(art)}" alt="" referrerpolicy="no-referrer" aria-hidden="true">` : ''}
    <button class="icon-btn mu-full-btn" data-action="music-full" aria-label="Full screen player" title="Full screen player">${icon('expand')}</button>
    <div class="mu">
      ${art ? `<img class="mu-art" src="${esc(art)}" alt="" referrerpolicy="no-referrer" data-action="music-full" title="Full screen player">` : `<div class="mu-art ph">${icon('music')}</div>`}
      <div class="mu-info"><span class="nn-label">${playing ? 'Now playing' : 'Paused'} · ${esc(s.player)}</span>
        <b title="${esc(s.title)}">${esc(s.title)}</b><small>${esc(s.artist || s.album)}</small></div>
    </div>
    ${s.length ? `<div class="mu-prog"><span data-music-prog style="width:${Math.min(100, (pos / s.length) * 100).toFixed(2)}%"></span></div>
      <div class="mu-time"><span data-music-pos>${mmss(pos)}</span><span>${mmss(s.length)}</span></div>` : ''}
    <div class="mu-ctl">
      <button class="icon-btn" data-action="music-cmd" data-cmd="previous" aria-label="Previous track" ${s.canPrevious ? '' : 'disabled'}>${icon('prev')}</button>
      <button class="icon-btn mu-play" data-action="music-cmd" data-cmd="play-pause" aria-label="${playing ? 'Pause' : 'Play'}" ${s.canPause ? '' : 'disabled'}>${icon(playing ? 'pause' : 'play')}</button>
      <button class="icon-btn" data-action="music-cmd" data-cmd="next" aria-label="Next track" ${s.canNext ? '' : 'disabled'}>${icon('next')}</button>
    </div>
  </section>`;
}

/* ---------- WhatsApp ---------- */
const WA_MAX = 40; // chats rendered; the fit pass hides what doesn't fit and counts it in "+N more"
const waHue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
function waWhen(ts) {
  const d = new Date(ts * 1000);
  const days = Math.round((parseYmd(today()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days <= 0) return fmtTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const waAvatar = (c) => {
  const initial = [...(c.name || '?').replace(/^[^\p{L}\p{N}]+/u, '')][0] || '#';
  return `<span class="wa-av ${c.isGroup ? 'group' : ''}" style="--h:${waHue(c.id)}" aria-hidden="true">${esc(initial.toUpperCase())}</span>`;
};
const waBadge = (c) => `<span class="wa-badge ${c.unread < 0 ? 'dot' : ''}" aria-label="${c.unread < 0 ? 'Marked unread' : `${c.unread} unread`}">${c.unread > 0 ? c.unread : ''}</span>`;
const waSections = (chats) => [['Pinned', chats.filter((c) => c.pinned)], ['People', chats.filter((c) => !c.pinned && !c.isGroup)], ['Groups', chats.filter((c) => !c.pinned && c.isGroup)]]
  .filter(([, list]) => list.length);

function waChat(c) {
  return `<div class="wa-chat ${c.muted ? 'muted' : ''}" data-trim="wa" data-action="wa-all" data-chat="${esc(c.id)}" role="button" tabindex="0" title="Show all messages">
    ${waAvatar(c)}
    <span class="wa-body">
      <span class="wa-top"><b>${esc(c.name)}</b><time>${esc(waWhen(c.ts))}</time></span>
      ${c.messages.map((m) => `<span class="wa-msg">${m.author ? `<i>${esc(m.author)}:</i> ` : ''}${esc(m.text)}</span>`).join('')}
    </span>
    ${waBadge(c)}
  </div>`;
}

/* ---------- WhatsApp: every unread message, in a window inside the app ---------- */
function waThread(c, loading) {
  const more = c.unread > c.messages.length;
  return `<section class="wa-thread ${c.muted ? 'muted' : ''}" data-thread="${esc(c.id)}">
    <div class="wa-thread-h">${waAvatar(c)}<b>${esc(c.name)}</b>${c.muted ? '<span class="tag">Muted</span>' : ''}${waBadge(c)}</div>
    <div class="wa-msgs">${c.messages.map((m) => `<div class="wa-bubble">${m.author ? `<i>${esc(m.author)}</i>` : ''}<span>${esc(m.text)}</span><time>${esc(waWhen(m.ts))}</time></div>`).join('')
      || '<p class="small faint">Marked as unread.</p>'}</div>
    ${more ? `<p class="small faint">${loading ? 'Loading more…' : `Showing the newest ${c.messages.length} of ${c.unread} unread.`}</p>` : ''}
    <a class="link small" href="${esc(chatLink(c))}" target="_blank" rel="noopener">Reply in WhatsApp Web</a>
  </section>`;
}

function waSheetBody(d, loading) {
  const chats = d?.chats || [];
  if (!chats.length) return '<p class="faint pad">All caught up. No unread messages.</p>';
  return waSections(chats).map(([name, list]) => `<div class="wa-sec-h">${name}</div>${list.map((c) => waThread(c, loading)).join('')}`).join('');
}

/** "+N more" or a chat on the Dashboard: all unread chats with all their unread messages (up to 50 each). */
export function openWhatsAppSheet(focusId) {
  const d = whatsApp();
  const head = (x) => `${x?.total || 0} unread · ${(x?.chats || []).length} chats`;
  const el = openSheet(`<div class="wa-sheet">
      <div class="evd-head"><h2>${icon('chat')} WhatsApp</h2><span class="count" data-wa-count>${head(d)}</span>
        <button class="icon-btn" data-x="close" aria-label="Close">${icon('close')}</button></div>
      <div class="wa-sheet-body" data-wa-body>${waSheetBody(d, true)}</div>
      <div class="editor-foot"><span class="spacer"></span><button class="btn primary" data-x="close">Done</button></div>
    </div>`, {
    wide: true,
    onMount(root) { root.addEventListener('click', (ev) => { if (ev.target.closest('[data-x="close"]')) closeSheet(); }); },
  });
  const focus = () => {
    if (!focusId) return;
    el.querySelector(`[data-thread="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'start' });
  };
  focus();
  loadAllUnread().then((full) => {
    if (!el.isConnected) return;
    const body = el.querySelector('[data-wa-body]');
    const top = body.scrollTop;
    body.innerHTML = waSheetBody(full, false);
    el.querySelector('[data-wa-count]').textContent = head(full);
    if (focusId) focus(); else body.scrollTop = top;
  }).catch(() => {
    if (!el.isConnected) return;
    el.querySelector('[data-wa-body]').innerHTML = waSheetBody(d, false);
  });
}

function whatsappCard() {
  const head = (extra = '') => `<h3>${icon('chat')} WhatsApp ${extra}</h3>`;
  if (!settings.whatsapp) {
    if (!isLinuxDesktop()) return '';
    return `<section class="card dash-music hint dash-wa-note" data-trim="hint"><div class="mu">
      <div class="mu-art ph small">${icon('chat')}</div>
      <div class="mu-info"><b>See unread WhatsApp messages</b><small>Pinned chats first, then people, then groups.</small></div>
      <a class="btn small primary" href="#/settings/whatsapp">Set up</a>
      <button class="icon-btn small" data-action="dash-remove" data-panel="whatsapp" aria-label="Remove from the Dashboard" title="Remove from the Dashboard">${icon('close')}</button></div></section>`;
  }
  const d = whatsApp();
  const msg = (text, warn) => `<section class="card dash-wa-note">${head()}<p class="small ${warn ? 'warn' : 'faint'}">${text}</p></section>`;
  if (!d) return msg(`${esc(waError || 'Connecting…')}${waError ? ' <a href="#/settings/whatsapp">Help</a>' : ''}`, !!waError);
  if (d.status === 'error') return msg(`⚠ ${esc(d.error)}`, true);
  if (d.status === 'qr') {
    return `<section class="card dash-wa-note">${head('<small class="faint">Link this computer</small>')}
      <div class="wa-link">${d.qr ? `<img class="wa-qr" src="${esc(d.qr)}" alt="WhatsApp link code" width="168" height="168">` : '<div class="wa-qr ph">Loading code…</div>'}
        <ol class="small"><li>Open WhatsApp on your phone</li><li><b>Settings → Linked devices → Link a device</b></li><li>Scan this code</li></ol></div></section>`;
  }
  if (d.status !== 'ready') return msg(d.status === 'loading' && d.progress ? `Loading your chats… ${Math.round(d.progress)}%` : 'Starting WhatsApp…');
  const chats = d.chats || [];
  if (!chats.length) return `<section class="card dash-wa-note">${head()}<div class="faint pad">All caught up. No unread messages.</div></section>`;
  const shown = chats.slice(0, WA_MAX);
  const unreadChats = chats.length;
  return `<section class="card dash-wa">${head(`<span class="count" title="${unreadChats} chat${unreadChats > 1 ? 's' : ''} with unread messages">${d.total} unread · ${unreadChats} chat${unreadChats > 1 ? 's' : ''}</span>`)}
    <div class="wa-list">${waSections(shown).map(([name, list]) => `<div class="wa-sec"><div class="wa-sec-h">${name}</div>${list.map(waChat).join('')}</div>`).join('')}</div>
    ${moreLink('wa', Math.max(0, chats.length - WA_MAX), '#', 'data-action="wa-all"')}
  </section>`;
}

function weatherCard() {
  const loc = settings.weatherLoc;
  if (!loc) {
    return `<section class="card dash-wx"><h3>${icon('sun')} Weather</h3>
      <p>Pick a place to see the forecast here. Weather comes from Open-Meteo: free, with no account needed.</p>${locationForm()}</section>`;
  }
  const w = getWeather();
  if (!w) {
    return `<section class="card dash-wx"><h3>${icon('sun')} Weather <small class="wx-loc">${esc(loc.name)}</small></h3>
      <p class="${weatherError ? 'warn' : 'faint'}">${weatherError ? `⚠ ${esc(weatherError)}` : 'Loading the forecast…'}</p></section>`;
  }
  const n = w.now;
  const td = w.daily[0] || {};
  const rain = w.hourly.slice(1).find((h) => h.pop != null && h.pop >= 50);
  const hint = isWet(n.code) ? 'It\'s wet out there. Take an umbrella.'
    : rain ? `${rain.pop}% chance of rain around ${fmtTime(rain.time)}. Take an umbrella.`
    : td.uv >= 6 ? `UV index ${Math.round(td.uv)} today. Sunscreen recommended.` : '';
  const age = Math.round((Date.now() - w.ts) / 60000);
  return `<section class="card dash-wx"><h3>${icon('sun')} Weather <a class="wx-loc" href="#/settings" title="${esc(loc.full || loc.name)}. Change in Settings">${icon('pin')}${esc(loc.name)}</a></h3>
    <div class="wx-now">
      <div class="wx-ico" aria-hidden="true">${wxIcon(n.code, n.isDay)}</div>
      <div class="wx-temp">${deg(n.temp)}<small>${w.unit.slice(1)}</small></div>
      <div class="wx-desc"><b>${esc(wxLabel(n.code))}</b>
        <small>Feels ${deg(n.feels)} · H ${deg(td.max)} L ${deg(td.min)}</small>
        <small>${icon('wind')} ${Math.round(n.wind)} ${w.windUnit} · ${icon('drop')} ${Math.round(n.humidity)}%</small></div>
    </div>
    ${hint ? `<div class="wx-hint">${esc(hint)}</div>` : ''}
    <div class="wx-hours">${w.hourly.slice(1, 13).map((h) => `<div class="wx-h"><small>${esc(fmtTime(h.time).replace(':00', ''))}</small><span>${wxIcon(h.code, h.isDay)}</span><b>${deg(h.temp)}</b>${h.pop >= 20 ? `<i>${h.pop}%</i>` : '<i></i>'}</div>`).join('')}</div>
    <div class="wx-days">${w.daily.slice(1, 6).map((d) => `<div class="wx-d" data-trim="wxdays"><span>${esc(parseYmd(d.date).toLocaleDateString([], { weekday: 'short' }))}</span><span class="wx-d-ico">${wxIcon(d.code)}</span><small>${d.pop >= 20 ? `${d.pop}%` : ''}</small><b>${deg(d.max)}</b><span class="faint">${deg(d.min)}</span></div>`).join('')}</div>
    <div class="wx-foot faint">${td.sunrise ? `🌅 ${esc(fmtTime(td.sunrise))} · 🌇 ${esc(fmtTime(td.sunset))} · ` : ''}${age < 2 ? 'Updated just now' : `Updated ${age} min ago`}${weatherError ? ` · <span class="warn">${esc(weatherError)}</span>` : ''}</div>
  </section>`;
}

/** City search + "use my location" (also used in Settings). */
export function locationForm() {
  const res = searchResults;
  return `<form class="wx-form" data-weather-form autocomplete="off">
    <div class="copy"><input name="q" placeholder="Search a city, e.g. Bucharest" aria-label="City"><button class="btn small" type="submit">Search</button></div>
    ${res ? (res.length ? `<div class="wx-results">${res.map((p, i) => `<button type="button" class="btn small ghost" data-action="weather-pick" data-i="${i}">${esc(p.name)}</button>`).join('')}</div>` : '<p class="small faint">No places found.</p>') : ''}
    <div class="row-actions"><button type="button" class="btn small ghost" data-action="weather-geo">${icon('pin')} Use my location</button></div>
  </form>`;
}

function timelineCard(now, items) {
  const t = today();
  const allDay = allEventsOn(t).filter((e) => e.allDay);
  let html = allDay.length ? `<div class="tl-allday">${allDay.map((e) => `<span class="tl-chip" ${eventAttrs(e)} style="--ec:${esc(e.color)}">${esc(e.title)}</span>`).join('')}</div>` : '';
  let marked = false;
  const nowMark = () => `<div class="tl-now"><span>${esc(fmtTime(minToHm(now)))}</span></div>`;
  for (const it of items) {
    const state = it.done ? 'done' : it.en <= now ? 'past' : it.s <= now ? 'now' : '';
    if (!marked && it.s > now) { html += nowMark(); marked = true; }
    html += `<div class="tl-item ${state}" data-trim="${state === 'past' || state === 'done' ? 'agenda-past' : state === 'now' ? 'agenda-now' : 'agenda'}" ${itemAttrs(it)} style="--ec:${esc(it.color)}">
      <span class="tl-time">${esc(fmtTime(minToHm(it.s)))}</span><span class="tl-bar"></span>
      <span class="tl-body"><span class="tl-title">${it.kind === 'task' ? `<button class="check mini ${it.done ? 'on' : ''}" data-action="toggle-task" data-id="${esc(it.t.id)}" aria-label="${it.done ? 'Mark not done' : 'Complete'}">${icon('check')}</button>` : ''}${esc(it.title)}</span>
      <small>${esc(range(it))}${it.sub ? ` · ${esc(it.sub)}` : ''}</small></span></div>`;
  }
  if (items.length && !marked) html += nowMark();
  if (!items.length && !allDay.length) html += '<div class="faint pad">No events today.</div>';
  return `<section class="card dash-tl"><h3>${icon('calendar')} Today's agenda <a class="link" href="#/calendar">Calendar</a></h3><div class="tl">${html}</div>
    <div class="more-row"><a class="link" href="#/calendar" data-more="agenda" data-more-also="agenda-past" data-extra="0" hidden>+0 more</a></div></section>`;
}

function tasksCard() {
  const t = today();
  const all = tasks();
  const open = all.filter((x) => !x.done);
  const overdue = sortTasks(open.filter((x) => x.date && x.date < t));
  const todays = sortTasks(open.filter((x) => x.date === t && !x.time));
  const dueToday = all.filter((x) => x.date === t);
  const doneToday = all.filter((x) => x.done && x.doneAt && new Date(x.doneAt).toDateString() === new Date().toDateString()).length;
  const list = [...overdue, ...todays];
  const MAX = 25;
  const left = open.filter((x) => x.date && x.date <= t).length;
  const pct = (doneToday / Math.max(1, doneToday + left)) * 100;
  return `<section class="card dash-tasks"><h3>${icon('today')} Tasks ${doneToday + left ? `<span class="count">${doneToday} done · ${left} left</span>` : ''}
      <button class="icon-btn small" data-action="quick-add" data-date="${t}" aria-label="Add task">${icon('plus')}</button></h3>
    ${doneToday + left ? `<div class="dash-prog"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
    <div class="task-list">${list.slice(0, MAX).map((x) => taskRow(x, { showDate: x.date !== t }).replace('<div class="task ', '<div data-trim="tasks" class="task ')).join('')}</div>
    ${moreLink('tasks', Math.max(0, list.length - MAX), '#/today')}
    ${!list.length ? `<div class="faint pad">${doneToday ? 'All done for today. Nice work!' : 'Nothing left to do today.'}${dueToday.some((x) => x.time && !x.done) ? ' (Timed tasks are in the agenda.)' : ''}</div>` : ''}
  </section>`;
}

function habitsCard() {
  const t = today();
  const hs = habits().filter((h) => !h.archived && isScheduled(h, t));
  if (!hs.length) return '';
  const done = hs.filter((h) => habitCount(h, t) >= (h.goal || 1)).length;
  return `<section class="card dash-habits"><h3>${icon('habits')} Habits <span class="count">${done}/${hs.length}</span></h3>
    <div class="habit-strip wrap">${hs.map((h) => {
      const c = habitCount(h, t), g = h.goal || 1;
      return `<button class="hchip ${c >= g ? 'on' : ''}" style="--hc:${esc(h.color)}" data-action="habit-cycle" data-id="${h.id}" data-date="${t}">
        <span class="hchip-ico">${esc(h.icon)}</span><span class="hchip-name">${esc(h.name)}</span>${g > 1 ? `<small>${c}/${g}</small>` : ''}</button>`;
    }).join('')}</div></section>`;
}

function tomorrowCard() {
  const tm = addDays(today(), 1);
  const allDay = allEventsOn(tm).filter((e) => e.allDay);
  const timed = timedItems(tm);
  const untimed = tasks().filter((x) => !x.done && x.date === tm && !x.time).length;
  const w = settings.weatherLoc ? getWeather() : null;
  const wd = w?.daily?.find((d) => d.date === tm);
  const rows = [
    ...allDay.map((e) => `<div class="tm-row" data-trim="tomorrow" ${eventAttrs(e)}><span class="dot" style="--c:${esc(e.color)}"></span><span class="tm-t">All day</span><span>${esc(e.title)}</span></div>`),
    ...timed.slice(0, 12).map((i) => `<div class="tm-row" data-trim="tomorrow" ${itemAttrs(i)}><span class="dot" style="--c:${esc(i.color)}"></span><span class="tm-t">${esc(fmtTime(minToHm(i.s)))}</span><span>${esc(i.title)}</span></div>`),
  ];
  const first = timed[0];
  return `<section class="card dash-tm"><h3>${icon('week')} Tomorrow <small class="faint">${esc(parseYmd(tm).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))}</small>
      ${wd ? `<span class="tm-wx" title="${esc(wxLabel(wd.code))}">${wxIcon(wd.code)} ${deg(wd.max)} / ${deg(wd.min)}</span>` : ''}</h3>
    ${rows.join('') || '<div class="faint pad">Nothing scheduled yet.</div>'}
    ${moreLink('tomorrow', Math.max(0, timed.length - 12), '#/calendar')}
    <p class="small">${first ? `Day starts with <b>${esc(first.title)}</b> at ${esc(fmtTime(minToHm(first.s)))}. ` : ''}${untimed ? `${untimed} task${untimed > 1 ? 's' : ''} planned.` : ''}</p>
  </section>`;
}

/* ---------- Fit to the window (no page scroll on laptops) ---------- */
/** "+N more" link; N = rows hidden by the fit pass + `extra` rows that were never rendered. */
function moreLink(group, extra, href, attrs = '') {
  return `<div class="more-row"><a class="link" href="${href}" ${attrs} data-more="${group}" data-extra="${extra}" ${extra ? '' : 'hidden'}>+${extra} more</a></div>`;
}

/* Flexible cards share whatever height their column has left and trim their own lists to fit.
   The minimum is the height a card should get before other cards in its column give up rows. */
const FLEX = { 'dash-exams': 190, 'dash-tasks': 150, 'dash-tm': 0, 'dash-wa': 150 };
const FLEX_SEL = Object.keys(FLEX).map((c) => `.${c}`).join(', ');
const OWN_ROWS = { 'dash-tasks': ['tasks'], 'dash-tm': ['tomorrow'], 'dash-wa': ['wa'] };
const flexMin = (card) => FLEX[Object.keys(FLEX).find((c) => card.classList.contains(c))] || 0;
const overflowing = (el) => !!el && el.scrollHeight > el.clientHeight + 1;
/** Hide rows from the end while `cond()` is true (keeps at least `keep` rows). */
function trimWhile(rows, cond, keep = 0) {
  for (let i = rows.length - 1; i >= keep && cond(); i--) rows[i].hidden = true;
}

/* Cards can change height after the fit pass (the emoji font loading, cover art, late data).
   Watch the fixed-size cards and fit again when one really changes; recorded heights stop loops. */
let watcher = null;
const fitHeights = new WeakMap();
let refitQueued = false;
function watchCards(dash) {
  if (!('ResizeObserver' in window)) return;
  watcher ??= new ResizeObserver((entries) => {
    const changed = entries.some((e) => Math.abs((e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight) - (fitHeights.get(e.target) ?? -1)) > 0.5);
    if (!changed || refitQueued) return;
    refitQueued = true;
    requestAnimationFrame(() => { refitQueued = false; fitDashboard(); });
  });
  watcher.disconnect();
  for (const card of dash.querySelectorAll(`.dash-col > .card:not(${FLEX_SEL})`)) {
    fitHeights.set(card, card.offsetHeight);
    watcher.observe(card);
  }
}

/** After each render: size the Dashboard to the window and trim lists so nothing needs the page to scroll. */
export function fitDashboard() {
  const dash = document.querySelector('.dash');
  if (!dash) { document.body.classList.remove('dash-fit'); return; }
  const fit = !isEditing() && matchMedia('(min-width: 1100px) and (min-height: 600px)').matches;
  document.body.classList.toggle('dash-fit', fit);
  dash.querySelectorAll('[data-trim]').forEach((el) => { el.hidden = false; });
  // show every "+N more" while trimming so its height is counted; ones left at 0 are hidden at the end
  dash.querySelectorAll('[data-more]').forEach((a) => { a.hidden = false; });
  dash.style.height = '';
  if (fit) {
    dash.style.height = `${Math.floor(window.innerHeight - dash.getBoundingClientRect().top - 16)}px`;
    // Panels can sit in any column, so every column runs the same steps on whatever it holds
    for (const col of dash.querySelectorAll('.dash-col')) {
      // rows inside a panel with a set height are trimmed to that panel only (hiding them can't shorten the column)
      const rows = (g, root = col) => [...root.querySelectorAll(`[data-trim="${g}"]`)].filter((r) => root !== col || !r.closest('[data-size]'));
      const flex = [...col.querySelectorAll(`:scope > :is(${FLEX_SEL}):not([data-size])`)];
      const fixed = [...col.querySelectorAll(':scope > [data-size]')];
      // a flexible card is cramped when it's below its minimum and its content doesn't fit (the exams list scrolls inside)
      const cramped = (c) => c.clientHeight < flexMin(c) && (overflowing(c) || overflowing(c.querySelector('.dx-list')));
      const tight = () => overflowing(col) || flex.some(cramped);
      // 1. fixed cards give up rows: finished agenda items (oldest first), later agenda items, the music hint, extra "Now" items
      const past = rows('agenda-past');
      for (let i = 0; i < past.length && tight(); i++) past[i].hidden = true;
      trimWhile(rows('agenda'), tight);
      trimWhile(rows('hint'), tight);
      trimWhile(rows('nn'), tight);
      // 2. flexible cards trim their own lists (the exams list scrolls instead)
      for (const c of flex) {
        for (const g of OWN_ROWS[[...c.classList].find((k) => OWN_ROWS[k])] || []) trimWhile(rows(g, c), () => overflowing(c));
      }
      // 3. cards you gave a height trim their own lists to it (what can't be trimmed scrolls inside the card)
      for (const c of fixed) {
        const past = rows('agenda-past', c);
        for (let i = 0; i < past.length && overflowing(c); i++) past[i].hidden = true;
        for (const g of ['agenda', 'nn', 'tasks', 'tomorrow', 'wa']) trimWhile(rows(g, c), () => overflowing(c));
        trimWhile(rows('wxdays', c), () => overflowing(c), 2);
      }
      // 4. last resort: the 5-day forecast down to 2 days, only if that makes everything fit (otherwise keep all days)
      const days = rows('wxdays');
      const crowded = () => overflowing(col) || flex.some(overflowing);
      trimWhile(days, crowded, 2);
      if (crowded()) days.forEach((r) => { r.hidden = false; });
    }
  }
  if (fit) watchCards(dash);
  dash.querySelectorAll('[data-more]').forEach((a) => {
    const groups = [a.dataset.more, a.dataset.moreAlso].filter(Boolean);
    const n = +a.dataset.extra + groups.reduce((k, g) => k + dash.querySelectorAll(`[data-trim="${g}"][hidden]`).length, 0);
    a.textContent = `+${n} more`;
    a.hidden = !n;
  });
}

/* ---------- Layout & edit mode ---------- */
const DIRS = [['left', 'Move left', 'left'], ['up', 'Move up', 'up'], ['down', 'Move down', 'down'], ['right', 'Move right', 'right']];
function editPanel(id, html, ci, i, colLen, size) {
  const p = PANELS[id];
  const can = { left: ci > 0, right: ci < COLS - 1, up: i > 0, down: i < colLen - 1 };
  const body = html || `<section class="card dash-empty"><h3>${icon(p.icon)} ${esc(p.title)}</h3><p class="small faint">Nothing to show right now. It appears when there is.</p></section>`;
  return `<div class="dash-panel" data-panel="${id}">
    <div class="dp-bar">
      <span class="dp-handle" data-dash-handle title="Drag to move" aria-hidden="true">${icon('grip')}</span>
      <span class="dp-name">${esc(p.title)}</span>
      ${DIRS.map(([dir, label, ic]) => `<button class="icon-btn small dp-${dir}" data-action="dash-move" data-panel="${id}" data-dir="${dir}" aria-label="${label}: ${esc(p.title)}" title="${label}" ${can[dir] ? '' : 'disabled'}>${icon(ic)}</button>`).join('')}
      <button class="icon-btn small danger" data-action="dash-remove" data-panel="${id}" aria-label="Remove ${esc(p.title)}" title="Remove from the Dashboard">${icon('close')}</button>
    </div>${body}
    <div class="dp-resize" data-resize-panel="${id}" title="Drag to resize · double-click for automatic height">
      <span class="dp-resize-bar"></span><small data-size-label>${size ? `${size} px` : 'Auto height'}</small></div></div>`;
}

/** A fixed height on a card: `data-size` + `--ph` on its <section> (CSS applies it on wider screens). */
const sized = (html, h) => (h && html ? html.replace(/^\s*<section /, `<section data-size="${h}" style="--ph:${h}px" `) : html);

function editTray(hidden) {
  return `<div class="card dash-tray">
    <p><b>Editing the Dashboard.</b> Drag panels to move them${matchMedia('(pointer: coarse)').matches ? ' (hold the ⠿ handle)' : ''}, or use the arrows. Drag a panel's bottom edge to resize it, and the lines between columns to change their width. <kbd>Esc</kbd> or <b>Done</b> when you're finished.</p>
    <div class="dash-tray-add">${hidden.length
      ? `<span class="small faint">Add a panel:</span>${hidden.map((id) => `<button class="btn small" data-action="dash-add" data-panel="${id}">${icon('plus')} ${esc(PANELS[id].title)}</button>`).join('')}`
      : '<span class="small faint">Every panel is on the Dashboard. Remove one with its ✕.</span>'}</div>
  </div>`;
}

export function renderDashboard() {
  const t = today();
  ensureRange(t, addDays(t, 1));
  ensureMusic();
  ensureWhatsApp();
  const now = nowMin();
  const items = timedItems(t);
  const RENDER = {
    hero: () => heroCard(now, items),
    exams: examsCard,
    agenda: () => timelineCard(now, items),
    nownext: () => nowNextCard(now, items),
    music: musicCard,
    tasks: tasksCard,
    habits: habitsCard,
    weather: weatherCard,
    whatsapp: whatsappCard,
    tomorrow: tomorrowCard,
  };
  const { cols, hidden, custom, sizes, widths } = layout();
  const editing = isEditing();
  const colHtml = (ids, ci) => (editing
    ? `${ids.map((id, i) => editPanel(id, sized(RENDER[id](), sizes[id]), ci, i, ids.length, sizes[id])).join('')}<div class="dash-drop-end">Drop panels here</div>
       ${ci < COLS - 1 ? `<div class="dash-col-resize" data-resize-col="${ci}" title="Drag to change the column widths"></div>` : ''}`
    : ids.map((id) => sized(RENDER[id](), sizes[id])).join(''));
  return `${editing ? editTray(hidden) : ''}<div class="dash ${custom ? 'custom' : ''} ${editing ? 'editing' : ''}" style="${widths.map((w, k) => `--c${k + 1}:${w}fr`).join(';')}">
    ${cols.map((ids, ci) => `<div class="dash-col ${ci === 0 ? 'dash-main' : ''}" ${editing ? `data-col="${ci}" data-col-label="Column ${ci + 1}"` : ''}>${colHtml(ids, ci)}</div>`).join('')}
  </div>`;
}
