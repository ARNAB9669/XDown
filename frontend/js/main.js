
import { updateClock } from './utils.js';
import { restoreSession } from './session.js';
import { runBoot } from './boot.js';
import { fetchInfo } from './fetch.js';
import { initVideoPlayer } from './player.js';
import { startWarpDownload, closeWarp } from './download.js';
import { startStream, closeStream } from './stream.js';
import { setServerConfig } from './state.js';
import { reset } from './reset.js';

window.fetchInfo = fetchInfo;
window.startWarpDownload = startWarpDownload;
window.startStream = startStream;
window.closeStream = closeStream;
window.closeWarp = closeWarp;
window.reset = reset;

document.addEventListener('DOMContentLoaded', () => {
  fetch('/config').then(res => res.json()).then(cfg => {
    setServerConfig(cfg);
  }).catch(err => console.error('Failed to fetch config:', err));

  document.addEventListener('paste', e => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
        if (document.activeElement !== document.getElementById("url-input")) {
          document.getElementById("url-input").value = text;
          fetchInfo();
        }
      }
    })

  const urlInput = document.getElementById('url-input');
  if (urlInput) {
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') fetchInfo();
    });
  }

  setInterval(updateClock, 1000);
  updateClock();

  if (urlInput) restoreSession();
  runBoot();
  initVideoPlayer();
});
