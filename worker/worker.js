/**
 * Productivity++ sync & push worker (Cloudflare Workers free plan).
 *
 * Bindings (Settings → Variables / Bindings in the Cloudflare dashboard):
 *   KV       KV namespace binding (required)
 *   TOKEN    Secret: any long random string; the same value goes in the app's Settings
 *   SUBJECT  Variable (optional): "mailto:you@example.com", used in push requests
 * Trigger: Cron "* * * * *" (every minute) for reminders.
 *
 * Endpoints (all but /vapid need "Authorization: Bearer TOKEN" or ?token=TOKEN):
 *   GET  /state              -> stored tasks & habits
 *   PUT  /state              -> merge client state, return merged
 *   GET  /vapid              -> { publicKey } (generated on first call)
 *   POST /subscribe          -> save a push subscription
 *   POST /unsubscribe        -> remove a push subscription
 *   GET  /due                -> notifications due in the last few minutes (the service worker calls this on push)
 *   POST /test-push          -> send a test push to every device
 *   GET  /widget[?format=html] -> today's summary for home-screen widgets
 *   /gcal/*                  -> Google Calendar (status, auth-url, callback, calendars, prefs, events, task, disconnect)
 *
 * Google Calendar (optional) secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. See README.md.
 */

/* ---------- Shared logic (copy of js/shared.js) ---------- */
const TOMBSTONE_TTL = 60 * 864e5;
function mergeLog(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) if (!out[k] || (v?.t || 0) > (out[k]?.t || 0)) out[k] = v;
  return out;
}
function mergeItems(a = [], b = [], withLog = false) {
  const map = new Map();
  for (const x of a) map.set(x.id, x);
  for (const y of b) {
    const x = map.get(y.id);
    if (!x) { map.set(y.id, y); continue; }
    const win = (y.updatedAt || 0) > (x.updatedAt || 0) ? y : x;
    map.set(y.id, withLog ? { ...win, log: mergeLog(x.log, y.log) } : win);
  }
  const cutoff = Date.now() - TOMBSTONE_TTL;
  return [...map.values()].filter((i) => !(i.deleted && (i.updatedAt || 0) < cutoff));
}
/* ---------- Repeating events ---------- */
// e.repeat = { freq: 'daily'|'weekly'|'monthly'|'yearly', interval: 1, days: [0-6] (weekly), until: 'YYYY-MM-DD' }
// e.exdates = ['YYYY-MM-DD', ...] occurrences that were deleted or moved
const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const wdOf = (n) => (((n % 7) + 7 + 4) % 7); // day 0 (1970-01-01) was a Thursday
const weekIdx = (n) => Math.floor((n - ((wdOf(n) + 6) % 7)) / 7); // Monday-based weeks

function occursOn(e, d) {
  if (!e || e.deleted || !e.date || !d) return false;
  const r = e.repeat;
  if (!r || !r.freq) return e.date === d;
  if (d < e.date || (r.until && d > r.until) || (e.exdates || []).includes(d)) return false;
  const n = Math.max(1, Math.floor(Number(r.interval)) || 1);
  const a = dayNum(e.date), b = dayNum(d);
  switch (r.freq) {
    case 'daily': return (b - a) % n === 0;
    case 'weekly': {
      const days = Array.isArray(r.days) && r.days.length ? r.days : [wdOf(a)];
      return days.includes(wdOf(b)) && (weekIdx(b) - weekIdx(a)) % n === 0;
    }
    case 'monthly': {
      if (d.slice(8) !== e.date.slice(8)) return false;
      const months = (+d.slice(0, 4) * 12 + +d.slice(5, 7)) - (+e.date.slice(0, 4) * 12 + +e.date.slice(5, 7));
      return months % n === 0;
    }
    case 'yearly': return d.slice(5) === e.date.slice(5) && (+d.slice(0, 4) - +e.date.slice(0, 4)) % n === 0;
    default: return false;
  }
}

const addDaysStr = (s, k) => new Date((dayNum(s) + k) * 864e5).toISOString().slice(0, 10);

function shiftMinutes(key, mins) {
  const [d, hm] = key.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [H, M] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, H, M) + mins * 60000).toISOString().slice(0, 16);
}
function localMinuteKey(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function remindersAt(state, minuteKey, allDayTime = '09:00') {
  const out = [];
  const [date, hm] = minuteKey.split('T');
  for (const t of state.tasks || []) {
    if (t.deleted || t.done || !t.date || t.remind == null || t.remind === '') continue;
    const at = shiftMinutes(`${t.date}T${t.time || allDayTime}`, -Number(t.remind));
    if (at !== minuteKey) continue;
    const when = t.time ? `Due ${t.date === date ? 'today' : t.date} at ${t.time}` : `Due ${t.date === date ? 'today' : t.date}`;
    out.push({ tag: `t-${t.id}-${t.date}`, title: t.title, body: t.notes ? `${when} · ${t.notes.slice(0, 80)}` : when, url: `./#/task/${t.id}`, kind: 'task', id: t.id });
  }
  for (const ev of state.events || []) {
    if (ev.deleted || !ev.date || ev.remind == null || ev.remind === '') continue;
    // the occurrence can be today or up to 2 days ahead (reminders go up to 1 day early)
    for (let k = 0; k <= 2; k++) {
      const occ = addDaysStr(date, k);
      if (!occursOn(ev, occ)) continue;
      const at = shiftMinutes(`${occ}T${ev.time || allDayTime}`, -Number(ev.remind));
      if (at !== minuteKey) continue;
      const when = ev.time ? `${occ === date ? 'Today' : occ} at ${ev.time}` : `${occ === date ? 'Today' : occ} (all day)`;
      out.push({ tag: `e-${ev.id}-${occ}`, title: ev.title, body: [when, ev.location].filter(Boolean).join(' · '), url: './#/calendar', kind: 'event', id: ev.id });
    }
  }
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  for (const h of state.habits || []) {
    if (h.deleted || h.archived || !h.remind || h.remind !== hm) continue;
    if (Array.isArray(h.days) && h.days.length && !h.days.includes(wd)) continue;
    if ((h.log?.[date]?.c || 0) >= (h.goal || 1)) continue;
    out.push({ tag: `h-${h.id}-${date}`, title: `${h.icon || ''} ${h.name}`.trim(), body: 'Time for your habit. Tap to check in.', url: './#/habits', kind: 'habit', id: h.id, date });
  }
  return out;
}

/* ---------- Helpers ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
// Non-ASCII is sent as \uXXXX escapes and the charset is explicit: some clients (e.g. iOS widgets)
// would otherwise decode UTF-8 as Latin-1 and show garbage like "Â·".
const asciiJson = (data) => JSON.stringify(data).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const json = (data, status = 200) => new Response(asciiJson(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (s) => new TextEncoder().encode(s);

async function getState(env) {
  return (await env.KV.get('state', 'json')) || { tasks: [], habits: [], events: [], tz: 'UTC', allDay: '09:00' };
}
async function getSubs(env) { return (await env.KV.get('subs', 'json')) || []; }

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- Web Push (VAPID, payload-less) ---------- */
async function getVapid(env) {
  let v = await env.KV.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), publicKey: b64url(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    await env.KV.put('vapid', JSON.stringify(v));
  }
  return v;
}

async function sendPush(env, sub, vapid) {
  const aud = new URL(sub.endpoint).origin;
  const header = b64url(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.SUBJECT || 'mailto:productivity@example.com' })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${header}.${claims}`));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`, TTL: '600', Urgency: 'high', 'Content-Length': '0' },
  });
  return res.status;
}

async function pushAll(env) {
  const subs = await getSubs(env);
  if (!subs.length) return { sent: 0 };
  const vapid = await getVapid(env);
  const statuses = await Promise.all(subs.map((s) => sendPush(env, s, vapid).catch(() => 0)));
  const alive = subs.filter((_, i) => ![404, 410].includes(statuses[i]));
  if (alive.length !== subs.length) await env.KV.put('subs', JSON.stringify(alive));
  return { sent: subs.length, statuses };
}

function dueNow(state, minutesBack = 3) {
  const tz = state.tz || 'UTC';
  const now = localMinuteKey(new Date(), tz);
  const seen = new Set();
  const out = [];
  for (let i = minutesBack; i >= 0; i--) {
    for (const n of remindersAt(state, shiftMinutes(now, -i), state.allDay)) {
      if (!seen.has(n.tag)) { seen.add(n.tag); out.push(n); }
    }
  }
  return out;
}

/* ---------- Widget ---------- */
function widgetData(state) {
  const tz = state.tz || 'UTC';
  const today = localMinuteKey(new Date(), tz).slice(0, 10);
  const wd = new Date(today + 'T12:00:00Z').getUTCDay();
  const q = (t) => (t.important ? (t.urgent ? 1 : 2) : (t.urgent ? 3 : 4));
  const tasks = (state.tasks || [])
    .filter((t) => !t.deleted && !t.done && t.date && t.date <= today)
    .sort((a, b) => q(a) - q(b) || (a.time || '99').localeCompare(b.time || '99'))
    .map((t) => ({ title: t.title, time: t.time, duration: Number(t.duration) || 30, overdue: t.date < today, quadrant: q(t) }));
  const habits = (state.habits || [])
    .filter((h) => !h.deleted && !h.archived && (!h.days?.length || h.days.includes(wd)))
    .map((h) => ({ name: h.name, icon: h.icon, count: h.log?.[today]?.c || 0, goal: h.goal || 1, done: (h.log?.[today]?.c || 0) >= (h.goal || 1) }));
  // Your own events for today (Google events are added in widgetWithGoogle)
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : 0; };
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const events = (state.events || [])
    .filter((e) => occursOn(e, today))
    .map((e) => ({
      title: e.title, allDay: !e.time, time: e.time || null, color: e.color || '#4f6bed', location: e.location || '',
      end: e.time ? hhmm(Math.min(1439, toMin(e.time) + (Number(e.duration) || 60))) : null,
    }));
  return { date: today, tz, tasks, habits, events: sortEvents(events) };
}

const sortEvents = (list) => list.sort((a, b) => (b.allDay - a.allDay) || (a.time || '').localeCompare(b.time || ''));

/** Adds today's Google Calendar events when Google is connected (never fails the widget). */
async function widgetWithGoogle(env, state) {
  const d = widgetData(state);
  try {
    if (!gConfigured(env) || !(await env.KV.get('gcal', 'json'))?.refresh) return d;
    const local = (iso) => localMinuteKey(new Date(iso), d.tz);
    for (const e of await gEvents(env, d.date, d.date)) {
      if (e.allDay) {
        if (e.start <= d.date && d.date < e.end) d.events.push({ title: e.title, allDay: true, time: null, end: null, color: e.color, location: e.location || '' });
        continue;
      }
      const s = local(e.start), en = local(e.end);
      if (s.slice(0, 10) > d.date || en.slice(0, 10) < d.date) continue;
      d.events.push({
        title: e.title, allDay: false, color: e.color, location: e.location || '',
        time: s.slice(0, 10) === d.date ? s.slice(11) : '00:00', end: en.slice(0, 10) === d.date ? en.slice(11) : '23:59',
      });
    }
    sortEvents(d.events);
  } catch { /* Google is optional */ }
  return d;
}

function widgetHtml(d) {
  const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = { 1: '#e5484d', 2: '#f5a524', 3: '#3b82f6', 4: '#22a06b' };
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="900">
<style>body{font:15px system-ui;margin:12px;background:#121318;color:#e9eaf0}h1{font-size:15px;margin:0 0 8px}li{margin:4px 0}ul{padding:0;list-style:none}i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.o{color:#e5484d}</style>
<h1>${d.date} · ${d.tasks.length} tasks</h1><ul>${d.tasks.slice(0, 8).map((t) => `<li><i style="background:${col[t.quadrant]}"></i>${e(t.title)} ${t.overdue ? '<span class="o">overdue</span>' : t.time || ''}</li>`).join('')}</ul>
<ul>${d.habits.map((h) => `<li>${h.done ? '✅' : '⬜'} ${e(h.icon)} ${e(h.name)}</li>`).join('')}</ul>`;
}

/* ---------- Google Calendar (optional: needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) ---------- */
const GSCOPES = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events';
const GAPI = 'https://www.googleapis.com/calendar/v3';
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const gId = (env) => String(env.GOOGLE_CLIENT_ID || '').trim().replace(/^["']|["']$/g, '');
const gSecret = (env) => String(env.GOOGLE_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, '');
const gConfigured = (env) => !!(gId(env) && gSecret(env));
/** Catch the common copy/paste mistakes before Google returns a vague "client not found". */
function gConfigProblem(env) {
  const id = gId(env), secret = gSecret(env);
  if (!id || !secret) return 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the worker first';
  if (id.startsWith('GOCSPX-')) return 'GOOGLE_CLIENT_ID contains the client SECRET (starts with GOCSPX-). Swap the two values.';
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) return `GOOGLE_CLIENT_ID doesn't look like a Client ID (it should look like 1234567890-abc123.apps.googleusercontent.com). Got: "${id.slice(0, 12)}…"`;
  if (secret.endsWith('.apps.googleusercontent.com')) return 'GOOGLE_CLIENT_SECRET contains the Client ID. Swap the two values.';
  return '';
}
const gRedirect = (url) => `${url.origin}/gcal/callback`;

async function gToken(env) {
  const g = await env.KV.get('gcal', 'json');
  if (!g?.refresh) throw new HttpError(409, 'Google Calendar is not connected');
  if (g.access && g.exp > Date.now() + 60000) return g.access;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: gId(env), client_secret: gSecret(env), refresh_token: g.refresh, grant_type: 'refresh_token' }),
  });
  const j = await res.json();
  if (!res.ok) {
    if (j.error === 'invalid_grant') await env.KV.delete('gcal');
    throw new HttpError(409, `Google sign-in expired, please reconnect (${j.error})`);
  }
  g.access = j.access_token;
  g.exp = Date.now() + j.expires_in * 1000;
  await env.KV.put('gcal', JSON.stringify(g));
  return g.access;
}

async function gApi(env, path, opts = {}) {
  const res = await fetch(GAPI + path, { ...opts, headers: { Authorization: `Bearer ${await gToken(env)}`, 'Content-Type': 'application/json' } });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, j.error?.message || `Google API error ${res.status}`);
  return j;
}

const gPrefs = async (env) => (await env.KV.get('gcalprefs', 'json')) || {};

async function gCalendars(env) {
  const prefs = await gPrefs(env);
  const j = await gApi(env, '/users/me/calendarList?maxResults=250&fields=items(id,summary,summaryOverride,backgroundColor,primary,selected,accessRole)');
  return (j.items || []).map((c) => ({
    id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor || '#4f6bed', primary: !!c.primary,
    writable: ['owner', 'writer'].includes(c.accessRole),
    show: prefs.show ? prefs.show.includes(c.id) : !!(c.selected || c.primary),
  }));
}

async function gEvents(env, start, end) {
  const cals = (await gCalendars(env)).filter((c) => c.show);
  // Pad by a day on each side; the app filters by local date.
  const timeMin = new Date(Date.parse(`${start}T00:00:00Z`) - 864e5).toISOString();
  const timeMax = new Date(Date.parse(`${end}T00:00:00Z`) + 2 * 864e5).toISOString();
  const lists = await Promise.all(cals.map(async (c) => {
    const q = new URLSearchParams({
      singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '500',
      fields: 'items(id,summary,start,end,htmlLink,location,status,description,hangoutLink,organizer(displayName,email,self),attendees(email,displayName,self,responseStatus,organizer))',
    });
    try {
      const j = await gApi(env, `/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      return (j.items || [])
        .filter((e) => e.status !== 'cancelled' && !(e.attendees || []).some((a) => a.self && a.responseStatus === 'declined'))
        .map((e) => ({
          id: e.id, cal: c.id, title: e.summary || '(No title)', allDay: !e.start?.dateTime,
          start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
          color: c.color, link: e.htmlLink, location: e.location || '', calName: c.name,
          description: (e.description || '').slice(0, 4000), meet: e.hangoutLink || '',
          organizer: e.organizer && !e.organizer.self ? (e.organizer.displayName || e.organizer.email || '') : '',
          attendees: (e.attendees || []).slice(0, 25).map((a) => ({
            name: a.displayName || a.email || '', email: a.email || '', status: a.responseStatus || 'needsAction', self: !!a.self, organizer: !!a.organizer,
          })),
        }));
    } catch { return []; }
  }));
  return lists.flat();
}

function taskToEvent(t, tz) {
  const ev = { summary: t.title, description: `${t.notes ? t.notes + '\n\n' : ''}Added from Productivity++` };
  if (t.time) {
    ev.start = { dateTime: `${t.date}T${t.time}:00`, timeZone: tz };
    ev.end = { dateTime: `${shiftMinutes(`${t.date}T${t.time}`, Math.max(5, Number(t.duration) || 30))}:00`, timeZone: tz };
  } else {
    const d = new Date(`${t.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    ev.start = { date: t.date };
    ev.end = { date: d.toISOString().slice(0, 10) };
  }
  return ev;
}

async function gCallback(url, env) {
  const page = (title, msg, ret) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font:16px system-ui;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center">
<h2>${title}</h2><p>${msg}</p>${ret ? `<p><a href="${ret}" style="color:#4f6bed;font-weight:600">Back to Productivity++</a></p>` : ''}
<script>setTimeout(()=>{try{window.close()}catch(e){}},1500)</script></body>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const state = url.searchParams.get('state') || '';
  const saved = state && await env.KV.get(`gstate:${state}`, 'json');
  if (!saved) return page('Link expired', 'Please start the connection again from the app.');
  await env.KV.delete(`gstate:${state}`);
  if (url.searchParams.get('error')) return page('Not connected', `Google said: ${url.searchParams.get('error')}`, saved.ret);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      code: url.searchParams.get('code'), client_id: gId(env), client_secret: gSecret(env),
      redirect_uri: gRedirect(url), grant_type: 'authorization_code',
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.refresh_token) return page('Not connected', `Token exchange failed: ${j.error_description || j.error || 'no refresh token'}`, saved.ret);
  await env.KV.put('gcal', JSON.stringify({ refresh: j.refresh_token, access: j.access_token, exp: Date.now() + j.expires_in * 1000 }));
  try {
    const primary = (await gCalendars(env)).find((c) => c.primary);
    if (primary) { const g = await env.KV.get('gcal', 'json'); g.email = primary.id; await env.KV.put('gcal', JSON.stringify(g)); }
  } catch { /* email is cosmetic */ }
  return page('Google Calendar connected ✓', 'You can close this window and go back to the app.', saved.ret);
}

async function gRoute(path, req, env, url) {
  if (path === '/gcal/status') {
    const g = await env.KV.get('gcal', 'json');
    const prefs = await gPrefs(env);
    return json({ configured: gConfigured(env), problem: gConfigProblem(env), clientIdEnd: gId(env).slice(-40), redirectUri: gRedirect(url), connected: !!g?.refresh, email: g?.email || '', target: prefs.target || 'primary' });
  }
  const problem = gConfigProblem(env);
  if (problem) throw new HttpError(501, problem);
  if (path === '/gcal/auth-url') {
    const ret = url.searchParams.get('return') || '';
    if (ret && !/^https?:\/\//.test(ret)) throw new HttpError(400, 'bad return url');
    const state = crypto.randomUUID();
    await env.KV.put(`gstate:${state}`, JSON.stringify({ ret }), { expirationTtl: 900 });
    const q = new URLSearchParams({
      client_id: gId(env), redirect_uri: gRedirect(url), response_type: 'code', scope: GSCOPES,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    });
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
  }
  if (path === '/gcal/disconnect' && req.method === 'POST') {
    const g = await env.KV.get('gcal', 'json');
    if (g?.refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refresh)}`, { method: 'POST' }).catch(() => {});
    await env.KV.delete('gcal');
    return json({ ok: true });
  }
  if (path === '/gcal/calendars') return json(await gCalendars(env));
  if (path === '/gcal/prefs' && req.method === 'PUT') {
    const body = await req.json();
    const prefs = { ...(await gPrefs(env)), ...(Array.isArray(body.show) ? { show: body.show } : {}), ...(body.target ? { target: body.target } : {}) };
    await env.KV.put('gcalprefs', JSON.stringify(prefs));
    return json(prefs);
  }
  if (path === '/gcal/events') {
    const start = url.searchParams.get('start'), end = url.searchParams.get('end');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) throw new HttpError(400, 'start/end must be YYYY-MM-DD');
    return json(await gEvents(env, start, end));
  }
  if (path === '/gcal/task' && (req.method === 'POST' || req.method === 'PUT')) {
    const { task, tz, cal, id } = await req.json();
    if (!task?.date) throw new HttpError(400, 'task needs a date');
    const zone = tz || (await getState(env)).tz || 'UTC';
    const body = JSON.stringify(taskToEvent(task, zone));
    const target = (await gPrefs(env)).target || 'primary';
    if (req.method === 'PUT' && id) {
      try {
        const ev = await gApi(env, `/calendars/${encodeURIComponent(cal || target)}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body });
        return json({ cal: cal || target, id: ev.id });
      } catch (e) {
        if (![404, 410].includes(e.status)) throw e; // event was deleted in Google: recreate below
      }
    }
    const ev = await gApi(env, `/calendars/${encodeURIComponent(target)}/events`, { method: 'POST', body });
    return json({ cal: target, id: ev.id });
  }
  if (path === '/gcal/task/delete' && req.method === 'POST') {
    const { cal, id } = await req.json();
    try { await gApi(env, `/calendars/${encodeURIComponent(cal || 'primary')}/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (e) { if (![404, 410].includes(e.status)) throw e; }
    return json({ ok: true });
  }
  throw new HttpError(404, 'not found');
}

/* ---------- Router ---------- */
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!env.KV) return json({ error: 'KV binding missing: bind a KV namespace as "KV"' }, 500);
    if (path === '/') return json({ ok: true, app: 'productivity-sync' });
    if (path === '/vapid') return json({ publicKey: (await getVapid(env)).publicKey });
    if (path === '/gcal/callback') return gCallback(url, env);

    if (!env.TOKEN) return json({ error: 'TOKEN secret not set' }, 500);
    const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    if (!timingSafeEqual(given, env.TOKEN)) return json({ error: 'unauthorized' }, 401);

    if (path === '/state' && req.method === 'GET') return json(await getState(env));
    if (path === '/state' && req.method === 'PUT') {
      const body = await req.json();
      const cur = await getState(env);
      const next = {
        tasks: mergeItems(cur.tasks, body.tasks),
        habits: mergeItems(cur.habits, body.habits, true),
        events: mergeItems(cur.events, body.events),
        tz: body.tz || cur.tz || 'UTC',
        allDay: body.allDay || cur.allDay || '09:00',
        updatedAt: Date.now(),
      };
      await env.KV.put('state', JSON.stringify(next));
      return json(next);
    }
    if (path === '/subscribe' && req.method === 'POST') {
      const { sub, device } = await req.json();
      if (!sub?.endpoint) return json({ error: 'bad subscription' }, 400);
      const subs = (await getSubs(env)).filter((s) => s.endpoint !== sub.endpoint);
      subs.push({ endpoint: sub.endpoint, keys: sub.keys, device: device || '', at: Date.now() });
      await env.KV.put('subs', JSON.stringify(subs.slice(-20)));
      return json({ ok: true, devices: subs.length });
    }
    if (path === '/unsubscribe' && req.method === 'POST') {
      const { endpoint } = await req.json();
      const subs = (await getSubs(env)).filter((s) => s.endpoint !== endpoint);
      await env.KV.put('subs', JSON.stringify(subs));
      return json({ ok: true });
    }
    if (path === '/due') {
      const state = await getState(env);
      const items = dueNow(state);
      const test = await env.KV.get('test', 'json');
      if (test && Date.now() - test.at < 5 * 60000) items.push({ tag: 'test-push', title: 'Productivity++', body: 'Background push works 🎉', url: './#/settings' });
      return json(items);
    }
    if (path === '/test-push' && req.method === 'POST') {
      await env.KV.put('test', JSON.stringify({ at: Date.now() }), { expirationTtl: 600 });
      return json(await pushAll(env));
    }
    if (path === '/widget') {
      const d = await widgetWithGoogle(env, await getState(env));
      if (url.searchParams.get('format') === 'html') return new Response(widgetHtml(d), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
      return json(d);
    }
    if (path.startsWith('/gcal/')) {
      try { return await gRoute(path, req, env, url); } catch (e) { return json({ error: e.message }, e.status || 500); }
    }
    return json({ error: 'not found' }, 404);
  },

  // Runs every minute: if anything is due right now, wake every subscribed device.
  async scheduled(event, env, ctx) {
    const state = await getState(env);
    const tz = state.tz || 'UTC';
    const now = localMinuteKey(new Date(event.scheduledTime), tz);
    if (remindersAt(state, now, state.allDay).length) ctx.waitUntil(pushAll(env));
  },
};
