/**
 * Dirty Espionage — procedural audio via Web Audio API (no external files).
 */
const AudioEngine = (() => {
  let ctx = null;
  let muted = false;
  let ambientNodes = null;
  let ambientGain = null;

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, duration, type = "sine", gain = 0.08, when = 0) {
    if (muted) return;
    const c = ensureCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + duration);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(c.currentTime + when);
    osc.stop(c.currentTime + when + duration + 0.05);
  }

  function noiseBurst(duration = 0.15, gain = 0.04) {
    if (muted) return;
    const c = ensureCtx();
    const bufferSize = c.sampleRate * duration;
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const g = c.createGain();
    g.gain.value = gain;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 800;
    src.connect(filter);
    filter.connect(g);
    g.connect(c.destination);
    src.start();
  }

  return {
    isMuted() {
      return muted;
    },

    toggleMute() {
      muted = !muted;
      if (ambientGain) ambientGain.gain.value = muted ? 0 : 0.04;
      return muted;
    },

    unlock() {
      ensureCtx();
    },

    startAmbient() {
      if (ambientNodes || muted) return;
      const c = ensureCtx();
      ambientGain = c.createGain();
      ambientGain.gain.value = 0.04;
      ambientGain.connect(c.destination);

      const freqs = [55, 82.5, 110];
      ambientNodes = freqs.map((f) => {
        const osc = c.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f;
        const g = c.createGain();
        g.gain.value = 0.15;
        osc.connect(g);
        g.connect(ambientGain);
        osc.start();
        return osc;
      });

      // Slow LFO pulse
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.08;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 0.02;
      lfo.connect(lfoGain);
      lfoGain.connect(ambientGain.gain);
      lfo.start();
    },

    click() {
      tone(880, 0.06, "square", 0.05);
    },

    tick() {
      tone(1200, 0.04, "triangle", 0.04);
    },

    heartbeat() {
      tone(60, 0.12, "sine", 0.1);
      tone(90, 0.08, "sine", 0.06, 0.12);
    },

    alarm() {
      tone(440, 0.2, "sawtooth", 0.07);
      tone(330, 0.25, "sawtooth", 0.07, 0.15);
      noiseBurst(0.2, 0.05);
    },

    chime() {
      [523, 659, 784].forEach((f, i) => tone(f, 0.35, "sine", 0.06, i * 0.1));
    },

    glitch() {
      noiseBurst(0.3, 0.08);
      tone(200, 0.1, "sawtooth", 0.06);
      tone(150, 0.15, "square", 0.05, 0.08);
    },

    decryptTick() {
      tone(400 + Math.random() * 200, 0.05, "square", 0.03);
    },
  };
})();

window.AudioEngine = AudioEngine;
