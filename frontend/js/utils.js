import { videoInfo } from './state.js';

export function getServer() { return ''; }
export function san(s) { return (s || '').replace(/[<>"'&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c])); }
export function fmt(s) {
      if (!s) return '—';
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
    }
export function buildDlUrl(useStream = false, trackType = null) {
      const pageUrl = document.getElementById("url-input").value.trim();
      const targetUrl = (videoInfo && videoInfo.url) ? videoInfo.url : pageUrl;
      const qEl = document.getElementById('quality-display');
      const selectedFormat = qEl ? qEl.value : 'best';
      const isCustomQuality = selectedFormat !== 'best';

      const endpoint = isCustomQuality ? '/download-quality' : '/download';

      let u = `${getServer()}${endpoint}?url=${encodeURIComponent(targetUrl)}&originalUrl=${encodeURIComponent(pageUrl)}`;
      if (useStream) u += `&inline=true`;
      if (isCustomQuality) u += `&format_id=${encodeURIComponent(selectedFormat)}`;
      if (trackType) u += `&track=${encodeURIComponent(trackType)}`;

      if (videoInfo?.stream) u += `&stream=${encodeURIComponent(videoInfo.stream)}`;
      if (videoInfo?.streamType) u += `&streamType=${encodeURIComponent(videoInfo.streamType)}`;
      if (videoInfo?.title) u += `&title=${encodeURIComponent(videoInfo.title)}`;
      return u;
    }
export function updateClock() {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      document.getElementById('clock').textContent = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
    }
