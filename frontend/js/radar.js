
export let radarBlipTimer = null;
export function spawnBlip() {
      const g = document.getElementById('radar-blips');
      const angle = Math.random() * Math.PI * 2;
      const dist = 20 + Math.random() * 70;
      const cx = 100 + Math.cos(angle) * dist;
      const cy = 100 + Math.sin(angle) * dist;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', '3');
      circle.setAttribute('fill', 'var(--cyan)');
      circle.classList.add('radar-blip');
      g.appendChild(circle);

      setTimeout(() => { try { g.removeChild(circle); } catch { } }, 2400);
    }
export function startRadar() {
      clearInterval(radarBlipTimer);
      radarBlipTimer = setInterval(spawnBlip, 400);

      let freq = 0;
      const freqTimer = setInterval(() => {
        freq = (Math.random() * 999).toFixed(2);
        document.getElementById('radar-freq').textContent = freq + ' MHz';
      }, 200);

      return freqTimer;
    }
export function stopRadar(freqTimer) {
      clearInterval(radarBlipTimer);
      clearInterval(freqTimer);
      document.getElementById('radar-freq').textContent = 'LOCKED';
      document.getElementById('radar-label').textContent = 'ACQUIRED';
    }
