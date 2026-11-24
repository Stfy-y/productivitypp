import { esc, toast, isIOS } from './util.js';
import { icon } from './icons.js';
import { getHabit, settings } from './store.js';
import { openSheet, closeSheet } from './ui.js';

/** Link that opens the app and logs the habit. A query, not #/nfc/<id>: some tag writers (NXP TagWriter) reject '#'. */
export const appLink = (id) => `${location.origin}${location.pathname}?nfc=${encodeURIComponent(id)}`;

/**
 * Link to the sync worker that logs the habit server-side, with no app needed (works on iPhone too).
 * It carries a per-habit signature instead of the sync token: someone who reads the tag can only
 * log that one habit, not read or change anything else. Same formula as nfcSig() in worker/worker.js.
 */
export async function serverLink(id) {
  const base = settings.apiUrl.trim().replace(/\/+$/, '');
  if (!base || !settings.apiToken) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(settings.apiToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`nfc:${id}`)));
  const sig = btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
  return `${base}/nfc/${id}/${sig}`;
}

const canWrite = () => 'NDEFReader' in window;

async function writeTag(url, btn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Hold a tag to the back of your phone…';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    await new window.NDEFReader().write({ records: [{ recordType: 'url', data: url }] }, { signal: ctl.signal });
    toast('✓ Tag written. Tap it to check in.');
    navigator.vibrate?.(30);
  } catch (e) {
    toast(e.name === 'AbortError' ? 'No tag found. Try again.' : e.name === 'NotAllowedError' ? 'NFC permission denied' : `Couldn't write the tag: ${e.message}`);
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

export async function openNfcSheet(id) {
  const h = getHabit(id);
  if (!h) return;
  const server = await serverLink(id);
  const app = appLink(id);
  const opt = (title, desc, url, rec) => `<div class="nfc-opt">
      <b>${esc(title)}${rec ? ' <span class="nfc-rec">Recommended</span>' : ''}</b>
      <small class="hint">${esc(desc)}</small>
      <code class="nfc-url">${esc(url)}</code>
      <div class="nfc-btns">
        <button class="btn" data-x="copy" data-url="${esc(url)}">Copy link</button>
        ${canWrite() ? `<button class="btn primary" data-x="write" data-url="${esc(url)}">${icon('nfc')} Write to tag</button>` : ''}
      </div></div>`;
  openSheet(`<div class="nfc-sheet">
      <div class="evd-head"><h2>${icon('nfc')} NFC tag · ${esc(h.icon || '')} ${esc(h.name)}</h2>
        <button class="icon-btn" data-x="close" aria-label="Close">${icon('close')}</button></div>
      <p class="hint">Put one of these links on an NFC tag. Tapping your phone on the tag adds a check-in for today. A tap never un-checks the habit.</p>
      ${server ? opt('Via sync server', 'Logs the habit without opening the app, on Android and iPhone. Shows a small confirmation page.', server, true) : ''}
      ${opt('Open the app', server ? 'Opens Productivity++ and logs it there. On iPhone this opens Safari, which keeps separate data from the home-screen app.' : 'Opens Productivity++ and logs it there. Set up sync in Settings to get a link that works without the app, including on iPhone.', app, !server)}
      ${isIOS() && server ? `<p class="hint"><b>iPhone, no tap on a notification:</b> in Shortcuts → Automation → NFC, scan the tag, choose <i>Run Immediately</i>, and add <i>Get Contents of URL</i> with <code class="nfc-url">${esc(server)}?format=text</code> followed by <i>Show Notification</i> with the result.</p>` : ''}
      ${canWrite() ? '' : '<p class="hint">To write the tag from here, use Chrome on Android. Otherwise copy a link and write it as a URL record with an app like NFC Tools.</p>'}
    </div>`, {
    onMount(el) {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-x]');
        if (!b) return;
        if (b.dataset.x === 'close') closeSheet();
        if (b.dataset.x === 'copy') {
          try { await navigator.clipboard.writeText(b.dataset.url); toast('Link copied'); } catch { toast('Select the link and copy it'); }
        }
        if (b.dataset.x === 'write') writeTag(b.dataset.url, b);
      });
    },
  });
}
