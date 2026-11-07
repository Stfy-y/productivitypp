#!/usr/bin/env node
/* Productivity++ WhatsApp helper (Linux).
 *
 * Browsers can't read WhatsApp, so this small local server signs in to your account as a
 * "Linked device" (like WhatsApp Web, through whatsapp-web.js and a headless Chrome) and hands the
 * chats with unread messages to the app's Dashboard at http://127.0.0.1:8972.
 *
 * - It only reads. It never sends messages and never marks anything as read.
 * - It only listens on this computer, and only the app's own web addresses may read it.
 * - The login is stored in the session folder (see --data). Unlink it any time from your phone:
 *   WhatsApp → Settings → Linked devices.
 *
 * Usage: whatsapp-helper.js [--port 8972] [--origin https://you.github.io] [--chrome /usr/bin/google-chrome] [--data DIR]
 */
'use strict';
const http = require('http');
const os = require('os');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

/* ---------- Options ---------- */
const opts = { port: 8972, origins: new Set(), chrome: '', data: '' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === '--port') { opts.port = Number(v); i++; }
  else if (a === '--origin') { opts.origins.add(String(v).replace(/\/+$/, '')); i++; }
  else if (a === '--chrome') { opts.chrome = v; i++; }
  else if (a === '--data') { opts.data = v; i++; }
  else if (a === '-h' || a === '--help') { console.log('Usage: whatsapp-helper.js [--port 8972] [--origin URL]... [--chrome PATH] [--data DIR]'); process.exit(0); }
  else { console.error(`Unknown option: ${a}`); process.exit(2); }
}
const dataDir = opts.data || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'productivitypp/whatsapp/session');

const PREVIEWS = 3; // newest unread messages shown per chat
const RESYNC_MS = 60 * 1000; // full re-read now and then, in case an event was missed

/* ---------- State ---------- */
// status: starting → qr (scan it) → loading → ready; error when something went wrong
const state = { status: 'starting', progress: 0, qr: '', error: '', me: '' };
let snapshot = { chats: [], total: 0, updated: 0 };

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: dataDir }),
  puppeteer: {
    headless: true,
    executablePath: opts.chrome || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'],
  },
});

client.on('qr', async (qr) => {
  state.status = 'qr';
  state.error = '';
  try { state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 264 }); } catch { state.qr = ''; }
  console.log('Waiting for you to link this computer: open the app\'s Dashboard and scan the code with your phone.');
});
client.on('loading_screen', (p) => { state.status = 'loading'; state.progress = Number(p) || 0; });
client.on('authenticated', () => { state.status = 'loading'; state.qr = ''; });
client.on('auth_failure', (m) => { state.status = 'error'; state.error = `WhatsApp didn't accept the link (${m}). Try again in a minute.`; });
client.on('ready', () => {
  state.status = 'ready';
  state.qr = '';
  state.error = '';
  state.me = client.info?.pushname || '';
  console.log(`Linked to WhatsApp${state.me ? ` as ${state.me}` : ''}.`);
  refreshSoon(0);
});
client.on('disconnected', (reason) => {
  // unlinked from the phone, or the session broke: start over (systemd restarts us) so a new code shows
  console.log(`Disconnected from WhatsApp (${reason}). Restarting.`);
  state.status = 'starting';
  setTimeout(() => process.exit(1), 500);
});
for (const ev of ['message', 'message_create', 'message_revoke_everyone', 'unread_count', 'chat_archived', 'chat_removed', 'change_state']) {
  client.on(ev, () => refreshSoon());
}

/* ---------- Reading unread chats ---------- */
const SKIP_TYPES = new Set(['e2e_notification', 'notification', 'notification_template', 'gp2', 'protocol', 'broadcast_notification']);
function preview(m) {
  const cap = m.body ? `: ${m.body}` : '';
  switch (m.type) {
    case 'chat': return m.body;
    case 'image': return `📷 Photo${cap}`;
    case 'video': return `🎥 Video${cap}`;
    case 'gif': return `🎞️ GIF${cap}`;
    case 'ptt': return '🎤 Voice message';
    case 'audio': return '🎵 Audio';
    case 'document': return `📄 ${m.filename || 'Document'}`;
    case 'sticker': return '💟 Sticker';
    case 'location': return '📍 Location';
    case 'vcard': case 'multi_vcard': return '👤 Contact';
    case 'poll_creation': return `📊 Poll: ${m.pollName || ''}`.trim();
    case 'revoked': return '🚫 This message was deleted';
    case 'call_log': return '📞 Call';
    case 'ciphertext': return '⏳ Waiting for this message';
    default: return m.body || 'Message';
  }
}

/* Reads the unread chats straight from WhatsApp Web's in-memory chat list, in one call.
   (client.getChats() builds a full model of every chat and refreshes every group's members over the
   network; one chat failing there fails the whole list.) Each chat is read on its own, so a chat
   that can't be read is skipped instead of hiding the rest. Runs inside the page: no closures. */
async function readUnreadInPage(previews) {
  const need = (m) => { try { return window.require(m); } catch { return null; } };
  const { Chat, Contact } = need('WAWebCollections') || {};
  const lid = need('WAWebLidMigrationUtils');
  const loader = need('WAWebChatLoadMessages');
  // chats whose earlier messages were already loaded for this version of the chat (only try once)
  const tried = (window.__pppLoaded ??= new Set());
  if (!Chat) throw new Error('WhatsApp Web isn\'t ready yet');
  const idOf = (w) => (w ? w._serialized || String(w) : '');
  const nameOf = (wid, fallback) => {
    try {
      const c = Contact?.get(idOf(wid));
      const n = c?.name || c?.pushname || c?.verifiedName || fallback;
      if (n) return n;
      const pn = wid?.server === 'lid' ? lid?.toPn?.(wid) : wid;
      return pn?.user ? `+${pn.user}` : c?.formattedName || '';
    } catch { return fallback || ''; }
  };
  const out = [];
  const errors = [];
  for (const chat of Chat.getModelsArray()) {
    try {
      const id = idOf(chat.id);
      if (chat.archive || id === 'status@broadcast' || /@(broadcast|newsletter)$/.test(id)) continue;
      let unread = chat.unreadCount || 0;
      if (!unread && chat.markedUnread) unread = -1;
      if (!unread) continue;
      const isGroup = chat.id?.server === 'g.us';
      let phone = '';
      if (!isGroup) {
        if (chat.id?.server === 'c.us') phone = chat.id.user;
        else { try { const pn = lid?.toPn?.(chat.id); if (pn?.server === 'c.us') phone = pn.user; } catch { /* no number */ } }
      }
      const want = unread > 0 ? Math.min(unread, previews) : 0;
      const incoming = () => (chat.msgs?.getModelsArray?.() || []).filter((m) => !m.id?.fromMe && !m.isNotification);
      // WhatsApp Web only keeps the newest message of chats you haven't opened: load a few more (doesn't mark them read)
      const key = `${id}|${chat.t}|${want}`;
      if (incoming().length < want && loader?.loadEarlierMsgs && !tried.has(key)) {
        tried.add(key);
        for (let i = 0; i < Math.ceil(want / 20) + 1 && incoming().length < want; i++) {
          const got = await loader.loadEarlierMsgs({ chat }).catch(() => null);
          if (!got?.length) break;
        }
      }
      const msgs = incoming();
      const messages = msgs.slice(-(want + 6)).map((m) => ({
        type: m.type, body: m.type === 'chat' ? m.body : (m.caption || ''), ts: m.t || 0,
        filename: m.filename || '', pollName: m.pollName || '',
        author: isGroup ? nameOf(m.author, m.notifyName) : '',
      }));
      out.push({
        id,
        name: chat.formattedTitle || chat.name || nameOf(chat.id, '') || chat.id?.user || 'Unknown',
        isGroup,
        pinned: !!chat.pin,
        muted: (chat.mute?.expiration ?? 0) !== 0,
        unread,
        ts: chat.t || 0,
        phone,
        want,
        messages,
      });
    } catch (e) { errors.push(String(e?.message || e)); }
  }
  return { chats: out, errors };
}

let lastErrors = '';
/** Unread chats with up to `previews` of their newest unread messages each, in the Dashboard's order. */
async function readUnread(previews) {
  const { chats, errors } = await client.pupPage.evaluate(readUnreadInPage, previews);
  const errText = errors.slice(0, 3).join(' | ');
  if (errors.length && errText !== lastErrors) console.error(`Skipped ${errors.length} chat(s) that couldn't be read: ${errText}`);
  lastErrors = errText;
  const out = chats.map(({ want, messages, ...c }) => {
    const shown = messages.filter((m) => !SKIP_TYPES.has(m.type));
    return { ...c, messages: (want ? shown.slice(-want) : []).map((m) => ({ text: String(preview(m) || '').slice(0, 300), ts: m.ts, author: m.author })) };
  });
  // pinned first, then people, then groups; newest first inside each
  const rank = (c) => (c.pinned ? 0 : c.isGroup ? 2 : 1);
  out.sort((a, b) => rank(a) - rank(b) || b.ts - a.ts);
  return { chats: out, total: out.reduce((n, c) => n + Math.max(1, c.unread), 0), updated: Date.now() };
}

async function refresh() {
  if (state.status !== 'ready') return;
  snapshot = await readUnread(PREVIEWS);
}

let refreshT = null;
let refreshing = false;
let again = false;
function refreshSoon(ms = 800) {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try { await refresh(); } catch (e) { console.error('Reading chats failed:', e?.stack || e?.message || e); } finally {
      refreshing = false;
      if (again) { again = false; refreshSoon(); }
    }
  }, ms);
}
setInterval(() => refreshSoon(0), RESYNC_MS);

/* ---------- HTTP ---------- */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const originOk = (o) => !o || LOCAL_ORIGIN.test(o) || opts.origins.has(o);
// Host must be this computer: stops a website from reaching us through DNS rebinding
const hostOk = (h) => new RegExp(`^(localhost|127\\.0\\.0\\.1)(:${opts.port})?$`).test(h || '');

function send(req, res, code, data) {
  const o = req.headers.origin;
  const body = data == null ? '' : JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) };
  if (o && originOk(o)) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': o,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin',
    });
  }
  res.writeHead(code, headers);
  res.end(body);
}

const status = () => ({ status: state.status, progress: state.progress, error: state.error, me: state.me });

const server = http.createServer(async (req, res) => {
  if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) return send(req, res, 403, { error: 'not allowed' });
  if (req.method === 'OPTIONS') return send(req, res, 204);
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/') return send(req, res, 200, { app: 'productivitypp-whatsapp', ok: true, ...status() });
  if (req.method === 'GET' && url === '/unread') {
    // ?previews=N (up to 50): every chat with up to N unread messages, read fresh (the app's "all messages" window)
    const n = Math.min(50, Number(new URLSearchParams(req.url.split('?')[1] || '').get('previews')) || 0);
    if (n > PREVIEWS && state.status === 'ready') {
      try { return send(req, res, 200, { ...status(), qr: '', ...(await readUnread(n)) }); } catch (e) { return send(req, res, 500, { error: e.message }); }
    }
    return send(req, res, 200, { ...status(), qr: state.status === 'qr' ? state.qr : '', ...(state.status === 'ready' ? snapshot : { chats: [], total: 0, updated: 0 }) });
  }
  if (req.method === 'POST' && url === '/logout') {
    send(req, res, 200, { ok: true });
    console.log('Unlinking from WhatsApp (asked by the app).');
    try { await client.logout(); } catch { /* restart anyway */ }
    setTimeout(() => process.exit(1), 500);
    return;
  }
  send(req, res, 404, { error: 'not found' });
});

server.listen(opts.port, '127.0.0.1', () => {
  console.log(`WhatsApp helper on http://127.0.0.1:${opts.port} (apps allowed: localhost${[...opts.origins].map((o) => `, ${o}`).join('')})`);
});

async function shutdown() {
  server.close();
  try { await client.destroy(); } catch { /* already gone */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

client.initialize().catch((e) => {
  state.status = 'error';
  state.error = `Couldn't start WhatsApp: ${e.message}`;
  console.error(state.error);
  setTimeout(() => process.exit(1), 30000); // systemd restarts us
});
