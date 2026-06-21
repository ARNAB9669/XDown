export let audioContext = null;
 
// EQ chain
let subBassFilter = null;   // 60 Hz  — low-shelf
let bassFilter = null;       // 120 Hz — peaking
let midFilter = null;        // 800 Hz — peaking
let presenceFilter = null;   // 3.5 kHz — peaking
let airFilter = null;        // 10 kHz — high-shelf
 
// Dynamics
let preGain = null;          // Input trim
let compressor = null;       // Soft limiter / loudness leveler
let volumeGain = null;       // Master output
 
// Stereo widener (M-S encode/decode pair)
let mergerNode = null;
let splitterNode = null;
let midGainL = null;
let midGainR = null;
let sideGainL = null;
let sideGainR = null;
let widenerOutputMerger = null;
 
let _widthAmount = 1.0; // 1 = unchanged, >1 = wider, <1 = narrower
 
// ─── Presets ─────────────────────────────────────────────────────────────────
export const EQ_PRESETS = {
  flat: {
    label: 'Flat',
    subBass: 0, bass: 0, mid: 0, presence: 0, air: 0,
    width: 1.0, loudness: 0, volume: 1.0,
  },
  bassBoost: {
    label: 'Bass Boost',
    subBass: 6, bass: 8, mid: -1, presence: 1, air: 2,
    width: 1.1, loudness: 3, volume: 1.0,
  },
  voiceClarity: {
    label: 'Voice Clarity',
    subBass: -4, bass: -2, mid: 2, presence: 6, air: 4,
    width: 0.85, loudness: 4, volume: 1.0,
  },
  cinema: {
    label: 'Cinema',
    subBass: 5, bass: 3, mid: -2, presence: 3, air: 5,
    width: 1.4, loudness: 5, volume: 1.0,
  },
  loFi: {
    label: 'Lo-Fi',
    subBass: -6, bass: 4, mid: 2, presence: -4, air: -8,
    width: 0.5, loudness: -2, volume: 0.9,
  },
};
 
// ─── Init ─────────────────────────────────────────────────────────────────────
/**
 * Call once. Idempotent — safe to call again; exits early if already set up.
 * @param {HTMLVideoElement|null} videoElement
 * @param {HTMLAudioElement|null} audioElement  (optional split-stream audio)
 */
export function initAudioEQ(videoElement, audioElement) {
  if (audioContext) return;
 
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: 'playback' });
 
    // ── 1. Input gain (trim) ──────────────────────────────────────────────
    preGain = audioContext.createGain();
    preGain.gain.value = 1.0;
 
    // ── 2. EQ chain ───────────────────────────────────────────────────────
    subBassFilter = _makeFilter('lowshelf',  60,   0, 1.0);
    bassFilter    = _makeFilter('peaking',   120,  0, 1.2);
    midFilter     = _makeFilter('peaking',   800,  0, 0.9);
    presenceFilter= _makeFilter('peaking',   3500, 0, 1.1);
    airFilter     = _makeFilter('highshelf', 10000,0, 1.0);
 
    // ── 3. Stereo widener (M-S processing) ───────────────────────────────
    // Split L/R → encode to Mid/Side → scale Side → decode back to L/R
    splitterNode        = audioContext.createChannelSplitter(2);
    mergerNode          = audioContext.createChannelMerger(2);
    midGainL            = audioContext.createGain();  // L contribution to Mid
    midGainR            = audioContext.createGain();  // R contribution to Mid
    sideGainL           = audioContext.createGain();  // L contribution to Side (scaled)
    sideGainR           = audioContext.createGain();  // R contribution to Side (scaled)
    widenerOutputMerger = audioContext.createChannelMerger(2);
 
    // The M-S decode re-injects mid+side → L,  mid-side → R
    // We achieve stereo width by scaling the side channel before decoding.
    // At width=1 the round-trip is transparent.
    _rebuildWidenerGraph(_widthAmount);
 
    // ── 4. Dynamics: DynamicsCompressor as soft limiter ──────────────────
    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -18;   // dB — start compressing here
    compressor.knee.value      = 6;     // smooth knee
    compressor.ratio.value     = 3;     // gentle compression ratio
    compressor.attack.value    = 0.003; // 3 ms attack
    compressor.release.value   = 0.25;  // 250 ms release
 
    // ── 5. Master volume ─────────────────────────────────────────────────
    volumeGain = audioContext.createGain();
    volumeGain.gain.value = 1.0;
 
    // ── 6. Wire the chain ─────────────────────────────────────────────────
    // source → preGain → EQ → splitter → [widener] → compressor → volumeGain → output
    preGain
      .connect(subBassFilter)
      .connect(bassFilter)
      .connect(midFilter)
      .connect(presenceFilter)
      .connect(airFilter)
      .connect(splitterNode);
    // widener internals connect splitter → widenerOutputMerger
    widenerOutputMerger
      .connect(compressor)
      .connect(volumeGain)
      .connect(audioContext.destination);
 
    // ── 7. Attach media sources ──────────────────────────────────────────
    _attachSource(videoElement);
    _attachSource(audioElement);
 
  } catch (e) {
    console.warn('[audioEQ] Web Audio API init failed:', e);
  }
}
 
function _attachSource(mediaElement) {
  if (!mediaElement) return;
  if (!mediaElement._aeqSourceNode) {
    mediaElement._aeqSourceNode = audioContext.createMediaElementSource(mediaElement);
  }
  mediaElement._aeqSourceNode.connect(preGain);
}
 
// ─── EQ Band Controls ─────────────────────────────────────────────────────────
/**
 * Set a single EQ band gain.
 * @param {'subBass'|'bass'|'mid'|'presence'|'air'} band
 * @param {number} gainDb  — range roughly -18 … +18 dB
 */
export function setEQBand(band, gainDb) {
  const map = {
    subBass: subBassFilter,
    bass: bassFilter,
    mid: midFilter,
    presence: presenceFilter,
    air: airFilter,
  };
  const node = map[band];
  if (node) node.gain.setTargetAtTime(gainDb, audioContext.currentTime, 0.02);
}
 
/** Convenience: toggle bass boost (legacy compatibility) */
export function setEQBass(enable) {
  setEQBand('subBass', enable ? 6 : 0);
  setEQBand('bass',    enable ? 8 : 0);
}
 
// ─── Volume ────────────────────────────────────────────────────────────────────
/**
 * @param {number} volumePercent  0–150 (100 = unity, 150 = +50% boost)
 */
export function setEQVolume(volumePercent) {
  if (!volumeGain) return;
  // Keep gain linear; >100% is a legitimate loudness boost (compressor handles peaks)
  volumeGain.gain.setTargetAtTime(volumePercent / 100, audioContext.currentTime, 0.02);
}
 
// ─── Loudness Boost (makeup gain on pre-gain) ─────────────────────────────────
/**
 * @param {number} db  Gain to add before EQ/compression. Range: -12 … +12
 */
export function setLoudnessBoost(db) {
  if (!preGain) return;
  const linear = Math.pow(10, db / 20);
  preGain.gain.setTargetAtTime(linear, audioContext.currentTime, 0.02);
}
 
// ─── Stereo Width ─────────────────────────────────────────────────────────────
/**
 * @param {number} width  0 = mono, 1 = original, 2 = very wide
 */
export function setStereoWidth(width) {
  _widthAmount = Math.max(0, width);
  if (audioContext) _rebuildWidenerGraph(_widthAmount);
}
 
function _rebuildWidenerGraph(width) {
  // Disconnect existing internal widener wires (if any)
  try { splitterNode.disconnect(); } catch (_) {}
  try { midGainL.disconnect(); }    catch (_) {}
  try { midGainR.disconnect(); }    catch (_) {}
  try { sideGainL.disconnect(); }   catch (_) {}
  try { sideGainR.disconnect(); }   catch (_) {}
 
  const s = width; // side scale factor
 
  // L channel: ch 0 — split into midGainL (scale 0.5) and sideGainL (scale s*0.5)
  // R channel: ch 1 — split into midGainR (scale 0.5) and sideGainR (scale s*0.5)
  // Out L = midGainL + midGainR + sideGainL - sideGainR  (mid + side)
  // Out R = midGainL + midGainR - sideGainL + sideGainR  (mid - side)
  //
  // Simplified to two inverter paths via gain nodes:
 
  midGainL.gain.value  =  0.5;
  midGainR.gain.value  =  0.5;
  sideGainL.gain.value =  s * 0.5;
  sideGainR.gain.value = -s * 0.5; // inverted for R output side subtraction
 
  // L source → both mid gains
  splitterNode.connect(midGainL, 0);
  splitterNode.connect(midGainR, 1);
 
  // L source → sideGainL (positive) → both output channels
  splitterNode.connect(sideGainL, 0);
  // R source → sideGainR (negative) → both output channels
 
  splitterNode.connect(sideGainR, 1);
 
  // Merge to output L (ch 0)
  midGainL.connect(widenerOutputMerger, 0, 0);
  midGainR.connect(widenerOutputMerger, 0, 0);
  sideGainL.connect(widenerOutputMerger, 0, 0);
  sideGainR.connect(widenerOutputMerger, 0, 0);
 
  // Merge to output R (ch 1) — side is inverted
  midGainL.connect(widenerOutputMerger, 0, 1);
  midGainR.connect(widenerOutputMerger, 0, 1);
 
  const sideGainLInv = audioContext.createGain();
  const sideGainRInv = audioContext.createGain();
  sideGainLInv.gain.value = -s * 0.5;
  sideGainRInv.gain.value =  s * 0.5;
  splitterNode.connect(sideGainLInv, 0);
  splitterNode.connect(sideGainRInv, 1);
  sideGainLInv.connect(widenerOutputMerger, 0, 1);
  sideGainRInv.connect(widenerOutputMerger, 0, 1);
}
 
// ─── Presets ──────────────────────────────────────────────────────────────────
/**
 * Apply a named preset.
 * @param {keyof typeof EQ_PRESETS} presetName
 */
export function applyPreset(presetName) {
  const p = EQ_PRESETS[presetName];
  if (!p) { console.warn(`[audioEQ] Unknown preset: ${presetName}`); return; }
 
  setEQBand('subBass',  p.subBass);
  setEQBand('bass',     p.bass);
  setEQBand('mid',      p.mid);
  setEQBand('presence', p.presence);
  setEQBand('air',      p.air);
  setStereoWidth(p.width);
  setLoudnessBoost(p.loudness);
  setEQVolume(p.volume * 100);
}
 
// ─── Context Lifecycle ────────────────────────────────────────────────────────
export function resumeAudioContext() {
  if (audioContext?.state === 'suspended') audioContext.resume();
}
 
export function suspendAudioContext() {
  if (audioContext?.state === 'running') audioContext.suspend();
}
 
/**
 * Fully tear down — call if the video player is destroyed/unmounted.
 */
export function destroyAudioEQ() {
  try { audioContext?.close(); } catch (_) {}
  audioContext = subBassFilter = bassFilter = midFilter = presenceFilter =
    airFilter = preGain = compressor = volumeGain =
    splitterNode = mergerNode = midGainL = midGainR = sideGainL = sideGainR =
    widenerOutputMerger = null;
}
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
function _makeFilter(type, frequency, gainDb, q) {
  const f = audioContext.createBiquadFilter();
  f.type            = type;
  f.frequency.value = frequency;
  f.gain.value      = gainDb;
  f.Q.value         = q;
  return f;
}