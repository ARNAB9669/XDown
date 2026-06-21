import { getServer, buildDlUrl } from './utils.js';
import { videoInfo, hlsInstance, setHlsInstance, shakaPlayer, setShakaPlayer, serverConfig } from './state.js';

// ─── Listener Registry ────────────────────────────────────────────────────────
// Tracks every listener added to video/audio elements so cleanupStream()
// can remove them all cleanly — prevents the main leak source on re-use.
const _listeners = new Map(); // element → [{ type, fn, opts }]

function _on(el, type, fn, opts = false) {
  if (!el) return;
  el.addEventListener(type, fn, opts);
  if (!_listeners.has(el)) _listeners.set(el, []);
  _listeners.get(el).push({ type, fn, opts });
}

function _removeAll(el) {
  if (!el) return;
  const entries = _listeners.get(el) || [];
  for (const { type, fn, opts } of entries) el.removeEventListener(type, fn, opts);
  _listeners.delete(el);
}

// ─── Drift Correction (rAF-based, not setInterval) ────────────────────────────
// Using requestAnimationFrame keeps the correction off the timer queue and
// auto-pauses when the tab is hidden (the browser stops scheduling rAF).
let _driftRafId = null;
const DRIFT_THRESHOLD = 0.25; // seconds

function _startDriftLoop(videoEl, audioEl) {
  _stopDriftLoop();
  function tick() {
    if (!videoEl.paused && Math.abs(audioEl.currentTime - videoEl.currentTime) > DRIFT_THRESHOLD) {
      audioEl.currentTime = videoEl.currentTime;
    }
    _driftRafId = requestAnimationFrame(tick);
  }
  _driftRafId = requestAnimationFrame(tick);
}

function _stopDriftLoop() {
  if (_driftRafId !== null) { cancelAnimationFrame(_driftRafId); _driftRafId = null; }
}

// ─── Page Visibility Handling ─────────────────────────────────────────────────
// On low-end devices the browser may suspend media when the tab is hidden.
// Resume the AudioContext and re-sync audio on visibility restore.
let _visibilityHandler = null;

function _attachVisibilityHandler(videoEl, audioEl) {
  _detachVisibilityHandler();
  _visibilityHandler = () => {
    if (document.hidden) return;
    // Re-sync audio position in case OS suspended it
    if (audioEl && !videoEl.paused) {
      audioEl.currentTime = videoEl.currentTime;
      audioEl.play().catch(() => { });
    }
    // Resume Web Audio context if used
    if (window.audioContext?.state === 'suspended') window.audioContext.resume();
  };
  document.addEventListener('visibilitychange', _visibilityHandler);
}

function _detachVisibilityHandler() {
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }
}

// ─── HLS Config Factory ───────────────────────────────────────────────────────
// Separate configs for capable vs. constrained devices.
function _hlsConfig(lowEnd = false) {
  return lowEnd ? {
    enableWorker: true,
    lowLatencyMode: false,
    // Smaller buffers = less RAM, faster start on slow CPUs
    maxBufferLength: 20,
    backBufferLength: 15,
    maxBufferSize: 30 * 1000 * 1000,     // 30 MB cap
    maxBufferHole: 0.5,
    startLevel: 0,                        // start at lowest quality, ABR promotes up
    abrEwmaDefaultEstimate: 500_000,      // assume 500 kbps until we know better
    abrEwmaFastLive: 3,
    abrEwmaSlowLive: 9,
    capLevelToPlayerSize: true,           // never load quality bigger than the player
    testBandwidth: true,
    progressive: true,
  } : {
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 90,
    maxBufferLength: 60,
    startLevel: -1,                       // ABR picks best from the start
    capLevelToPlayerSize: true,
    abrEwmaDefaultEstimate: 5_000_000,
  };
}

// Simple heuristic: flag as low-end if deviceMemory ≤ 2 GB or hardware concurrency ≤ 2
function _isLowEnd() {
  const mem = navigator.deviceMemory;     // undefined on Firefox/Safari → treated as capable
  const cores = navigator.hardwareConcurrency;
  return (mem !== undefined && mem <= 2) || (cores !== undefined && cores <= 2);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
export function cleanupStream() {
  const streamVideo = document.getElementById('stream-video');
  const streamAudio = document.getElementById('stream-audio');

  _stopDriftLoop();
  _detachVisibilityHandler();
  _removeAll(streamVideo);
  _removeAll(streamAudio);

  if (hlsInstance) { hlsInstance.destroy(); setHlsInstance(null); }
  if (shakaPlayer) { shakaPlayer.destroy(); setShakaPlayer(null); }

  if (window._hlsSessionId) {
    fetch(`/hls/${window._hlsSessionId}/stop`, { method: 'DELETE' }).catch(() => { });
    window._hlsSessionId = null;
  }

  if (streamAudio) {
    streamAudio.pause();
    streamAudio.removeAttribute('src');
    streamAudio.load();
  }

  if (streamVideo) {
    streamVideo.pause();
    streamVideo.removeAttribute('src');
    streamVideo.load();
  }
}

// ─── Main Stream Entry Point ──────────────────────────────────────────────────
export async function startStream(e, preservedTime = 0, wasPlaying = false) {
  e?.preventDefault();
  if (!videoInfo) return;

  const streamWindow = document.getElementById('stream-window');
  const streamVideo = document.getElementById('stream-video');
  const statusEl = document.getElementById('stream-video-status');

  cleanupStream();

  streamWindow.classList.add('active');
  document.getElementById('stream-video-title').textContent = videoInfo.title || 'Stream';
  document.getElementById('stream-video-source').textContent = (videoInfo.extractor || 'custom').toUpperCase();
  statusEl.textContent = 'HD LOADING...';

  // Sync quality selectors
  const qualitySelect = document.getElementById('stream-quality-select');
  const mainQualitySelect = document.getElementById('quality-display');
  if (qualitySelect && mainQualitySelect) {
    qualitySelect.innerHTML = mainQualitySelect.innerHTML;
    qualitySelect.value = mainQualitySelect.value;
  }

  const selectedFormat = mainQualitySelect?.value || 'best';
  let useHls = false;

  if (videoInfo.source === 'puppeteer') {
    useHls = videoInfo.streamType === 'm3u8';
  } else if (selectedFormat !== 'best' && videoInfo.formats?.length > 0) {
    const fmt = videoInfo.formats.find(f => String(f.format_id) === String(selectedFormat));
    const proto = (fmt?.protocol ?? '').toLowerCase();
    const fId = String(selectedFormat).toLowerCase();
    useHls = proto.includes('m3u8') || fId.includes('hls') || fId.includes('m3u8');
  } else {
    useHls = videoInfo.streamType === 'm3u8' && videoInfo.extractor !== 'youtube';
  }

  console.log('DEBUG: videoInfo:', videoInfo, 'useHls:', useHls, 'lowEnd:', _isLowEnd());

  try {
    if (!useHls) {
      await _startDirectStream(streamVideo, statusEl, selectedFormat, preservedTime, wasPlaying);
      return;
    }
    await _startHlsStream(streamVideo, statusEl, selectedFormat, preservedTime, wasPlaying);
  } catch (err) {
    console.error('❌ Stream error:', err);
    statusEl.textContent = 'ERROR: ' + err.message;
  }
}

// ─── Direct / Proxy Stream ────────────────────────────────────────────────────
async function _startDirectStream(streamVideo, statusEl, selectedFormat, preservedTime, wasPlaying) {
  const isSplit =
    videoInfo.source !== 'puppeteer' &&
    selectedFormat !== 'best' &&
    videoInfo.formats?.find(f => String(f.format_id) === String(selectedFormat))?.requiresMerge;

  if (isSplit) {
    const streamAudio = document.getElementById('stream-audio');
    const vUrl = buildDlUrl(true, 'video');
    const aUrl = buildDlUrl(true, 'audio');
    console.log('📺 Direct Native Stream (SPLIT):', vUrl, aUrl);

    streamVideo.src = vUrl;
    streamAudio.src = aUrl;

    // ── Sync handlers ──
    _on(streamVideo, 'play', () => streamAudio.play().catch(() => { }));
    _on(streamVideo, 'pause', () => streamAudio.pause());
    _on(streamVideo, 'abort', () => streamAudio.pause());
    _on(streamVideo, 'error', () => streamAudio.pause());
    _on(streamVideo, 'ended', () => streamAudio.pause());
    _on(streamVideo, 'ratechange', () => { streamAudio.playbackRate = streamVideo.playbackRate; });

    // Seeking: sync immediately on seeked (seeking fires many times while dragging)
    _on(streamVideo, 'seeked', () => { streamAudio.currentTime = streamVideo.currentTime; });

    // Waiting/stalled: pause audio to avoid drift while video rebuffers
    _on(streamVideo, 'waiting', () => streamAudio.pause());
    _on(streamVideo, 'playing', () => {
      streamAudio.currentTime = streamVideo.currentTime;
      streamAudio.play().catch(() => { });
    });

    // rAF-based anti-drift loop (replaces the timeupdate listener)
    _on(streamVideo, 'play', () => _startDriftLoop(streamVideo, streamAudio));
    _on(streamVideo, 'pause', () => _stopDriftLoop());
    _on(streamVideo, 'ended', () => _stopDriftLoop());

    _attachVisibilityHandler(streamVideo, streamAudio);

    _on(streamVideo, 'loadedmetadata', () => {
      console.log('✅ Split Stream metadata loaded, duration:', streamVideo.duration);
      statusEl.textContent = 'STREAMING (SPLIT)';
      if (preservedTime > 0) {
        streamVideo.currentTime = preservedTime;
        streamAudio.currentTime = preservedTime;
      }
    }, { once: true });

  } else {
    const streamUrl = buildDlUrl(true);
    console.log('📺 Direct Native Stream URL:', streamUrl);
    streamVideo.src = streamUrl;

    _on(streamVideo, 'loadedmetadata', () => {
      console.log('✅ Stream metadata loaded, duration:', streamVideo.duration);
      statusEl.textContent = 'STREAMING (DIRECT)';
      if (preservedTime > 0) streamVideo.currentTime = preservedTime;
    }, { once: true });
  }

  _on(streamVideo, 'canplay', () => {
    if (wasPlaying) {
      streamVideo.play().catch(err => {
        if (err.name !== 'AbortError') statusEl.textContent = 'CLICK TO PLAY';
      });
    } else {
      statusEl.textContent = 'CLICK TO PLAY';
    }
  }, { once: true });

  _on(streamVideo, 'error', () => {
    statusEl.textContent = 'ERROR: ' + (streamVideo.error?.message || 'Unknown stream error');
  }, { once: true });
}

// ─── HLS Stream ───────────────────────────────────────────────────────────────
async function _startHlsStream(streamVideo, statusEl, selectedFormat, preservedTime, wasPlaying) {
  let m3u8Url = videoInfo.stream || videoInfo.url;

  if (selectedFormat !== 'best' && videoInfo.formats) {
    const fmt = videoInfo.formats.find(f => String(f.format_id) === String(selectedFormat));
    if (fmt?.url) m3u8Url = fmt.url;
  }
  if (!m3u8Url) throw new Error('Could not determine HLS manifest URL');

  const playlistUrl = `/m3u8-proxy?url=${encodeURIComponent(m3u8Url)}&originalUrl=${encodeURIComponent(document.getElementById('url-input').value.trim())}`;
  console.log('▶️ Loading HLS playlist proxy:', playlistUrl);

  if (Hls.isSupported()) {
    const hls = new Hls(_hlsConfig(_isLowEnd()));
    setHlsInstance(hls);

    hls.loadSource(playlistUrl);
    hls.attachMedia(streamVideo);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      console.log('✅ HLS manifest parsed, levels:', data.levels.length);
      statusEl.textContent = 'STREAMING (HLS)';

      if (selectedFormat === 'best' && data.levels.length > 0) {
        const maxLevel = data.levels.length - 1;
        hls.currentLevel = _isLowEnd() ? 0 : maxLevel;
        const qEl = document.getElementById('stream-quality-select');
        if (qEl) qEl.value = _isLowEnd() ? 0 : maxLevel;
        const picked = data.levels[hls.currentLevel];
        statusEl.textContent = `STREAMING (${picked?.height ?? '?'}p)`;
      }

      if (preservedTime > 0) streamVideo.currentTime = preservedTime;

      if (wasPlaying) {
        streamVideo.play().catch(err => {
          if (err.name !== 'AbortError') statusEl.textContent = 'CLICK TO PLAY';
        });
      }
    });

    // ── Auto-retry on recoverable errors ──
    let _networkRetries = 0;
    const MAX_RETRIES = 3;

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return; // non-fatal: hls.js handles internally

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && _networkRetries < MAX_RETRIES) {
        _networkRetries++;
        console.warn(`⚠️ HLS network error, retrying (${_networkRetries}/${MAX_RETRIES})…`);
        statusEl.textContent = `RECONNECTING… (${_networkRetries}/${MAX_RETRIES})`;
        setTimeout(() => hls.startLoad(), 1000 * _networkRetries); // back-off: 1s, 2s, 3s
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn('⚠️ HLS media error, attempting recovery…');
        hls.recoverMediaError();
      } else {
        console.error('❌ HLS fatal error:', data.type, data.details);
        statusEl.textContent = 'HLS ERROR: ' + data.details;
      }
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const lvl = hls.levels[data.level];
      if (lvl) statusEl.textContent = `STREAMING (${lvl.height}p)`;
    });

  } else if (streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    streamVideo.src = playlistUrl;
    if (preservedTime > 0) {
      _on(streamVideo, 'loadedmetadata', () => { streamVideo.currentTime = preservedTime; }, { once: true });
    }
    streamVideo.play().catch(() => { });
    statusEl.textContent = 'STREAMING (Native HLS)';
  } else {
    throw new Error('HLS not supported in this browser');
  }
}

// ─── startHlsStream (external entry, e.g. from puppeteer path) ───────────────
export function startHlsStream(m3u8Url, isCookieProtected) {
  const streamVideo = document.getElementById('stream-video');
  const statusEl = document.getElementById('stream-video-status');

  if (Hls.isSupported()) {
    const hls = new Hls(_hlsConfig(_isLowEnd()));
    setHlsInstance(hls);

    const finalUrl = isCookieProtected
      ? `${getServer()}/hls-proxy?url=${encodeURIComponent(m3u8Url)}`
      : m3u8Url;

    hls.loadSource(finalUrl);
    hls.attachMedia(streamVideo);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      console.log('HLS manifest parsed, levels:', data.levels.length);
      statusEl.textContent = 'STREAMING';

      const qEl = document.getElementById('stream-quality-select');
      if (qEl) {
        qEl.innerHTML = '<option value="-1">▲ AUTO QUALITY (ABR)</option>';
        data.levels.forEach((level, idx) => {
          const opt = document.createElement('option');
          opt.value = idx;
          opt.textContent = `▶ ${level.height}p${level.bitrate ? ' ' + Math.round(level.bitrate / 1000) + 'k' : ''}`;
          qEl.appendChild(opt);
        });
        qEl.onchange = ev => { hls.currentLevel = parseInt(ev.target.value); };
      }

      streamVideo.play().catch(e => console.error(e));
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      console.log('HLS quality switched to level:', data.level);
    });

    let _retries = 0;
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && _retries < 3) {
        _retries++;
        setTimeout(() => hls.startLoad(), 1000 * _retries);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        statusEl.textContent = 'FATAL HLS ERROR';
      }
    });

  } else if (streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
    streamVideo.src = m3u8Url;
    streamVideo.play().catch(e => console.error(e));
  }
}

// ─── DASH Stream ──────────────────────────────────────────────────────────────
export async function startDashStream(mpdUrl) {
  const streamVideo = document.getElementById('stream-video');
  const statusEl = document.getElementById('stream-video-status');

  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    statusEl.textContent = 'BROWSER DASH NOT SUPPORTED';
    return;
  }

  setShakaPlayer(new shaka.Player(streamVideo));

  shakaPlayer.configure({
    abr: { enabled: true },
    // Lower buffer targets on low-end devices
    streaming: {
      bufferingGoal: _isLowEnd() ? 15 : 30,
      rebufferingGoal: _isLowEnd() ? 2 : 5,
      bufferBehind: _isLowEnd() ? 10 : 30,
    },
  });

  shakaPlayer.addEventListener('error', event => {
    console.error('Shaka Error:', event.detail);
    statusEl.textContent = 'DASH ERROR';
  });

  try {
    await shakaPlayer.load(mpdUrl);
    console.log('DASH manifest loaded!');
    statusEl.textContent = 'STREAMING';
    streamVideo.play().catch(e => console.error(e));

    const tracks = shakaPlayer.getVariantTracks();
    const qEl = document.getElementById('stream-quality-select');
    if (qEl && tracks.length > 0) {
      qEl.innerHTML = '<option value="-1">▲ AUTO QUALITY (ABR)</option>';
      tracks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `▶ ${t.height}p ${Math.round(t.bandwidth / 1000)}k`;
        qEl.appendChild(opt);
      });
      qEl.onchange = ev => {
        const id = parseInt(ev.target.value);
        if (id === -1) {
          shakaPlayer.configure({ abr: { enabled: true } });
        } else {
          shakaPlayer.configure({ abr: { enabled: false } });
          const track = shakaPlayer.getVariantTracks().find(t => t.id === id);
          if (track) shakaPlayer.selectVariantTrack(track, true);
        }
      };
    }
  } catch (e) {
    console.error('Error loading DASH:', e);
    statusEl.textContent = 'DASH LOAD ERROR';
  }
}

// ─── Close ────────────────────────────────────────────────────────────────────
export function closeStream() {
  cleanupStream();
  document.getElementById('stream-window')?.classList.remove('active');
}

// ─── Cookie-dependency check ──────────────────────────────────────────────────
export function isCookieDependent(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase().replace('www.', '');
    const domains = serverConfig.cookieDomains?.length > 0
      ? serverConfig.cookieDomains
      : ['pornhub', 'xvideos', 'spankbang', 'xhamster', 'nuvid', 'xnxx', 'redtube', 'tube8'];
    return domains.some(d => h.includes(d.replace('www.', '')));
  } catch { return false; }
}