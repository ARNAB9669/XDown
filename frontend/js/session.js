
import { san, fmt } from './utils.js';
import { setVideoInfo } from './state.js';

export function saveSession(info, url) {
      try {
        sessionStorage.setItem('xdown_videoInfo', JSON.stringify(info));
        sessionStorage.setItem('xdown_url', url);
        sessionStorage.setItem('xdown_ts', Date.now());
      } catch (e) { /* quota exceeded – ignore */ }
    }
export function clearSession() {
      sessionStorage.removeItem('xdown_videoInfo');
      sessionStorage.removeItem('xdown_url');
      sessionStorage.removeItem('xdown_ts');
      sessionStorage.removeItem('xdown_downloading');
    }
export function restoreSession() {
      try {
        const raw = sessionStorage.getItem('xdown_videoInfo');
        const savedUrl = sessionStorage.getItem('xdown_url');
        const ts = Number(sessionStorage.getItem('xdown_ts') || 0);
        const wasDownloading = sessionStorage.getItem('xdown_downloading') === '1';
        if (!raw || !savedUrl) return;
        // Ignore stale sessions older than 10 minutes
        if (Date.now() - ts > 10 * 60 * 1000) { clearSession(); return; }
        const info = JSON.parse(raw);
        setVideoInfo(info);
        document.getElementById("url-input").value = savedUrl;
        // Re-populate result panel (minimal restore)
        document.getElementById('analysis-status').textContent = '◆ SIGNAL LOCKED (RESTORED)';
        const tw = document.getElementById('thumb-wrap');
        tw.innerHTML = info.thumbnail
          ? `<img src="${san(info.thumbnail)}" alt="thumb" loading="lazy">`
          : `<div class="thumb-placeholder">NO SIGNAL</div>`;
        document.getElementById('video-title').textContent = info.title || 'Unknown';
        document.getElementById('video-source').textContent = (info.extractor || '—').toUpperCase();
        document.getElementById('video-author').textContent = info.uploader || '—';
        document.getElementById('video-dur').textContent = fmt(info.duration);
        const qEl = document.getElementById('quality-display');
        qEl.innerHTML = '';
        if (info.formats && info.formats.length > 0) {
          const bestOpt = document.createElement('option');
          bestOpt.value = 'best';
          bestOpt.textContent = `▲ BEST OF ${info.formats.length} FORMATS`;
          qEl.appendChild(bestOpt);
          info.formats.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.format_id;
            const sizeStr = f.filesize ? ` (${(f.filesize / 1024 / 1024).toFixed(1)}MB)` : '';
            const codecStr = f.vcodec !== 'none' && f.acodec !== 'none' ? ' 🔊' : (f.acodec === 'none' ? ' 🔇' : '');
            const fpsStr = (f.fps && f.fps > 0) ? ` ${f.fps}fps` : '';
            opt.textContent = `▶ ${f.height}p${fpsStr}${codecStr}${sizeStr}`;
            qEl.appendChild(opt);
          });
        }
        document.getElementById('result-panel').className = 'active';
        document.getElementById('dl-btn').removeAttribute('data-disabled');
        document.getElementById('stream-btn').removeAttribute('data-disabled');
        // Show a resume banner if a download was in progress \u2014 don't auto-call
        // showSaveFilePicker() since it requires a real user gesture or it'll loop.
        if (wasDownloading) {
          sessionStorage.removeItem('xdown_downloading');
          console.log('\ud83d\udd04 Download was interrupted by page refresh \u2014 showing resume banner');
          // Inject a resume banner into the page
          const banner = document.createElement('div');
          banner.id = 'resume-banner';
          banner.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
            background: linear-gradient(90deg, #ff6b35, #f7c59f);
            color: #1a1a2e; font-family: 'Courier New', monospace;
            font-weight: bold; font-size: 14px;
            padding: 12px 20px;
            display: flex; align-items: center; justify-content: space-between;
            box-shadow: 0 4px 20px rgba(255,107,53,0.5);
            animation: slideDown 0.3s ease;
          `;
          banner.innerHTML = `
            <span>\u26a0\ufe0f Download interrupted by browser refresh. Click to resume.</span>
            <div style="display:flex;gap:10px">
              <button onclick="startWarpDownload({preventDefault:()=>{}})" style="
                background:#1a1a2e; color:#ff6b35; border:2px solid #ff6b35;
                padding:6px 16px; font-family:inherit; font-weight:bold;
                cursor:pointer; border-radius:4px; font-size:13px;
              ">\u25b6 RESUME</button>
              <button onclick="document.getElementById('resume-banner').remove();clearSession();" style="
                background:transparent; color:#1a1a2e; border:2px solid #1a1a2e;
                padding:6px 12px; font-family:inherit; cursor:pointer;
                border-radius:4px; font-size:13px;
              ">\u2715</button>
            </div>
          `;
          document.body.prepend(banner);
        }
      } catch (e) { clearSession(); }
    }
