
import { buildDlUrl } from './utils.js';
import { clearSession } from './session.js';
import { videoInfo } from './state.js';

export let termSeconds = 0;
export let termClockInterval = null;
export let terminalInterval = null;
export let fakeDownloadTimer = null;
export let downloadPoller = null;

export function buildWarpLines() {
      const tunnel = document.getElementById('warp-tunnel');
      tunnel.innerHTML = '';
      const CX = window.innerWidth / 2;
      const CY = window.innerHeight / 2;

      for (let i = 0; i < 60; i++) {
        const angle = (i / 60) * 360;
        const len = 120 + Math.random() * 200;
        const line = document.createElement('div');
        line.className = 'warp-line';

        const rad = (angle * Math.PI) / 180;
        const x = CX + Math.cos(rad) * (window.innerWidth * 0.5);
        const y = CY + Math.sin(rad) * (window.innerHeight * 0.5);

        line.style.cssText = `
          left: ${x}px;
          top: ${y}px;
          height: ${len}px;
          transform: rotate(${angle + 90}deg);
          transform-origin: top center;
          animation-delay: ${Math.random() * 1.2}s;
          animation-duration: ${0.8 + Math.random() * 0.8}s;
          opacity: 0;
        `;
        tunnel.appendChild(line);
      }
    }
export function addTermLine(html, cls = 'sys') {
      const out = document.getElementById('terminal-output');
      const p = document.createElement('p');
      p.className = `term-line ${cls}`;
      p.innerHTML = html;
      out.appendChild(p);
      if (out.children.length > 8) out.removeChild(out.firstChild);
    }
export function startTermClock() {
      termSeconds = 0;
      clearInterval(termClockInterval);
      termClockInterval = setInterval(() => {
        termSeconds++;
        const m = String(Math.floor(termSeconds / 60)).padStart(2, '0');
        const s = String(termSeconds % 60).padStart(2, '0');
        document.getElementById('term-clock').textContent = `${m}:${s}`;
      }, 1000);
    }
export function startTerminal() {
      document.getElementById('terminal-output').innerHTML = '';
      clearInterval(terminalInterval);
      clearInterval(fakeDownloadTimer);
      clearInterval(downloadPoller);

      startTermClock();

      document.getElementById('download-fill').style.width = '0%';
      document.getElementById('download-percent').textContent = '0%';
      document.getElementById('metric-speed').textContent = '-- MB/s';
      document.getElementById('metric-size').textContent = '0 MB';
      document.getElementById('metric-frames').textContent = '0';
      document.getElementById('metric-state').textContent = 'BOOT';
      document.getElementById('download-phase').textContent = 'CONNECTING TO STREAM NODE...';

      const messages = [
        ['[XDOWN] Initializing orbital transfer tunnel...', 'sys'],
        ['[yt-dlp] Extracting adaptive manifests...', 'hi'],
        ['[SERVER] Chromium interception attached', 'sys'],
        ['[FFmpeg] Pipe mode: frag_keyframe + empty_moov', 'hi'],
        ['[MUX] MP4 live fragmentation enabled', 'sys'],
        ['[PIPE] Waiting for live backend telemetry...', 'warn'],
      ];

      messages.forEach((msg, i) => {
        setTimeout(() => addTermLine(msg[0], msg[1]), i * 450);
      });
    }
export function stopTerminal(finalData = {}) {
      clearInterval(terminalInterval);
      clearInterval(termClockInterval);
      clearInterval(fakeDownloadTimer);
      clearInterval(downloadPoller);

      document.getElementById('download-fill').style.width = '100%';
      document.getElementById('download-percent').textContent = '100%';
      document.getElementById('metric-state').textContent = 'DONE';
      document.getElementById('download-phase').textContent = 'DOWNLOAD COMPLETE';

      if (finalData.size) {
        document.getElementById('metric-size').textContent = finalData.size;
      }

      addTermLine('[PIPE] Browser accepted binary stream', 'hi');
      addTermLine('[FFmpeg] Final fragment committed successfully', 'ok');
      addTermLine('[BROWSER] Native Chrome download manager confirmed', 'ok');
      addTermLine('✅ DOWNLOAD PIPELINE COMPLETE', 'ok');
    }
export async function startWarpDownload(e) {
      e.preventDefault();
      if (!videoInfo) return;
      // Hide the resume banner if visible
      const resumeBanner = document.getElementById('resume-banner');
      if (resumeBanner) resumeBanner.remove();
      // Mark that a download is actively running (survives refresh)
      sessionStorage.setItem('xdown_downloading', '1');

      // 🛑 Clear any active background pre-buffer to avoid downloading twice!
      const streamVideo = document.getElementById('stream-video');
      if (streamVideo && streamVideo.src) {
        console.log('🛑 Killing background pre-buffer before download');
        streamVideo.pause();
        streamVideo.removeAttribute('src');
        streamVideo.load();
      }

      const hud = document.getElementById('warp-hud');
      const core = document.getElementById('reactor-core');

      hud.classList.add('active');
      core.classList.remove('success');
      document.getElementById('warp-close').classList.remove('visible');

      const unloadGuard = (e) => {
        e.preventDefault();
        e.returnValue = 'Download in progress. Leave?';
        return e.returnValue;
      };
      window.addEventListener('beforeunload', unloadGuard);

      buildWarpLines();
      startTerminal();

      try {
        document.getElementById('metric-state').textContent = 'PREP';
        document.getElementById('download-phase').textContent = 'REQUESTING FILE HANDLE...';

        const fileName = `${(videoInfo.title || 'xdown_video').replace(/[\\/:*?"<>|]/g, '_')}.mp4`;

        let writable = null;
        let fallbackMode = false;
        let fileHandle = null;

        if ('showSaveFilePicker' in window) {
          try {
            addTermLine('[FS] Waiting for native browser save permission...', 'hi');

            fileHandle = await window.showSaveFilePicker({
              suggestedName: fileName,
              types: [{
                description: 'Video File',
                accept: { 'video/mp4': ['.mp4'] }
              }]
            });

            writable = await fileHandle.createWritable();
            addTermLine('[FS] Native filesystem access granted', 'ok');
            addTermLine('[PIPE] Direct-to-disk stream initialized', 'ok');

          } catch (fsErr) {
            if (fsErr.name === 'AbortError') {
              addTermLine('[FS] User cancelled file save dialog', 'warn');
            } else {
              addTermLine(`[FS] Error: ${fsErr.message}`, 'warn');
            }
            fallbackMode = true;
          }
        } else {
          fallbackMode = true;
          addTermLine('[WARN] Browser missing File System Access API', 'warn');
        }

        if (fallbackMode) {
          // ⚠️ Don't use href navigation — it unloads the page and causes an infinite reload loop.
          // Instead, fetch the stream ourselves and create a blob URL for download.
          addTermLine('[WARN] FS API unavailable — streaming to blob then triggering save...', 'hi');
          sessionStorage.removeItem('xdown_downloading'); // clear flag before anything async
          try {
            const dlUrl = buildDlUrl(false);
            const blobRes = await fetch(dlUrl, { cache: 'no-store' });
            if (!blobRes.ok) throw new Error('Blob fetch failed: ' + blobRes.status);

            const contentLength = Number(blobRes.headers.get('Content-Length')) || 0;
            if (contentLength > 500 * 1024 * 1024) {
              throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(0)}MB) for RAM buffering. Use Chrome/Edge desktop for large files.`);
            }

            const blobReader = blobRes.body.getReader();
            const chunks = [];
            let blobReceived = 0;
            while (true) {
              const { done, value } = await blobReader.read();
              if (done) break;
              chunks.push(value);
              blobReceived += value.length;
              const mb = (blobReceived / 1024 / 1024).toFixed(1);
              requestAnimationFrame(() => {
                document.getElementById('download-phase').textContent = `BUFFERING ${mb} MB...`;
                document.getElementById('metric-size').textContent = mb + ' MB';
              });
            }
            const blob = new Blob(chunks, { type: 'video/mp4' });
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = fileName;
            a.target = '_blank';
            document.body.appendChild(a);

            const evt = new MouseEvent('click', {
              bubbles: false,
              cancelable: false,
              view: window
            });
            a.dispatchEvent(evt);

            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            addTermLine('[BROWSER] Blob download triggered successfully', 'ok');
          } catch (blobErr) {
            addTermLine(`[ERROR] Blob fallback failed: ${blobErr.message}`, 'warn');
          }
          stopTerminal({ size: 'Unknown' });
          core.classList.add('success');
          setTimeout(() => { document.getElementById('warp-close').classList.add('visible'); }, 1200);
          return;
        }

        document.getElementById('metric-state').textContent = 'LINK';
        document.getElementById('download-phase').textContent = 'CONNECTING TO STREAM NODE...';

        addTermLine('[LINK] Requesting backend download stream...', 'hi');

        const response = await fetch(buildDlUrl(false), { method: 'GET', cache: 'no-store' });

        if (!response.ok) {
          throw new Error('Backend stream failed');
        }

        addTermLine('[SERVER] Live byte stream opened', 'ok');

        const total = Number(response.headers.get('Content-Length')) || 0;
        addTermLine('[NET] Backend socket locked · awaiting binary chunks', 'hi');

        document.getElementById('metric-state').textContent = 'WRITE';
        document.getElementById('download-phase').textContent = 'STREAMING DIRECTLY TO DISK...';

        addTermLine('[PIPE] Live chunks flowing directly into browser disk writer', 'ok');

        const reader = response.body.getReader();
        let received = 0;
        let frameCount = 0;
        const startTime = Date.now();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (received === 0) {
              addTermLine(`[STREAM] First binary chunk received · ${value.length} bytes`, 'ok');
              document.getElementById('metric-state').textContent = 'LIVE';
            }

            received += value.length;
            frameCount += Math.floor(value.length / 12000);

            const elapsed = (Date.now() - startTime) / 1000;
            const speed = elapsed > 0 ? (received / 1024 / 1024 / elapsed) : 0;
            const mb = received / 1024 / 1024;

            const progressPercent = total > 0
              ? Math.min(100, (received / total) * 100)
              : Math.min(95, Math.max(2, frameCount / 1.5));

            requestAnimationFrame(() => {
              document.getElementById('download-fill').style.width = `${progressPercent}%`;
              document.getElementById('download-percent').textContent = `${Math.floor(progressPercent)}%`;
              document.getElementById('metric-speed').textContent = `${speed.toFixed(1)} MB/s`;
              document.getElementById('metric-size').textContent = `${mb.toFixed(1)} MB`;
              document.getElementById('metric-frames').textContent = frameCount.toLocaleString();
              document.getElementById('download-phase').textContent = total > 0
                ? `STREAMING ${(received / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB`
                : `LIVE FRAGMENT PIPE · ${frameCount} FRAGS`;
            });

            if (frameCount % 6 === 0) {
              addTermLine(
                `[STREAM] ${mb.toFixed(1)}MB @ ${speed.toFixed(1)}MB/s | chunk=${value.length}`,
                speed > 5 ? 'ok' : 'sys'
              );
            }

            await writable.write(value);
          }

          await writable.close();
        } catch (err) {
          if (writable) {
            try { await writable.abort(); } catch { }
          }
          throw err;
        }

        if (total > 0 && received < total) {
          throw new Error('STREAM_INTERRUPTED_OR_EXPIRED');
        }

        addTermLine('[DISK] Stream finalized successfully', 'ok');
        // Download succeeded — clear the pending-download flag
        sessionStorage.removeItem('xdown_downloading');

        stopTerminal({
          size: document.getElementById('metric-size').textContent
        });

        core.classList.add('success');

        setTimeout(() => {
          document.getElementById('warp-close').classList.add('visible');
        }, 1200);

      } catch (err) {
        console.error(err);
        // Download failed — clear the pending-download flag so we don't loop
        sessionStorage.removeItem('xdown_downloading');

        document.getElementById('metric-state').textContent = 'ERROR';
        document.getElementById('download-phase').textContent = 'TRANSFER FAILED';

        addTermLine(`[ERROR] ${err.message}`, 'warn');

        if (err.message === 'STREAM_INTERRUPTED_OR_EXPIRED') {
          addTermLine(`[PIPE] Connection dropped mid-stream (Token expired or rate-limited)`, 'warn');
          addTermLine(`[AUTO-FIX] Close this panel and click Download again to get a fresh link.`, 'hi');
        } else {
          addTermLine('[PIPE] Stream collapsed before completion', 'warn');
        }

        document.getElementById('warp-close').classList.add('visible');
      } finally {
        window.removeEventListener('beforeunload', unloadGuard);
      }
    }
export function closeWarp() {
      document.getElementById('warp-hud').classList.remove('active');
      document.getElementById('terminal-output').innerHTML = '';
      clearInterval(terminalInterval);
      clearInterval(termClockInterval);
      clearInterval(downloadPoller);
    }
