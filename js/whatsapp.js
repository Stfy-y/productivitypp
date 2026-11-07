// Unread WhatsApp chats for the Dashboard, read from the local helper (extras/whatsapp), which signs in to
// WhatsApp as a linked device. Browsers can't reach WhatsApp themselves.
import { settings } from './store.js';

const POLL_MS = 10000;
let data = null; // last answer from /unread
export let waError = '';
let timer = null;
let lastTry = 0;
let onUpdate = () => {};
export const setWhatsAppListener = (fn) => { onUpdate = fn; };

const base = () => (settings.whatsappUrl || 'http://127.0.0.1:8972').replace(/\/+$/, '');
const call = (p, opts = {}) => fetch(`${base()}${p}`, { cache: 'no-store', ...opts });
export const whatsApp = () => (settings.whatsapp ? data : null);

/** Fetch now; re-render only when something changed. */
export async function refreshWhatsApp() {
  lastTry = Date.now();
  try {
    const r = await call('/unread');
    if (!r.ok) throw new Error(`Helper error ${r.status}`);
    const next = await r.json();
    const sig = (d) => (d ? JSON.stringify([d.status, d.progress, d.error, d.qr, d.chats]) : '');
    const changed = sig(next) !== sig(data) || waError;
    data = next;
    waError = '';
    if (changed) onUpdate();
    return true;
  } catch {
    const msg = 'The WhatsApp helper isn\'t running on this computer.';
    const had = data || waError !== msg;
    data = null;
    waError = msg;
    if (had) onUpdate();
    return false;
  }
}

/** Fetch if the last read is old (when the Dashboard opens). */
export function ensureWhatsApp() {
  if (settings.whatsapp && Date.now() - lastTry > POLL_MS) refreshWhatsApp();
}

/** Poll while `isActive()`. While the link code is up, poll faster so the Dashboard follows the scan. */
export function startWhatsApp(isActive) {
  if (timer) return;
  let n = 0;
  timer = setInterval(() => {
    n++;
    if (!settings.whatsapp || !isActive()) return;
    const quick = data && data.status !== 'ready';
    if (quick || n % 5 === 0) refreshWhatsApp();
  }, POLL_MS / 5);
}

/** Every unread chat with up to 50 of its unread messages (for the "all messages" window). Read fresh, not cached. */
export async function loadAllUnread() {
  const r = await call('/unread?previews=50');
  if (!r.ok) throw new Error('Couldn\'t load the messages from the WhatsApp helper');
  return r.json();
}

export async function logoutWhatsApp() {
  const r = await call('/logout', { method: 'POST' });
  if (!r.ok) throw new Error('The helper didn\'t respond');
  data = null;
  setTimeout(refreshWhatsApp, 4000);
}

/** The one-line install command for this copy of the app. */
export function waInstallCommand() {
  const app = new URL('.', location.href).href;
  return `curl -fsSL ${app}extras/whatsapp/install.sh | bash -s -- ${app}`;
}

/** After the command is copied: check for the helper every few seconds and turn the feature on when it answers. */
export let waWaiting = false;
let watchT = null;
export function watchForWhatsApp(onFound) {
  clearInterval(watchT);
  waWaiting = true;
  const until = Date.now() + 15 * 60 * 1000;
  watchT = setInterval(async () => {
    if (Date.now() > until) { clearInterval(watchT); waWaiting = false; onUpdate(); return; }
    try {
      const r = await fetch(`${base()}/`, { cache: 'no-store' });
      if (!r.ok) return;
      clearInterval(watchT);
      waWaiting = false;
      onFound();
    } catch { /* not running yet */ }
  }, 3000);
  onUpdate();
}

/** Where a click on a chat goes: WhatsApp Web, straight into the chat when it's a person with a number. */
export const chatLink = (c) => (c.phone ? `https://web.whatsapp.com/send?phone=${encodeURIComponent(c.phone)}` : 'https://web.whatsapp.com/');
