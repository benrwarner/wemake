// Built-in effects. All are pure Web Audio graphs (no worklets) so they run with
// zero added latency and work identically in realtime and offline bounce.
import { type PluginDef, type PluginInstance, dbToGain, ramp } from './types';

/** Common dry/wet wrapper. */
function wetDry(ctx: BaseAudioContext) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  const setMix = (m: number) => {
    // equal-power crossfade keeps perceived loudness constant
    ramp(dry.gain, Math.cos((m * Math.PI) / 2), ctx);
    ramp(wet.gain, Math.sin((m * Math.PI) / 2), ctx);
  };
  return { input, output, dry, wet, setMix };
}

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- EQ
export const eq: PluginDef = {
  type: 'eq', name: 'Channel EQ', kind: 'fx', category: 'EQ & Filter',
  description: '4-band EQ with low cut',
  params: [
    { id: 'lowcut', name: 'Low Cut', min: 20, max: 600, default: 30, scale: 'log', unit: 'Hz' },
    { id: 'low', name: 'Low', min: -18, max: 18, default: 0, unit: 'dB', step: 0.5 },
    { id: 'lowFreq', name: 'Low Freq', min: 40, max: 500, default: 110, scale: 'log', unit: 'Hz' },
    { id: 'mid', name: 'Mid', min: -18, max: 18, default: 0, unit: 'dB', step: 0.5 },
    { id: 'midFreq', name: 'Mid Freq', min: 200, max: 8000, default: 1200, scale: 'log', unit: 'Hz' },
    { id: 'midQ', name: 'Mid Q', min: 0.2, max: 8, default: 0.9, scale: 'log' },
    { id: 'high', name: 'High', min: -18, max: 18, default: 0, unit: 'dB', step: 0.5 },
    { id: 'highFreq', name: 'High Freq', min: 2000, max: 16000, default: 8000, scale: 'log', unit: 'Hz' },
  ],
  create({ ctx }) {
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', Q: 0.707 });
    const lo = new BiquadFilterNode(ctx, { type: 'lowshelf' });
    const mid = new BiquadFilterNode(ctx, { type: 'peaking' });
    const hi = new BiquadFilterNode(ctx, { type: 'highshelf' });
    hp.connect(lo).connect(mid).connect(hi);
    const map: Record<string, AudioParam> = {
      lowcut: hp.frequency, low: lo.gain, lowFreq: lo.frequency, mid: mid.gain, midFreq: mid.frequency,
      midQ: mid.Q, high: hi.gain, highFreq: hi.frequency,
    };
    return {
      input: hp, output: hi,
      setParam: (id, v) => map[id] && ramp(map[id], v, ctx),
      dispose: () => [hp, lo, mid, hi].forEach((n) => n.disconnect()),
    };
  },
};

// ---------------------------------------------------------------- Compressor
export const compressor: PluginDef = {
  type: 'compressor', name: 'Compressor', kind: 'fx', category: 'Dynamics',
  params: [
    { id: 'threshold', name: 'Threshold', min: -60, max: 0, default: -20, unit: 'dB', step: 0.5 },
    { id: 'ratio', name: 'Ratio', min: 1, max: 20, default: 4, step: 0.1, scale: 'log' },
    { id: 'attack', name: 'Attack', min: 0.1, max: 200, default: 8, unit: 'ms', scale: 'log' },
    { id: 'release', name: 'Release', min: 10, max: 1000, default: 150, unit: 'ms', scale: 'log' },
    { id: 'knee', name: 'Knee', min: 0, max: 30, default: 6, unit: 'dB' },
    { id: 'makeup', name: 'Makeup', min: 0, max: 24, default: 4, unit: 'dB', step: 0.5 },
  ],
  create({ ctx }) {
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    comp.connect(makeup);
    return {
      input: comp, output: makeup,
      setParam(id, v) {
        if (id === 'threshold') ramp(comp.threshold, v, ctx);
        else if (id === 'ratio') ramp(comp.ratio, v, ctx);
        else if (id === 'attack') ramp(comp.attack, v / 1000, ctx);
        else if (id === 'release') ramp(comp.release, v / 1000, ctx);
        else if (id === 'knee') ramp(comp.knee, v, ctx);
        else if (id === 'makeup') ramp(makeup.gain, dbToGain(v), ctx);
      },
      dispose: () => { comp.disconnect(); makeup.disconnect(); },
    };
  },
};

// ---------------------------------------------------------------- Reverb
function makeImpulse(ctx: BaseAudioContext, seconds: number, damping: number) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const rnd = seededRandom(1234 + ch * 77);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // exponential decay, progressively darker tail (frequency-dependent damping)
      const k = 0.15 + (1 - damping) * 0.85 * (1 - t);
      lp += k * ((rnd() * 2 - 1) - lp);
      data[i] = lp * Math.pow(1 - t, 2.2) * (i < rate * 0.004 ? i / (rate * 0.004) : 1);
    }
  }
  return buf;
}

export const reverb: PluginDef = {
  type: 'reverb', name: 'Space Reverb', kind: 'fx', category: 'Reverb & Delay',
  params: [
    { id: 'size', name: 'Size', min: 0.2, max: 8, default: 2.2, unit: 's', scale: 'log' },
    { id: 'damping', name: 'Damping', min: 0, max: 1, default: 0.5 },
    { id: 'predelay', name: 'Pre-delay', min: 0, max: 200, default: 20, unit: 'ms' },
    { id: 'lowcut', name: 'Low Cut', min: 20, max: 1000, default: 200, unit: 'Hz', scale: 'log' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.3 },
  ],
  create({ ctx }, values) {
    const w = wetDry(ctx);
    const pre = new DelayNode(ctx, { maxDelayTime: 0.25 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 200 });
    const conv = ctx.createConvolver();
    w.input.connect(pre).connect(hp).connect(conv).connect(w.wet);
    let size = values.size ?? 2.2, damping = values.damping ?? 0.5;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => { conv.buffer = makeImpulse(ctx, size, damping); };
    rebuild();
    const later = () => { clearTimeout(timer); timer = setTimeout(rebuild, 120); };
    return {
      input: w.input, output: w.output,
      setParam(id, v) {
        if (id === 'mix') w.setMix(v);
        else if (id === 'predelay') ramp(pre.delayTime, v / 1000, ctx);
        else if (id === 'lowcut') ramp(hp.frequency, v, ctx);
        else if (id === 'size' && v !== size) { size = v; later(); }
        else if (id === 'damping' && v !== damping) { damping = v; later(); }
      },
      dispose() { clearTimeout(timer); [w.input, w.output, w.dry, w.wet, pre, hp, conv].forEach((n) => n.disconnect()); },
    };
  },
};

// ---------------------------------------------------------------- Delay
const DIVS = [0, 1, 0.5, 0.75, 0.25, 1 / 3]; // beats
export const delay: PluginDef = {
  type: 'delay', name: 'Tape Delay', kind: 'fx', category: 'Reverb & Delay',
  params: [
    { id: 'sync', name: 'Sync', min: 0, max: 5, default: 3, options: ['Free', '1/4', '1/8', '1/8 dotted', '1/16', '1/8 triplet'] },
    { id: 'time', name: 'Time', min: 10, max: 2000, default: 350, unit: 'ms', scale: 'log' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 0.95, default: 0.35 },
    { id: 'tone', name: 'Tone', min: 500, max: 12000, default: 3500, unit: 'Hz', scale: 'log' },
    { id: 'pingpong', name: 'Ping-pong', min: 0, max: 1, default: 1, options: ['Off', 'On'] },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.25 },
  ],
  create({ ctx, bpm }, values) {
    const w = wetDry(ctx);
    const dl = new DelayNode(ctx, { maxDelayTime: 4 });
    const dr = new DelayNode(ctx, { maxDelayTime: 4 });
    const fb = ctx.createGain();
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass' });
    const merger = ctx.createChannelMerger(2);
    const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
    const straight = ctx.createGain();
    // ping-pong: L -> R -> L ...
    w.input.connect(mono).connect(dl);
    dl.connect(tone).connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    const pp = ctx.createGain();
    merger.connect(pp).connect(w.wet);
    dl.connect(straight).connect(w.wet);
    const v = { sync: 3, time: 350, ...values };
    const applyTime = () => {
      const beats = DIVS[v.sync | 0] ?? 0;
      const sec = beats ? (beats * 60) / bpm() : v.time / 1000;
      // ping-pong splits the round trip across the two taps
      ramp(dl.delayTime, Math.min(sec, 3.9), ctx, 0.05);
      ramp(dr.delayTime, Math.min(sec, 3.9), ctx, 0.05);
    };
    return {
      input: w.input, output: w.output,
      setParam(id, val) {
        (v as Record<string, number>)[id] = val;
        if (id === 'mix') w.setMix(val);
        else if (id === 'feedback') ramp(fb.gain, val, ctx);
        else if (id === 'tone') ramp(tone.frequency, val, ctx);
        else if (id === 'pingpong') { ramp(pp.gain, val ? 1 : 0, ctx); ramp(straight.gain, val ? 0 : 1, ctx); }
        else applyTime();
      },
      dispose: () => [w.input, w.output, w.dry, w.wet, dl, dr, fb, tone, merger, mono, straight, pp].forEach((n) => n.disconnect()),
    };
  },
};

// ---------------------------------------------------------------- Amp
function driveCurve(drive: number) {
  const n = 4096, curve = new Float32Array(n), k = 1 + drive * 40;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // asymmetric soft clip -> even harmonics like a tube stage
    curve[i] = Math.tanh(k * x + 0.1 * drive) / Math.tanh(k) - Math.tanh(0.1 * drive) / Math.tanh(k);
  }
  return curve;
}

export const amp: PluginDef = {
  type: 'amp', name: 'Amp & Cab', kind: 'fx', category: 'Distortion',
  description: 'Tube-style drive with a speaker cabinet simulation',
  params: [
    { id: 'drive', name: 'Drive', min: 0, max: 1, default: 0.4 },
    { id: 'bass', name: 'Bass', min: -12, max: 12, default: 2, unit: 'dB' },
    { id: 'middle', name: 'Middle', min: -12, max: 12, default: 0, unit: 'dB' },
    { id: 'treble', name: 'Treble', min: -12, max: 12, default: 1, unit: 'dB' },
    { id: 'cab', name: 'Cabinet', min: 0, max: 2, default: 1, options: ['Off', '1x12 Open', '4x12 Closed'] },
    { id: 'level', name: 'Level', min: -24, max: 12, default: -6, unit: 'dB' },
  ],
  create({ ctx }) {
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 90 });
    const pre = ctx.createGain();
    const shaper = new WaveShaperNode(ctx, { oversample: '4x' });
    const bass = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 120 });
    const mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 750, Q: 0.8 });
    const treb = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3200 });
    const cab1 = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.9 });
    const cab2 = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2500, Q: 1.5 });
    const level = ctx.createGain();
    hp.connect(pre).connect(shaper).connect(bass).connect(mid).connect(treb).connect(cab1).connect(cab2).connect(level);
    return {
      input: hp, output: level,
      setParam(id, v) {
        if (id === 'drive') { shaper.curve = driveCurve(v); ramp(pre.gain, 1 + v * 3, ctx); }
        else if (id === 'bass') ramp(bass.gain, v, ctx);
        else if (id === 'middle') ramp(mid.gain, v, ctx);
        else if (id === 'treble') ramp(treb.gain, v, ctx);
        else if (id === 'level') ramp(level.gain, dbToGain(v), ctx);
        else if (id === 'cab') {
          const c = v | 0;
          ramp(cab1.frequency, c === 0 ? 20000 : c === 1 ? 6500 : 4200, ctx);
          ramp(cab2.gain, c === 0 ? 0 : c === 1 ? 3 : 5, ctx);
        }
      },
      dispose: () => [hp, pre, shaper, bass, mid, treb, cab1, cab2, level].forEach((n) => n.disconnect()),
    };
  },
};

// ---------------------------------------------------------------- Modulation helpers
function lfo(ctx: BaseAudioContext, type: OscillatorType = 'sine') {
  const osc = new OscillatorNode(ctx, { type, frequency: 1 });
  const depth = ctx.createGain();
  osc.connect(depth);
  osc.start();
  return { osc, depth };
}

export const chorus: PluginDef = {
  type: 'chorus', name: 'Chorus', kind: 'fx', category: 'Modulation',
  params: [
    { id: 'rate', name: 'Rate', min: 0.05, max: 8, default: 0.8, unit: 'Hz', scale: 'log' },
    { id: 'depth', name: 'Depth', min: 0, max: 1, default: 0.5 },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.45 },
  ],
  create({ ctx }) {
    const w = wetDry(ctx);
    const merger = ctx.createChannelMerger(2);
    const nodes: AudioNode[] = [merger];
    const voices = [0, 1].map((ch) => {
      const d = new DelayNode(ctx, { delayTime: 0.012 + ch * 0.004, maxDelayTime: 0.05 });
      const m = lfo(ctx);
      // the two voices run at slightly different rates so they never line up
      m.depth.connect(d.delayTime);
      w.input.connect(d);
      d.connect(merger, 0, ch);
      nodes.push(d, m.osc, m.depth);
      return { d, m, ch };
    });
    merger.connect(w.wet);
    return {
      input: w.input, output: w.output,
      setParam(id, v) {
        if (id === 'mix') w.setMix(v);
        else if (id === 'rate') voices.forEach(({ m, ch }) => ramp(m.osc.frequency, v * (1 + ch * 0.13), ctx));
        else if (id === 'depth') voices.forEach(({ m }) => ramp(m.depth.gain, v * 0.006, ctx));
      },
      dispose() { voices.forEach(({ m }) => m.osc.stop()); [...nodes, w.input, w.output, w.dry, w.wet].forEach((n) => n.disconnect()); },
    };
  },
};

export const phaser: PluginDef = {
  type: 'phaser', name: 'Phaser', kind: 'fx', category: 'Modulation',
  params: [
    { id: 'rate', name: 'Rate', min: 0.05, max: 6, default: 0.4, unit: 'Hz', scale: 'log' },
    { id: 'depth', name: 'Depth', min: 0, max: 1, default: 0.7 },
    { id: 'feedback', name: 'Feedback', min: 0, max: 0.9, default: 0.4 },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5 },
  ],
  create({ ctx }) {
    const w = wetDry(ctx);
    const stages = Array.from({ length: 6 }, () => new BiquadFilterNode(ctx, { type: 'allpass', frequency: 800, Q: 0.5 }));
    const fb = ctx.createGain();
    const m = lfo(ctx);
    let prev: AudioNode = w.input;
    for (const s of stages) { prev.connect(s); prev = s; m.depth.connect(s.frequency); }
    prev.connect(w.wet);
    prev.connect(fb).connect(stages[0]);
    return {
      input: w.input, output: w.output,
      setParam(id, v) {
        if (id === 'mix') w.setMix(v);
        else if (id === 'rate') ramp(m.osc.frequency, v, ctx);
        else if (id === 'depth') ramp(m.depth.gain, v * 700, ctx);
        else if (id === 'feedback') ramp(fb.gain, v, ctx);
      },
      dispose() { m.osc.stop(); [...stages, fb, m.osc, m.depth, w.input, w.output, w.dry, w.wet].forEach((n) => n.disconnect()); },
    };
  },
};

export const tremolo: PluginDef = {
  type: 'tremolo', name: 'Tremolo', kind: 'fx', category: 'Modulation',
  params: [
    { id: 'rate', name: 'Rate', min: 0.5, max: 16, default: 5, unit: 'Hz', scale: 'log' },
    { id: 'depth', name: 'Depth', min: 0, max: 1, default: 0.5 },
    { id: 'shape', name: 'Shape', min: 0, max: 1, default: 0, options: ['Sine', 'Square'] },
  ],
  create({ ctx }) {
    const vca = ctx.createGain();
    const m = lfo(ctx);
    m.depth.connect(vca.gain);
    let depth = 0.5;
    return {
      input: vca, output: vca,
      setParam(id, v) {
        if (id === 'rate') ramp(m.osc.frequency, v, ctx);
        else if (id === 'shape') m.osc.type = v ? 'square' : 'sine';
        else if (id === 'depth') depth = v;
        if (id === 'depth' || id === 'shape') { ramp(m.depth.gain, depth / 2, ctx); ramp(vca.gain, 1 - depth / 2, ctx); }
      },
      dispose() { m.osc.stop(); [vca, m.osc, m.depth].forEach((n) => n.disconnect()); },
    };
  },
};

export const filter: PluginDef = {
  type: 'filter', name: 'Auto Filter', kind: 'fx', category: 'EQ & Filter',
  params: [
    { id: 'mode', name: 'Mode', min: 0, max: 2, default: 0, options: ['Low-pass', 'High-pass', 'Band-pass'] },
    { id: 'cutoff', name: 'Cutoff', min: 40, max: 18000, default: 2000, unit: 'Hz', scale: 'log' },
    { id: 'reso', name: 'Resonance', min: 0.5, max: 18, default: 2, scale: 'log' },
    { id: 'lfoRate', name: 'LFO Rate', min: 0.05, max: 10, default: 0.5, unit: 'Hz', scale: 'log' },
    { id: 'lfoAmt', name: 'LFO Amount', min: 0, max: 1, default: 0 },
  ],
  create({ ctx }) {
    const f = ctx.createBiquadFilter();
    const m = lfo(ctx);
    m.depth.connect(f.detune); // modulate in cents so sweeps are musical
    return {
      input: f, output: f,
      setParam(id, v) {
        if (id === 'mode') f.type = (['lowpass', 'highpass', 'bandpass'] as const)[v | 0];
        else if (id === 'cutoff') ramp(f.frequency, v, ctx);
        else if (id === 'reso') ramp(f.Q, v, ctx);
        else if (id === 'lfoRate') ramp(m.osc.frequency, v, ctx);
        else if (id === 'lfoAmt') ramp(m.depth.gain, v * 3600, ctx);
      },
      dispose() { m.osc.stop(); [f, m.osc, m.depth].forEach((n) => n.disconnect()); },
    };
  },
};

export const gain: PluginDef = {
  type: 'gain', name: 'Gain / Width', kind: 'fx', category: 'Utility',
  params: [
    { id: 'gain', name: 'Gain', min: -24, max: 24, default: 0, unit: 'dB', step: 0.5 },
    { id: 'phase', name: 'Phase', min: 0, max: 1, default: 0, options: ['Normal', 'Invert'] },
  ],
  create({ ctx }): PluginInstance {
    const g = ctx.createGain();
    let db = 0, inv = 0;
    const apply = () => ramp(g.gain, dbToGain(db) * (inv ? -1 : 1), ctx);
    return {
      input: g, output: g,
      setParam(id, v) { if (id === 'gain') db = v; else if (id === 'phase') inv = v; apply(); },
      dispose: () => g.disconnect(),
    };
  },
};

export const FX = [eq, compressor, reverb, delay, amp, chorus, phaser, tremolo, filter, gain];
