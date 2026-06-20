
import { buildDlUrl, getServer } from './utils.js';
import { videoInfo, hlsInstance, setHlsInstance, shakaPlayer, setShakaPlayer } from './state.js';

export let playerState = null;
export function initVideoPlayer() {
      const video = document.getElementById('stream-video');
      const playerContainer = document.getElementById('video-player-container');

      // Remove any existing controls
      const existingWrapper = playerContainer.querySelector('.player-wrapper');
      if (existingWrapper) {
        existingWrapper.remove();
      }

      // Create controls HTML
      const controlsHTML = `
        <div class="player-wrapper">
          <div class="player-controls" id="player-controls">
            <div class="progress-wrapper">
              <div class="progress-container" id="progress-container">
                <div class="progress-buffered" id="progress-buffered"></div>
                <div class="progress-fill" id="progress-fill"></div>
                <div class="progress-handle" id="progress-handle"></div>
                <div class="progress-tooltip" id="progress-tooltip">0:00</div>
              </div>
            </div>

            <div class="controls-row">
              <div class="controls-left">
                <button class="control-btn" id="play-btn" title="Play/Pause (Space)">
                  <svg class="icon-play" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21"/>
                  </svg>
                  <svg class="icon-pause" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="display:none;">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                  </svg>
                </button>

                <div class="volume-group">
                  <button class="control-btn" id="volume-btn" title="Mute (M)">
                    <svg class="icon-volume" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                  </button>
                  <div class="volume-slider-container">
                    <input type="range" id="volume-slider" class="volume-slider" min="0" max="100" value="100">
                    <span id="volume-value" class="volume-value">100%</span>
                  </div>
                </div>

                <div class="time-display">
                  <span id="current-time">0:00</span>
                  <span class="time-separator">/</span>
                  <span id="duration">0:00</span>
                </div>
              </div>

              <div class="controls-right">
                <select id="stream-quality-select" class="control-select" title="Video Quality">
                  <option value="best">Auto/Best</option>
                </select>

                <select id="speed-select" class="control-select" title="Playback speed">
                  <option value="0.5">0.5×</option>
                  <option value="0.75">0.75×</option>
                  <option value="1" selected>1×</option>
                  <option value="1.25">1.25×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2×</option>
                </select>

                <button class="control-btn" id="theater-btn" title="Theater Mode (T)">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="4" width="20" height="16" rx="1"/>
                    <line x1="2" y1="8" x2="22" y2="8"/>
                  </svg>
                </button>

                <button class="control-btn" id="fullscreen-btn" title="Fullscreen (F)">
                  <svg class="icon-fullscreen" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                  </svg>
                  <svg class="icon-fullscreen-exit" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="display:none;">
                    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;

      // Insert controls after video
      video.insertAdjacentHTML('afterend', controlsHTML);

      // State
      playerState = {
        playing: false,
        volume: 100,
        isMuted: false,
        isDraggingProgress: false,
        isFullscreen: false,
        isTheaterMode: false,
        controlsTimeout: null,
        lastMouseMove: Date.now()
      };

      // Elements
      const playBtn = document.getElementById('play-btn');
      const progressContainer = document.getElementById('progress-container');
      const progressFill = document.getElementById('progress-fill');
      const progressBuffered = document.getElementById('progress-buffered');
      const progressHandle = document.getElementById('progress-handle');
      const progressTooltip = document.getElementById('progress-tooltip');
      const currentTimeEl = document.getElementById('current-time');
      const durationEl = document.getElementById('duration');
      const volumeBtn = document.getElementById('volume-btn');
      const volumeSlider = document.getElementById('volume-slider');
      const volumeValue = document.getElementById('volume-value');
      const speedSelect = document.getElementById('speed-select');
      const fullscreenBtn = document.getElementById('fullscreen-btn');
      const theaterBtn = document.getElementById('theater-btn');
      const playerControls = document.getElementById('player-controls');
      const bufferingIndicator = document.getElementById('buffering-indicator');
      const iconPlay = playBtn.querySelector('.icon-play');
      const iconPause = playBtn.querySelector('.icon-pause');
      const iconFullscreen = fullscreenBtn.querySelector('.icon-fullscreen');
      const iconFullscreenExit = fullscreenBtn.querySelector('.icon-fullscreen-exit');

      // Helper Functions
      function formatTime(seconds) {
        if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00';
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) {
          return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
        return `${minutes}:${String(secs).padStart(2, '0')}`;
      }

      function updateProgress() {
        if (!playerState.isDraggingProgress && video.duration) {
          const percent = (video.currentTime / video.duration) * 100 || 0;
          progressFill.style.width = percent + '%';
          progressHandle.style.left = percent + '%';
        }
        currentTimeEl.textContent = formatTime(video.currentTime);
      }

      function updateBuffered() {
        if (video.buffered.length > 0 && video.duration) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          const percent = (bufferedEnd / video.duration) * 100 || 0;
          progressBuffered.style.width = percent + '%';
        }
      }

      function togglePlayPause() {
        if (video.paused) {
          video.play().catch(err => {
            console.error('Play failed:', err);
          });
        } else {
          video.pause();
        }
      }

      function updateVolume(newVolume) {
        playerState.volume = Math.max(0, Math.min(100, newVolume));
        video.volume = playerState.volume / 100;
        const sa = document.getElementById('stream-audio');
        if (sa) sa.volume = video.volume;

        volumeSlider.value = playerState.volume;
        volumeValue.textContent = Math.round(playerState.volume) + '%';

        // Update slider gradient
        volumeSlider.style.setProperty('--volume-percent', playerState.volume + '%');

        playerState.isMuted = playerState.volume === 0;
        video.muted = playerState.isMuted;
        if (sa) sa.muted = playerState.isMuted;

        if (playerState.isMuted) {
          volumeBtn.classList.add('muted');
        } else {
          volumeBtn.classList.remove('muted');
        }
      }

      function toggleMute() {
        if (playerState.isMuted) {
          updateVolume(playerState.volume || 80);
        } else {
          updateVolume(0);
        }
      }

      function toggleFullscreen() {
        const elem = playerContainer;

        if (!playerState.isFullscreen) {
          if (elem.requestFullscreen) {
            elem.requestFullscreen().catch(err => console.error('Fullscreen failed:', err));
          } else if (elem.webkitRequestFullscreen) {
            elem.webkitRequestFullscreen();
          } else if (elem.mozRequestFullScreen) {
            elem.mozRequestFullScreen();
          } else if (elem.msRequestFullscreen) {
            elem.msRequestFullscreen();
          }
        } else {
          if (document.exitFullscreen) {
            document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
          }
        }
      }

      function toggleTheaterMode() {
        playerState.isTheaterMode = !playerState.isTheaterMode;

        if (playerState.isTheaterMode) {
          playerContainer.classList.add('theater-mode');
          theaterBtn.classList.add('active');
        } else {
          playerContainer.classList.remove('theater-mode');
          theaterBtn.classList.remove('active');
        }
      }

      function showControls() {
        playerState.lastMouseMove = Date.now();
        playerControls.classList.remove('hidden');
        playerContainer.style.cursor = 'default';

        clearTimeout(playerState.controlsTimeout);

        if (playerState.playing) {
          playerState.controlsTimeout = setTimeout(() => {
            if (Date.now() - playerState.lastMouseMove > 2500) {
              hideControls();
            }
          }, 3000);
        }
      }

      function hideControls() {
        if (playerState.playing && !playerState.isDraggingProgress) {
          playerControls.classList.add('hidden');
          playerContainer.style.cursor = 'none';
        }
      }

      function seekToPosition(clientX) {
        const rect = progressContainer.getBoundingClientRect();
        const percent = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
        const time = (percent / 100) * video.duration;

        if (isFinite(time) && time >= 0 && time <= video.duration) {
          video.currentTime = time;
          progressFill.style.width = percent + '%';
          progressHandle.style.left = percent + '%';
        }
      }

      // Event Handlers
      playBtn.addEventListener('click', togglePlayPause);

      video.addEventListener('play', () => {
        playerState.playing = true;
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
        showControls();
      });

      video.addEventListener('pause', () => {
        playerState.playing = false;
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        showControls();
      });

      video.addEventListener('timeupdate', updateProgress);
      video.addEventListener('progress', updateBuffered);

      video.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(video.duration);
        updateBuffered();
        console.log('✅ Video metadata loaded, duration:', video.duration);
      });

      video.addEventListener('waiting', () => {
        bufferingIndicator.style.display = 'flex';
      });

      video.addEventListener('canplay', () => {
        bufferingIndicator.style.display = 'none';
      });

      video.addEventListener('playing', () => {
        bufferingIndicator.style.display = 'none';
      });

      video.addEventListener('ended', () => {
        playerState.playing = false;
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        showControls();
      });

      // Progress seeking
      progressContainer.addEventListener('mousedown', (e) => {
        playerState.isDraggingProgress = true;
        seekToPosition(e.clientX);
      });

      document.addEventListener('mousemove', (e) => {
        if (playerState.isDraggingProgress) {
          seekToPosition(e.clientX);
        }
      });

      document.addEventListener('mouseup', () => {
        playerState.isDraggingProgress = false;
      });

      playerContainer.addEventListener('mousemove', showControls);
      playerContainer.addEventListener('mouseleave', hideControls);

      progressContainer.addEventListener('click', (e) => {
        seekToPosition(e.clientX);
      });

      progressContainer.addEventListener('mousemove', (e) => {
        if (!video.duration) return;

        const rect = progressContainer.getBoundingClientRect();
        const percent = ((e.clientX - rect.left) / rect.width) * 100;
        const time = (percent / 100) * video.duration;

        progressTooltip.textContent = formatTime(time);
        progressTooltip.style.left = Math.max(0, Math.min(100, percent)) + '%';
      });

      // Volume controls
      volumeBtn.addEventListener('click', toggleMute);
      volumeSlider.addEventListener('input', (e) => {
        updateVolume(parseFloat(e.target.value));
      });

      // Speed control
      speedSelect.addEventListener('change', (e) => {
        video.playbackRate = parseFloat(e.target.value);
      });

      const streamQualitySelect = document.getElementById('stream-quality-select');
      streamQualitySelect.addEventListener('change', (e) => {
        if (hlsInstance || shakaPlayer) return; // Handled natively by HLS/DASH

        const mainQualitySelect = document.getElementById('quality-display');
        if (mainQualitySelect) {
          mainQualitySelect.value = e.target.value;
        }

        const currentTime = video.currentTime;
        const wasPlaying = !video.paused;

        // Start the stream with the new quality and pass the preserved time
        startStream(null, currentTime, wasPlaying);
      });

      // Fullscreen
      fullscreenBtn.addEventListener('click', toggleFullscreen);

      document.addEventListener('fullscreenchange', () => {
        playerState.isFullscreen = !!document.fullscreenElement;
        if (playerState.isFullscreen) {
          iconFullscreen.style.display = 'none';
          iconFullscreenExit.style.display = 'block';
        } else {
          iconFullscreen.style.display = 'block';
          iconFullscreenExit.style.display = 'none';
        }
      });

      // Theater mode
      theaterBtn.addEventListener('click', toggleTheaterMode);

      // Auto-hide controls
      playerContainer.addEventListener('mousemove', () => {
        showControls();
      });

      playerContainer.addEventListener('mouseleave', () => {
        if (playerState.playing) {
          hideControls();
        }
      });

      // Click to play/pause
      video.addEventListener('click', togglePlayPause);

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        // Don't intercept if typing in input field
        if (e.target === document.getElementById("url-input") || e.target.tagName === 'INPUT') return;

        // Only handle if stream window is active
        if (!document.getElementById('stream-window').classList.contains('active')) return;

        switch (e.key.toLowerCase()) {
          case ' ':
          case 'k':
            e.preventDefault();
            togglePlayPause();
            showControls();
            break;

          case 'f':
            e.preventDefault();
            toggleFullscreen();
            break;

          case 't':
            e.preventDefault();
            toggleTheaterMode();
            break;

          case 'm':
            e.preventDefault();
            toggleMute();
            showControls();
            break;

          case 'arrowleft':
            e.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - 5);
            showControls();
            break;

          case 'arrowright':
            e.preventDefault();
            video.currentTime = Math.min(video.duration, video.currentTime + 5);
            showControls();
            break;

          case 'j':
            e.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - 10);
            showControls();
            break;

          case 'l':
            e.preventDefault();
            video.currentTime = Math.min(video.duration, video.currentTime + 10);
            showControls();
            break;

          case 'arrowup':
            e.preventDefault();
            updateVolume(playerState.volume + 5);
            showControls();
            break;

          case 'arrowdown':
            e.preventDefault();
            updateVolume(playerState.volume - 5);
            showControls();
            break;

          case '>':
            if (e.shiftKey) {
              e.preventDefault();
              const newSpeed = Math.min(2, video.playbackRate + 0.25);
              video.playbackRate = newSpeed;
              speedSelect.value = newSpeed;
              showControls();
            }
            break;

          case '<':
            if (e.shiftKey) {
              e.preventDefault();
              const newSpeed = Math.max(0.25, video.playbackRate - 0.25);
              video.playbackRate = newSpeed;
              speedSelect.value = newSpeed;
              showControls();
            }
            break;

          case '0':
          case '1':
          case '2':
          case '3':
          case '4':
          case '5':
          case '6':
          case '7':
          case '8':
          case '9':
            e.preventDefault();
            const percent = parseInt(e.key) * 10;
            video.currentTime = (percent / 100) * video.duration;
            showControls();
            break;
        }
      });

      // Initialize
      showControls();
      updateVolume(100);

      console.log('✅ Enhanced video player initialized with full controls');
    }
