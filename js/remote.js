// Phone remote: the now-playing helper serves a small page on the local network (http://<computer>:8972/remote)
// that loads this file. The whole page is the full-screen player, controlling the music on the computer.
// The link from Settings carries the helper's key as "?k=". It stays in the address on purpose: a home-screen
// icon starts from this address, and on iPhone home-screen apps can't see what the browser saved.
import { useRemote, startMusic, refreshMusic, setMusicListener } from './music.js';
import { openNowPlaying, updateNowPlaying } from './nowplaying-full.js';

const KEY = 'ppp-remote-key';
const hashKey = /[#&]k=([^&]+)/.exec(location.hash)?.[1];
if (hashKey) location.replace(`/remote?k=${hashKey}`); // older links: move the key into the address
let key = new URLSearchParams(location.search).get('k') || '';
try {
  if (key) localStorage.setItem(KEY, key);
  else key = localStorage.getItem(KEY) || '';
} catch { /* private mode: the address still has it */ }

useRemote(location.origin, key);
setMusicListener(updateNowPlaying);
openNowPlaying({ remote: true });
refreshMusic();
startMusic(() => document.visibilityState === 'visible', 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshMusic(); });
