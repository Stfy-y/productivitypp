// Phone remote: the now-playing helper serves a small page on the local network (http://<computer>:8972/remote)
// that loads this file. The whole page is the full-screen player, controlling the music on the computer.
// The link from Settings carries the helper's key after "#k="; it's kept on the phone for next time.
import { useRemote, startMusic, refreshMusic, setMusicListener } from './music.js';
import { openNowPlaying, updateNowPlaying } from './nowplaying-full.js';

const KEY = 'ppp-remote-key';
let key = '';
try { key = localStorage.getItem(KEY) || ''; } catch { /* private mode */ }
const m = /[#&]k=([^&]+)/.exec(location.hash);
if (m) {
  key = decodeURIComponent(m[1]);
  try { localStorage.setItem(KEY, key); } catch { /* fine, the link still works this time */ }
  history.replaceState(null, '', location.pathname); // don't leave the key in the address bar
}

useRemote(location.origin, key);
setMusicListener(updateNowPlaying);
openNowPlaying({ remote: true });
refreshMusic();
startMusic(() => document.visibilityState === 'visible', 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshMusic(); });
