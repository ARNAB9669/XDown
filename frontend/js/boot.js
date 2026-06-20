
export const bootLines = [
      { t: 'sys', s: 'XDOWN ORBITAL INTERCEPT SYSTEM v4.2' },
      { t: 'ok', s: '[ OK ] Kernel loaded — arm64-darwin' },
      { t: 'sys', s: 'Initializing memory subsystems...' },
      { t: 'ok', s: '[ OK ] 16 GB heap allocated' },
      { t: 'sys', s: 'Loading yt-dlp extraction engine...' },
      { t: 'ok', s: '[ OK ] yt-dlp 2024.11.18 — 1847 extractors' },
      { t: 'sys', s: 'Mounting FFmpeg pipe interface...' },
      { t: 'ok', s: '[ OK ] FFmpeg 8.1.1 — frag_keyframe pipe ready' },
      { t: 'sys', s: 'Spawning Chromium intercept node...' },
      { t: 'ok', s: '[ OK ] Puppeteer headless Chrome connected' },
      { t: 'sys', s: 'Calibrating HLS/DASH stream resolver...' },
      { t: 'ok', s: '[ OK ] Adaptive stream parser armed' },
      { t: 'sys', s: 'Running self-diagnostics...' },
      { t: 'ok', s: '[ OK ] All systems nominal' },
      { t: 'sys', s: 'SYSTEM READY — AWAITING TARGET ACQUISITION' },
    ];
export function runBoot() {
      const log = document.getElementById('boot-log');
      const fill = document.getElementById('boot-fill');
      const pct = document.getElementById('boot-pct');
      let i = 0;

      const tick = setInterval(() => {
        if (i >= bootLines.length) {
          clearInterval(tick);
          setTimeout(() => {
            document.getElementById('boot-screen').classList.add('hidden');
            document.getElementById('app').style.opacity = '1';
          }, 400);
          return;
        }

        const line = bootLines[i];
        const p = document.createElement('div');
        p.className = 'boot-log-line ' + line.t;
        p.textContent = line.s;
        log.appendChild(p);
        if (log.children.length > 7) log.removeChild(log.firstChild);

        const progress = Math.round(((i + 1) / bootLines.length) * 100);
        fill.style.width = progress + '%';
        pct.textContent = progress + '%';

        i++;
      }, 120);
    }
