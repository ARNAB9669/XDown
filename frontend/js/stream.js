
import { getServer, buildDlUrl } from './utils.js';
import { videoInfo, hlsInstance, setHlsInstance, shakaPlayer, setShakaPlayer, serverConfig } from './state.js';

export function cleanupStream() {
      const streamVideo = document.getElementById('stream-video');
      if (hlsInstance) { hlsInstance.destroy(); setHlsInstance(null); }
      if (shakaPlayer) { shakaPlayer.destroy(); setShakaPlayer(null); }
      if (window._hlsSessionId) {
        fetch(`/hls/${window._hlsSessionId}/stop`, { method: 'DELETE' }).catch(() => { });
        window._hlsSessionId = null;
      }

      const streamAudio = document.getElementById('stream-audio');
      if (streamAudio) {
        streamAudio.pause();
        streamAudio.removeAttribute('src');
        streamAudio.load();
      }

      streamVideo.onplay = null;
      streamVideo.onpause = null;
      streamVideo.onseeked = null;
      streamVideo.ontimeupdate = null;
      streamVideo.onwaiting = null;
      streamVideo.onplaying = null;

      streamVideo.pause();
      streamVideo.removeAttribute('src');
      streamVideo.load();
    }
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

      const qualitySelect = document.getElementById('stream-quality-select');
      const mainQualitySelect = document.getElementById('quality-display');
      if (qualitySelect && mainQualitySelect) {
        qualitySelect.innerHTML = mainQualitySelect.innerHTML;
        qualitySelect.value = mainQualitySelect.value;
      }

      const url = document.getElementById("url-input").value.trim();
      const selectedFormat = mainQualitySelect?.value || 'best';

      let useHls = false;
      let isDashSplit = false;

      if (videoInfo.source === 'puppeteer') {
        useHls = videoInfo.streamType === 'm3u8';
      } else if (selectedFormat !== 'best' && videoInfo.formats && videoInfo.formats.length > 0) {
        const format = videoInfo.formats.find(f => String(f.format_id) === String(selectedFormat));
        const proto = (format && format.protocol) ? format.protocol.toLowerCase() : '';
        const fId = String(selectedFormat).toLowerCase();

        if (proto.includes('m3u8') || fId.includes('hls') || fId.includes('m3u8')) {
          useHls = true;
        }
      } else {
        if (videoInfo.streamType === 'm3u8' && videoInfo.extractor !== 'youtube') {
          useHls = true;
        }
      }

      console.log('DEBUG: videoInfo:', videoInfo, 'useHls:', useHls);

      try {
        if (!useHls) {
          // Direct native stream proxy -> preserves original quality and byte-range seeking
          let isSplit = false;
          if (videoInfo.source !== 'puppeteer' && selectedFormat !== 'best' && videoInfo.formats) {
            const format = videoInfo.formats.find(f => String(f.format_id) === String(selectedFormat));
            if (format && format.requiresMerge) {
              isSplit = true;
            }
          }

          if (isSplit) {
            const vUrl = buildDlUrl(true, 'video');
            const aUrl = buildDlUrl(true, 'audio');
            console.log('📺 Direct Native Stream (SPLIT):', vUrl, aUrl);
            streamVideo.src = vUrl;
            
            let streamAudio = document.getElementById('stream-audio');
            if (!streamAudio) {
              streamAudio = document.createElement('audio');
              streamAudio.id = 'stream-audio';
              document.body.appendChild(streamAudio);
            }
            streamAudio.src = aUrl;

            // Sync logic
            streamVideo.addEventListener('play', () => streamAudio.play().catch(()=>{}));
            streamVideo.addEventListener('pause', () => streamAudio.pause());
            streamVideo.addEventListener('seeking', () => { streamAudio.currentTime = streamVideo.currentTime; });
            streamVideo.addEventListener('seeked', () => { streamAudio.currentTime = streamVideo.currentTime; });
            streamVideo.addEventListener('waiting', () => streamAudio.pause());
            streamVideo.addEventListener('playing', () => streamAudio.play().catch(()=>{}));
            streamVideo.addEventListener('ratechange', () => { streamAudio.playbackRate = streamVideo.playbackRate; });
            
            // Anti-drift sync
            streamVideo.addEventListener('timeupdate', () => {
              if (!streamVideo.paused && Math.abs(streamAudio.currentTime - streamVideo.currentTime) > 0.25) {
                streamAudio.currentTime = streamVideo.currentTime;
              }
            });
            
            streamVideo.addEventListener('loadedmetadata', () => {
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

            streamVideo.addEventListener('loadedmetadata', () => {
              console.log('✅ Stream metadata loaded, duration:', streamVideo.duration);
              statusEl.textContent = 'STREAMING (DIRECT)';
              if (preservedTime > 0) streamVideo.currentTime = preservedTime;
            }, { once: true });
          }

          streamVideo.addEventListener('canplay', () => {
            if (wasPlaying) {
              streamVideo.play().catch(err => {
                if (err.name !== 'AbortError') statusEl.textContent = 'CLICK TO PLAY';
              });
            } else {
              statusEl.textContent = 'CLICK TO PLAY';
            }
          }, { once: true });

          streamVideo.addEventListener('error', () => {
            statusEl.textContent = 'ERROR: ' + (streamVideo.error?.message || 'Unknown stream error');
          }, { once: true });

          return;
        }

        let m3u8Url = videoInfo.stream || videoInfo.url;

        if (selectedFormat !== 'best' && videoInfo.formats) {
          const format = videoInfo.formats.find(f => String(f.format_id) === String(selectedFormat));
          if (format && format.url) {
            m3u8Url = format.url;
          }
        }

        if (!m3u8Url) throw new Error('Could not determine HLS manifest URL');

        const playlistUrl = `/m3u8-proxy?url=${encodeURIComponent(m3u8Url)}&originalUrl=${encodeURIComponent(document.getElementById("url-input").value.trim())}`;
        console.log('▶️ Loading Native HLS playlist proxy:', playlistUrl);

        if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          maxBufferLength: 60,
          startLevel: -1,
        });
        setHlsInstance(hls);

        hlsInstance.loadSource(playlistUrl);
        hlsInstance.attachMedia(streamVideo);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            console.log('✅ HLS manifest parsed — seeking enabled!');
            statusEl.textContent = 'STREAMING (HLS)';

            // Auto-select highest quality if user selected "BEST"
            const mainQualitySelect = document.getElementById('quality-display');
            if (mainQualitySelect && mainQualitySelect.value === 'best' && data.levels.length > 0) {
              const maxLevel = data.levels.length - 1;
              hlsInstance.currentLevel = maxLevel;
              const qEl = document.getElementById('stream-quality-select');
              if (qEl) qEl.value = maxLevel;
              statusEl.textContent = `STREAMING (${data.levels[maxLevel].height}p)`;
            }

            streamVideo.play().catch(err => {
              if (err.name !== 'AbortError') {
                statusEl.textContent = 'CLICK TO PLAY';
              }
            });
          });

          hlsInstance.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              console.error('❌ HLS fatal error:', data.type, data.details);
              statusEl.textContent = 'HLS ERROR: ' + data.details;
            }
          });

        } else if (streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          streamVideo.src = playlistUrl;
          streamVideo.play().catch(() => { });
          statusEl.textContent = 'STREAMING (Native HLS)';
        } else {
          throw new Error('HLS not supported in this browser');
        }

      } catch (err) {
        console.error('❌ Stream error:', err);
        statusEl.textContent = 'ERROR: ' + err.message;
      }
    }
export function startHlsStream(m3u8Url, isCookieProtected) {
      const streamVideo = document.getElementById('stream-video');

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          abrEwmaDefaultEstimate: 5000000,
          startLevel: -1,
        });
        setHlsInstance(hls);

        const finalUrl = isCookieProtected
          ? `${getServer()}/hls-proxy?url=${encodeURIComponent(m3u8Url)}`
          : m3u8Url;

        hlsInstance.loadSource(finalUrl);
        hlsInstance.attachMedia(streamVideo);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
          console.log('HLS manifest parsed, levels:', data.levels.length);
          document.getElementById('stream-video-status').textContent = 'STREAMING';

          const qEl = document.getElementById('stream-quality-select');
          if (qEl) {
            qEl.innerHTML = '<option value="-1">▲ AUTO QUALITY (ABR)</option>';
            data.levels.forEach((level, idx) => {
              const opt = document.createElement('option');
              opt.value = idx;
              opt.textContent = `▶ ${level.height}p ${level.bitrate ? Math.round(level.bitrate / 1000) + 'k' : ''}`;
              qEl.appendChild(opt);
            });
            qEl.onchange = (e) => {
              hlsInstance.currentLevel = parseInt(e.target.value);
            };
          }

          streamVideo.play().catch(e => console.error(e));
        });

        hlsInstance.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
          console.log('HLS quality switched to level:', data.level);
        });

        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hlsInstance.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hlsInstance.recoverMediaError();
            } else {
              document.getElementById('stream-video-status').textContent = 'FATAL HLS ERROR';
            }
          }
        });
      } else if (streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
        streamVideo.src = m3u8Url;
        streamVideo.play().catch(e => console.error(e));
      }
    }
export async function startDashStream(mpdUrl) {
      const streamVideo = document.getElementById('stream-video');

      shaka.polyfill.installAll();
      if (shaka.Player.isBrowserSupported()) {
        setShakaPlayer(new shaka.Player(streamVideo));

        shakaPlayer.addEventListener('error', (event) => {
          console.error('Shaka Error:', event.detail);
          document.getElementById('stream-video-status').textContent = 'DASH ERROR';
        });

        try {
          await shakaPlayer.load(mpdUrl);
          console.log('DASH manifest loaded!');
          document.getElementById('stream-video-status').textContent = 'STREAMING';
          streamVideo.play().catch(e => console.error(e));

          // Populate qualities if available
          const tracks = shakaPlayer.getVariantTracks();
          const qEl = document.getElementById('stream-quality-select');
          if (qEl && tracks.length > 0) {
            qEl.innerHTML = '<option value="-1">▲ AUTO QUALITY (ABR)</option>';
            tracks.forEach((t) => {
              const opt = document.createElement('option');
              opt.value = t.id;
              opt.textContent = `▶ ${t.height}p ${Math.round(t.bandwidth / 1000)}k`;
              qEl.appendChild(opt);
            });
            qEl.onchange = (e) => {
              const trackId = parseInt(e.target.value);
              if (trackId === -1) {
                shakaPlayer.configure({ abr: { enabled: true } });
              } else {
                shakaPlayer.configure({ abr: { enabled: false } });
                const track = shakaPlayer.getVariantTracks().find(t => t.id === trackId);
                if (track) shakaPlayer.selectVariantTrack(track, true);
              }
            };
          }
        } catch (e) {
          console.error('Error loading DASH:', e);
          document.getElementById('stream-video-status').textContent = 'DASH LOAD ERROR';
        }
      } else {
        document.getElementById('stream-video-status').textContent = 'BROWSER DASH NOT SUPPORTED';
      }
    }
export function closeStream() {
      const streamWindow = document.getElementById('stream-window');
      const streamVideo = document.getElementById('stream-video');

      if (hlsInstance) { hlsInstance.destroy(); setHlsInstance(null); }
      if (shakaPlayer) { shakaPlayer.destroy(); setShakaPlayer(null); }

      // Tell server to delete HLS temp files
      if (window._hlsSessionId) {
        fetch(`/hls/${window._hlsSessionId}/stop`, { method: 'DELETE' }).catch(() => { });
        window._hlsSessionId = null;
      }

      streamVideo.pause();
      streamVideo.removeAttribute('src');
      streamVideo.load();
      streamWindow.classList.remove('active');
    }
export function isCookieDependent(urlStr) {
      try {
        const h = new URL(urlStr).hostname.toLowerCase().replace('www.', '');
        // Use server config if loaded, else fall back to basic list
        const domains = serverConfig.cookieDomains.length > 0
          ? serverConfig.cookieDomains
          : ['pornhub', 'xvideos', 'spankbang', 'xhamster', 'nuvid', 'xnxx', 'redtube', 'tube8'];
        return domains.some(d => h.includes(d.replace('www.', '')));
      } catch (e) { return false; }
    }
