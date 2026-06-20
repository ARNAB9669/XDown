const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');

// 1. Extract CSS
const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>');
const css = html.substring(styleStart + 7, styleEnd).trim();
fs.mkdirSync('frontend/css', { recursive: true });
fs.writeFileSync('frontend/css/styles.css', css);

// 2. Extract JS Block
const scriptStart = html.indexOf('<script>', styleEnd);
const scriptEnd = html.lastIndexOf('</script>');
const jsBlock = html.substring(scriptStart + 8, scriptEnd);

fs.mkdirSync('frontend/js', { recursive: true });

function extractFunction(text, funcName, prefix = '') {
  const funcDecl = `${prefix}function ${funcName}(`;
  let start = text.indexOf(funcDecl);
  if (start === -1) {
    start = text.indexOf(`${prefix}function ${funcName} (`);
  }
  if (start === -1) return '';

  let braceCount = 0;
  let inString = false;
  let stringChar = '';
  let started = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && text[i-1] !== '\\') {
      inString = false;
    }

    if (!inString) {
      if (char === '{') {
        braceCount++;
        started = true;
      } else if (char === '}') {
        braceCount--;
      }
    }

    if (started && braceCount === 0) {
      return text.substring(start, i + 1);
    }
  }
  return '';
}

function extractVar(text, varName) {
  const regex = new RegExp(`(const|let|var)\\s+${varName}\\s*=[\\s\\S]*?;`);
  const match = text.match(regex);
  return match ? match[0] : '';
}

fs.writeFileSync('frontend/js/state.js', `export let videoInfo = null;
export let hlsInstance = null;
export let shakaPlayer = null;
export let serverConfig = { cookieDomains: [], adDomains: [] };

export function setVideoInfo(v)     { videoInfo = v; }
export function setHlsInstance(v)   { hlsInstance = v; }
export function setShakaPlayer(v)   { shakaPlayer = v; }
export function setServerConfig(v)  { serverConfig = v; }
`);

const getServer = extractFunction(jsBlock, 'getServer');
const san = extractFunction(jsBlock, 'san');
const fmt = extractFunction(jsBlock, 'fmt');
let buildDlUrl = extractFunction(jsBlock, 'buildDlUrl');
let jsBlockAfterFirst = jsBlock.substring(jsBlock.indexOf('buildDlUrl') + 20);
let buildDlUrl2 = extractFunction(jsBlockAfterFirst, 'buildDlUrl');
if (buildDlUrl2.includes('trackType')) {
  buildDlUrl = buildDlUrl2;
}

const updateClock = extractFunction(jsBlock, 'updateClock');

fs.writeFileSync('frontend/js/utils.js', `
export ${getServer}
export ${san}
export ${fmt}
export ${buildDlUrl}
export ${updateClock}
`);

const saveSession = extractFunction(jsBlock, 'saveSession');
const clearSession = extractFunction(jsBlock, 'clearSession');
const restoreSession = extractFunction(jsBlock, 'restoreSession').replace('restoreSession()', 'restoreSession(urlInput)');

fs.writeFileSync('frontend/js/session.js', `
export ${saveSession}
export ${clearSession}
export ${restoreSession}
`);

const bootLines = extractVar(jsBlock, 'bootLines');
const runBoot = extractFunction(jsBlock, 'runBoot');

fs.writeFileSync('frontend/js/boot.js', `
export ${bootLines}
export ${runBoot}
`);

const spawnBlip = extractFunction(jsBlock, 'spawnBlip');
const startRadar = extractFunction(jsBlock, 'startRadar');
const stopRadar = extractFunction(jsBlock, 'stopRadar');

fs.writeFileSync('frontend/js/radar.js', `
export let radarBlipTimer = null;
export ${spawnBlip}
export ${startRadar}
export ${stopRadar}
`);

const decodeSteps = extractVar(jsBlock, 'decodeSteps');
const resetDecode = extractFunction(jsBlock, 'resetDecode');
const animateDecode = extractFunction(jsBlock, 'animateDecode');

fs.writeFileSync('frontend/js/decode.js', `
export ${decodeSteps}
export ${resetDecode}
export ${animateDecode}
`);

const fetchInfo = extractFunction(jsBlock, 'fetchInfo', 'async ');
fs.writeFileSync('frontend/js/fetch.js', `
import { getServer, san, fmt, buildDlUrl } from './utils.js';
import { saveSession } from './session.js';
import { startRadar, stopRadar } from './radar.js';
import { resetDecode } from './decode.js';
import { videoInfo, setVideoInfo, serverConfig } from './state.js';

export ${fetchInfo}
`);

const initVideoPlayer = extractFunction(jsBlock, 'initVideoPlayer');
const playerState = extractVar(jsBlock, 'playerState');

fs.writeFileSync('frontend/js/player.js', `
import { buildDlUrl, getServer } from './utils.js';
import { videoInfo, hlsInstance, setHlsInstance, shakaPlayer, setShakaPlayer } from './state.js';

export ${playerState}
export ${initVideoPlayer}
`);

const cleanupStream = extractFunction(jsBlock, 'cleanupStream');
const startStream = extractFunction(jsBlock, 'startStream', 'async ');
const startHlsStream = extractFunction(jsBlock, 'startHlsStream');
const startDashStream = extractFunction(jsBlock, 'startDashStream', 'async ');
const closeStream = extractFunction(jsBlock, 'closeStream');
const isCookieDependent = extractFunction(jsBlock, 'isCookieDependent');

fs.writeFileSync('frontend/js/stream.js', `
import { getServer, buildDlUrl } from './utils.js';
import { videoInfo, hlsInstance, setHlsInstance, shakaPlayer, setShakaPlayer, serverConfig } from './state.js';

export ${cleanupStream}
export ${startStream}
export ${startHlsStream}
export ${startDashStream}
export ${closeStream}
export ${isCookieDependent}
`);

const buildWarpLines = extractFunction(jsBlock, 'buildWarpLines');
const addTermLine = extractFunction(jsBlock, 'addTermLine');
const startTermClock = extractFunction(jsBlock, 'startTermClock');
const startTerminal = extractFunction(jsBlock, 'startTerminal');
const stopTerminal = extractFunction(jsBlock, 'stopTerminal');
const startWarpDownload = extractFunction(jsBlock, 'startWarpDownload', 'async ');
const closeWarp = extractFunction(jsBlock, 'closeWarp');

fs.writeFileSync('frontend/js/download.js', `
import { buildDlUrl } from './utils.js';
import { clearSession } from './session.js';
import { videoInfo } from './state.js';

export let termSeconds = 0;
export let termClockInterval = null;
export let terminalInterval = null;
export let fakeDownloadTimer = null;
export let downloadPoller = null;

export ${buildWarpLines}
export ${addTermLine}
export ${startTermClock}
export ${startTerminal}
export ${stopTerminal}
export ${startWarpDownload}
export ${closeWarp}
`);

const downloadAudioMatch = extractFunction(jsBlock, 'downloadAudio');

fs.writeFileSync('frontend/js/audio.js', `
import { getServer } from './utils.js';
import { videoInfo } from './state.js';
export ${downloadAudioMatch}
`);

fs.writeFileSync('frontend/js/reset.js', `
import { clearSession } from './session.js';
import { resetDecode } from './decode.js';
import { closeWarp } from './download.js';
import { closeStream } from './stream.js';
import { setVideoInfo } from './state.js';

export function reset() {
  setVideoInfo(null);
  clearSession();
  document.getElementById('url-input').value = '';
  document.getElementById('result-panel').className = '';
  document.getElementById('dl-btn').setAttribute('data-disabled', 'true');
  document.getElementById('stream-btn').setAttribute('data-disabled', 'true');
  resetDecode();
  closeWarp();
  closeStream();
}
`);

// To grab the raw event listeners that were inside <script>
let pasteListener = '';
const pasteStart = jsBlock.indexOf("document.addEventListener('paste'");
if(pasteStart !== -1) {
  let bc = 0;
  for(let i=pasteStart; i<jsBlock.length; i++) {
    if(jsBlock[i]==='{') bc++;
    else if(jsBlock[i]==='}') bc--;
    if(bc===0 && jsBlock[i]===')') {
      pasteListener = jsBlock.substring(pasteStart, i+1);
      break;
    }
  }
}

fs.writeFileSync('frontend/js/main.js', `
import { updateClock } from './utils.js';
import { restoreSession } from './session.js';
import { runBoot } from './boot.js';
import { fetchInfo } from './fetch.js';
import { initVideoPlayer } from './player.js';
import { startWarpDownload, closeWarp } from './download.js';
import { startStream, closeStream } from './stream.js';
import { downloadAudio } from './audio.js';
import { setServerConfig } from './state.js';
import { reset } from './reset.js';

window.fetchInfo = fetchInfo;
window.startWarpDownload = startWarpDownload;
window.startStream = startStream;
window.closeStream = closeStream;
window.closeWarp = closeWarp;
window.downloadAudio = downloadAudio;
window.reset = reset;

document.addEventListener('DOMContentLoaded', () => {
  fetch('/config').then(res => res.json()).then(cfg => {
    setServerConfig(cfg);
  }).catch(err => console.error('Failed to fetch config:', err));

  ${pasteListener}

  const urlInput = document.getElementById('url-input');
  if (urlInput) {
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') fetchInfo();
    });
  }

  setInterval(updateClock, 1000);
  updateClock();

  if (urlInput) restoreSession(urlInput);
  runBoot();
  initVideoPlayer();
});
`);

console.log("Extraction complete!");
