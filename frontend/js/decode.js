
export const decodeSteps = [
      { label: 'HANDSHAKE', values: ['SYN > SYN-ACK', 'TLS 1.3', 'ESTABLISHED'] },
      { label: 'DNS RESOLVE', values: ['QUERYING...', 'A-RECORD HIT', 'RESOLVED'] },
      { label: 'EXTRACTOR', values: ['yt-dlp probe', 'MATCHING...', 'EXTRACTOR OK'] },
      { label: 'MANIFEST', values: ['FETCHING...', 'PARSING...', 'DECODED'] },
      { label: 'STREAM MAP', values: ['INDEXING...', 'FORMAT LIST', 'MAPPED'] },
      { label: 'QUALITY SEL', values: ['SCORING...', 'BEST=MAX', '▲ BEST HQ'] },
    ];
export function resetDecode() {
      document.querySelectorAll('#decode-area .decode-row').forEach(row => {
        row.className = 'decode-row';
        row.querySelector('.decode-tick').textContent = '○';
        row.querySelector('.decode-value').textContent = '—';
      });
    }
export function animateDecode(onDone) {
      const rows = document.querySelectorAll('#decode-area .decode-row');
      let step = 0;

      function doStep() {
        if (step >= rows.length) { onDone(); return; }
        const row = rows[step];
        const tick = row.querySelector('.decode-tick');
        const val = row.querySelector('.decode-value');
        const info = decodeSteps[step];

        row.classList.add('active');
        tick.textContent = '◌';

        let vi = 0;
        const vTimer = setInterval(() => {
          val.textContent = info.values[vi % info.values.length];
          vi++;
          if (vi >= info.values.length + 2) {
            clearInterval(vTimer);
            val.textContent = info.values[info.values.length - 1];
            row.classList.remove('active');
            row.classList.add('done');
            tick.textContent = '✓';
            step++;
            setTimeout(doStep, 150);
          }
        }, 120);
      }

      doStep();
    }
