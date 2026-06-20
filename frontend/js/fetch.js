
import { getServer, san, fmt, buildDlUrl } from './utils.js';
import { saveSession } from './session.js';
import { startRadar, stopRadar } from './radar.js';
import { resetDecode } from './decode.js';
import { videoInfo, setVideoInfo, serverConfig } from './state.js';

export async function fetchInfo() {
      const url = document.getElementById("url-input").value.trim();
      if (!url) return;

      document.getElementById('fetch-btn').disabled = true;
      document.getElementById('result-panel').className = '';
      document.getElementById('analysis-panel').className = 'panel visible';
      document.getElementById('analysis-status').textContent = 'SCANNING...';

      resetDecode();
      const freqTimer = startRadar();

      const eventSource = new EventSource(`${getServer()}/info-stream?url=${encodeURIComponent(url)}`);

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.complete) {
          eventSource.close();
          stopRadar(freqTimer);

          if (data.error) {
            document.getElementById('analysis-status').textContent = `✕ ERROR: ${data.error}`;
          } else {
            document.getElementById('analysis-status').textContent = '◆ SIGNAL LOCKED';
            setVideoInfo(data.info);
            saveSession(data.info, url);

            const tw = document.getElementById('thumb-wrap');
            tw.innerHTML = data.info.thumbnail
              ? `<img src="${san(data.info.thumbnail)}" alt="thumb" loading="lazy">`
              : `<div class="thumb-placeholder">NO SIGNAL</div>`;

            document.getElementById('video-title').textContent = data.info.title || 'Unknown';
            document.getElementById('video-source').textContent = (data.info.extractor || data.source || '—').toUpperCase();
            document.getElementById('video-author').textContent = data.info.uploader || '—';
            document.getElementById('video-dur').textContent = fmt(data.info.duration);

            const qEl = document.getElementById('quality-display');
            qEl.innerHTML = '';

            if (data.info.formats && data.info.formats.length > 0) {
              const bestOpt = document.createElement('option');
              bestOpt.value = 'best';
              bestOpt.textContent = `▲ BEST OF ${data.info.formats.length} FORMATS`;
              qEl.appendChild(bestOpt);

              data.info.formats.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.format_id;
                // Show file size estimate (actual if available, else estimate from bitrate)
                const sizeBytes = f.filesize || (f.tbr && data.info.duration ? (f.tbr * 1000 / 8) * data.info.duration : 0);
                const sizeStr = sizeBytes > 0 ? ` · ~${(sizeBytes / 1024 / 1024).toFixed(0)}MB` : '';
                const hasAudio = f.acodec !== 'none' && f.acodec !== undefined;
                const audioStr = hasAudio ? ' 🔊' : ' 🔇';
                const fpsStr = (f.fps && f.fps > 0) ? ` ${f.fps}fps` : '';
                opt.textContent = `▶ ${f.height}p${fpsStr}${audioStr}${sizeStr}`;
                qEl.appendChild(opt);
              });
            } else {
              const bestOpt = document.createElement('option');
              bestOpt.value = 'best';
              bestOpt.textContent = '▲ BEST AVAILABLE';
              qEl.appendChild(bestOpt);
            }

            // Reset video player, no pre-buffering
            const streamVideo = document.getElementById('stream-video');
            streamVideo.pause();
            streamVideo.removeAttribute('src');
            streamVideo.load();

            document.getElementById('dl-btn').removeAttribute('data-disabled');
            document.getElementById('stream-btn').removeAttribute('data-disabled');
            document.getElementById('audio-btn').removeAttribute('data-disabled');

            setTimeout(() => {
              document.getElementById('result-panel').className = 'panel visible';
            }, 500);
          }

          document.getElementById('fetch-btn').disabled = false;
          return;
        }

        const row = document.querySelector(`[data-step="${data.step}"]`);
        if (!row) return;

        const tick = row.querySelector('.decode-tick');
        const val = row.querySelector('.decode-value');

        if (data.status === 'active') {
          row.className = 'decode-row active';
          tick.textContent = '◌';
          val.textContent = data.message;
        } else if (data.status === 'done') {
          row.className = 'decode-row done';
          tick.textContent = '✓';
          val.textContent = data.message;
        } else if (data.status === 'error') {
          row.className = 'decode-row error';
          tick.textContent = '✕';
          val.textContent = data.message;
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        stopRadar(freqTimer);
        document.getElementById('analysis-status').textContent = '✕ CONNECTION LOST';
        document.getElementById('fetch-btn').disabled = false;
      };
    }
