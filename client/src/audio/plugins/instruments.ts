// Built-in instruments. Voices are built from native nodes and scheduled with
// sample-accurate start/stop times so sequenced, live and remote notes all play
// tight.
import { type PluginDef, type PluginInstance, dbToGain, ramp } from './types';

const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
    noiseCache.set(ctx, b);
  }
  return b;
}

interface Voice { note: number; end: number; release(t: number): void; kill(t: number): void }

/** Polyphonic voice manager shared by the melodic instruments. */
function polyphony(ctx: BaseAudioContext, max: number, make: (note: number, vel: number, t: number) => Voice) {
  const voices: Voice[] = [];
  const held = new Map<number, Voice>();
  const prune = () => {
    const now = ctx.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end < now) voices.splice(i, 1);
  };
  const start = (note: number, vel: number, t: number) => {
    prune();
    if (voices.length >= max) voices.shift()!.kill(Math.max(t, ctx.currentTime)); // steal oldest
    const v = make(note, vel, t);
    voices.push(v);
    return v;
  };
  return {
    noteOn(note: number, vel: number, t: number) {
      held.get(note)?.release(t);
      held.set(note, start(note, vel, t));
    },
    noteOff(note: number, t: number) {
      const v = held.get(note);
      if (v) { v.release(t); held.delete(note); }
    },
    playNote(note: number, vel: number, t: number, dur: number) { start(note, vel, t).release(t + dur); },
    allNotesOff(t = ctx.currentTime) { for (const v of voices) v.kill(t); voices.length = 0; held.clear(); },
  };
}

function adsr(param: AudioParam, t: number, peak: number, a: number, d: number, s: number) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(peak * s, t + a, d / 4);
}
function releaseEnv(param: AudioParam, t: number, r: number) {
  // cancelAndHoldAtTime keeps the current envelope value (no click)
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues(t);
  param.setTargetAtTime(0, t, r / 4);
}

// ---------------------------------------------------------------- Subtractive synth
const WAVES: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
export const synth: PluginDef = {
  type: 'synth', name: 'Analog Synth', kind: 'instrument', category: 'Synth',
  description: 'Two-oscillator subtractive synth with filter envelope and glide-free poly voices',
  params: [
    { id: 'preset', name: 'Preset', min: 0, max: 4, default: 0, options: ['Lead', 'Bass', 'Pad', 'Pluck', 'Brass'] },
    { id: 'wave1', name: 'Osc 1', min: 0, max: 3, default: 0, options: ['Saw', 'Square', 'Triangle', 'Sine'] },
    { id: 'wave2', name: 'Osc 2', min: 0, max: 3, default: 1, options: ['Saw', 'Square', 'Triangle', 'Sine'] },
    { id: 'octave2', name: 'Osc 2 Oct', min: -2, max: 1, default: 0, step: 1 },
    { id: 'detune', name: 'Detune', min: 0, max: 50, default: 8, unit: 'ct' },
    { id: 'mix2', name: 'Osc 2 Mix', min: 0, max: 1, default: 0.5 },
    { id: 'cutoff', name: 'Cutoff', min: 60, max: 16000, default: 2400, unit: 'Hz', scale: 'log' },
    { id: 'reso', name: 'Resonance', min: 0.5, max: 20, default: 3, scale: 'log' },
    { id: 'envAmt', name: 'Filter Env', min: 0, max: 1, default: 0.5 },
    { id: 'attack', name: 'Attack', min: 0.001, max: 3, default: 0.005, unit: 's', scale: 'log' },
    { id: 'decay', name: 'Decay', min: 0.01, max: 3, default: 0.3, unit: 's', scale: 'log' },
    { id: 'sustain', name: 'Sustain', min: 0, max: 1, default: 0.6 },
    { id: 'release', name: 'Release', min: 0.01, max: 5, default: 0.25, unit: 's', scale: 'log' },
    { id: 'volume', name: 'Volume', min: -30, max: 6, default: -6, unit: 'dB' },
  ],
  presets: [
    { name: 'Lead', params: {} },
    { name: 'Bass', params: { wave1: 0, wave2: 1, octave2: -1, detune: 4, mix2: 0.6, cutoff: 700, reso: 4, envAmt: 0.6, attack: 0.002, decay: 0.25, sustain: 0.4, release: 0.08, volume: -3 } },
    { name: 'Pad', params: { wave1: 0, wave2: 0, detune: 18, mix2: 0.5, cutoff: 1800, reso: 1, envAmt: 0.2, attack: 0.8, decay: 1.5, sustain: 0.8, release: 1.8, volume: -10 } },
    { name: 'Pluck', params: { wave1: 1, wave2: 0, detune: 6, cutoff: 500, reso: 6, envAmt: 0.9, attack: 0.001, decay: 0.2, sustain: 0, release: 0.2, volume: -6 } },
    { name: 'Brass', params: { wave1: 0, wave2: 0, detune: 10, cutoff: 900, reso: 1.5, envAmt: 0.7, attack: 0.06, decay: 0.4, sustain: 0.7, release: 0.2, volume: -8 } },
  ],
  create({ ctx }, initial) {
    const out = ctx.createGain();
    const p: Record<string, number> = { ...initial };
    const poly = polyphony(ctx, 16, (note, vel, t) => {
      const o1 = new OscillatorNode(ctx, { type: WAVES[p.wave1 | 0], frequency: mtof(note) });
      const o2 = new OscillatorNode(ctx, { type: WAVES[p.wave2 | 0], frequency: mtof(note + 12 * p.octave2), detune: p.detune });
      const g1 = new GainNode(ctx, { gain: 1 - p.mix2 * 0.5 });
      const g2 = new GainNode(ctx, { gain: p.mix2 });
      const f = new BiquadFilterNode(ctx, { type: 'lowpass', Q: p.reso, frequency: p.cutoff });
      const vca = new GainNode(ctx, { gain: 0 });
      o1.connect(g1).connect(f); o2.connect(g2).connect(f); f.connect(vca).connect(out);
      const amp = 0.25 * (0.3 + 0.7 * vel);
      adsr(vca.gain, t, amp, p.attack, p.decay, p.sustain);
      const top = Math.min(18000, p.cutoff * (1 + p.envAmt * 8 * (0.5 + vel / 2)));
      f.frequency.setValueAtTime(p.cutoff, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(top, 30), t + p.attack + 0.001);
      f.frequency.setTargetAtTime(p.cutoff, t + p.attack, p.decay / 3);
      o1.start(t); o2.start(t);
      const v: Voice = {
        note, end: Infinity,
        release(rt) {
          rt = Math.max(rt, t);
          releaseEnv(vca.gain, rt, p.release);
          const stop = rt + p.release * 1.2 + 0.05;
          o1.stop(stop); o2.stop(stop); v.end = stop;
        },
        kill(kt) { releaseEnv(vca.gain, kt, 0.01); o1.stop(kt + 0.03); o2.stop(kt + 0.03); v.end = kt + 0.03; },
      };
      o1.onended = () => [o1, o2, g1, g2, f, vca].forEach((n) => n.disconnect());
      return v;
    });
    return {
      input: null, output: out, ...poly,
      setParam(id, v) { p[id] = v; if (id === 'volume') ramp(out.gain, dbToGain(v), ctx); },
      dispose() { poly.allNotesOff(); setTimeout(() => out.disconnect(), 100); },
    };
  },
};

// ---------------------------------------------------------------- FM electric piano
export const epiano: PluginDef = {
  type: 'epiano', name: 'Electric Piano', kind: 'instrument', category: 'Keys',
  params: [
    { id: 'bright', name: 'Brightness', min: 0, max: 1, default: 0.5 },
    { id: 'bell', name: 'Bell', min: 0, max: 1, default: 0.35 },
    { id: 'decay', name: 'Decay', min: 0.5, max: 8, default: 3, unit: 's', scale: 'log' },
    { id: 'release', name: 'Release', min: 0.02, max: 2, default: 0.3, unit: 's', scale: 'log' },
    { id: 'volume', name: 'Volume', min: -30, max: 6, default: -4, unit: 'dB' },
  ],
  create({ ctx }) {
    const out = ctx.createGain();
    const p: Record<string, number> = {};
    const poly = polyphony(ctx, 24, (note, vel, t) => {
      const f = mtof(note);
      const car = new OscillatorNode(ctx, { frequency: f });
      const mod = new OscillatorNode(ctx, { frequency: f });
      const tine = new OscillatorNode(ctx, { frequency: f * 14 });
      const modG = ctx.createGain();
      const tineG = ctx.createGain();
      const vca = new GainNode(ctx, { gain: 0 });
      mod.connect(modG).connect(car.frequency);
      tine.connect(tineG).connect(car.frequency);
      car.connect(vca).connect(out);
      const idx = f * (0.5 + p.bright * 3) * (0.4 + vel);
      modG.gain.setValueAtTime(idx, t);
      modG.gain.setTargetAtTime(idx * 0.15, t, 0.25);
      tineG.gain.setValueAtTime(f * p.bell * 2 * vel, t);
      tineG.gain.setTargetAtTime(0, t, 0.03);
      const amp = 0.22 * (0.25 + 0.75 * vel);
      // piano-like: decays even while held, faster for higher notes
      const dec = p.decay * Math.pow(0.5, (note - 60) / 24);
      vca.gain.setValueAtTime(0, t);
      vca.gain.linearRampToValueAtTime(amp, t + 0.003);
      vca.gain.setTargetAtTime(0, t + 0.003, dec / 3);
      [car, mod, tine].forEach((o) => o.start(t));
      const v: Voice = {
        note, end: t + dec * 3,
        release(rt) {
          rt = Math.max(rt, t);
          releaseEnv(vca.gain, rt, p.release);
          const stop = rt + p.release * 1.2 + 0.05;
          [car, mod, tine].forEach((o) => o.stop(stop)); v.end = stop;
        },
        kill(kt) { releaseEnv(vca.gain, kt, 0.01); [car, mod, tine].forEach((o) => o.stop(kt + 0.03)); v.end = kt + 0.03; },
      };
      car.onended = () => [car, mod, tine, modG, tineG, vca].forEach((n) => n.disconnect());
      return v;
    });
    return {
      input: null, output: out, ...poly,
      setParam(id, v) { p[id] = v; if (id === 'volume') ramp(out.gain, dbToGain(v), ctx); },
      dispose() { poly.allNotesOff(); setTimeout(() => out.disconnect(), 100); },
    };
  },
};

// ---------------------------------------------------------------- Drum machine
export const DRUM_NAMES: Record<number, string> = {
  36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 42: 'Closed Hat', 44: 'Pedal Hat', 46: 'Open Hat',
  41: 'Low Tom', 45: 'Mid Tom', 48: 'High Tom', 49: 'Crash', 51: 'Ride', 56: 'Cowbell',
};

export const drums: PluginDef = {
  type: 'drums', name: 'Drum Machine', kind: 'instrument', category: 'Drums',
  description: 'Synthesized analog-style kit. Kick C1 (36), Snare D1 (38), Clap 39, Hats 42/46…',
  params: [
    { id: 'tune', name: 'Tune', min: -12, max: 12, default: 0, unit: 'st', step: 1 },
    { id: 'decay', name: 'Decay', min: 0.3, max: 2, default: 1, scale: 'log' },
    { id: 'punch', name: 'Kick Punch', min: 0, max: 1, default: 0.6 },
    { id: 'snappy', name: 'Snare Snap', min: 0, max: 1, default: 0.6 },
    { id: 'volume', name: 'Volume', min: -30, max: 6, default: 0, unit: 'dB' },
  ],
  create({ ctx }) {
    const out = ctx.createGain();
    const p: Record<string, number> = {};
    const live = new Set<AudioScheduledSourceNode>();
    let openHat: GainNode | null = null;
    const track = (n: AudioScheduledSourceNode, nodes: AudioNode[]) => {
      live.add(n);
      n.onended = () => { live.delete(n); nodes.forEach((x) => x.disconnect()); };
    };
    const pitch = () => Math.pow(2, p.tune / 12);

    const noiseHit = (t: number, vel: number, type: BiquadFilterType, freq: number, q: number, dec: number, level = 1) => {
      const src = new AudioBufferSourceNode(ctx, { buffer: noise(ctx), loop: true });
      const f = new BiquadFilterNode(ctx, { type, frequency: freq * pitch(), Q: q });
      const g = new GainNode(ctx, { gain: 0 });
      src.connect(f).connect(g).connect(out);
      g.gain.setValueAtTime(level * vel, t);
      g.gain.setTargetAtTime(0, t + 0.001, (dec * p.decay) / 4);
      src.start(t, Math.random()); src.stop(t + dec * p.decay * 1.5 + 0.05);
      track(src, [src, f, g]);
      return { g, src };
    };
    const tone = (t: number, vel: number, f0: number, f1: number, sweep: number, dec: number, level = 1, type: OscillatorType = 'sine') => {
      const o = new OscillatorNode(ctx, { type, frequency: f0 * pitch() });
      const g = new GainNode(ctx, { gain: 0 });
      o.frequency.setValueAtTime(f0 * pitch(), t);
      o.frequency.exponentialRampToValueAtTime(f1 * pitch(), t + sweep);
      g.gain.setValueAtTime(level * vel, t);
      g.gain.setTargetAtTime(0, t + 0.002, (dec * p.decay) / 4);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + dec * p.decay * 1.5 + 0.05);
      track(o, [o, g]);
    };
    const metal = (t: number, vel: number, dec: number, hp: number) => {
      // six detuned square waves -> classic 808 cymbal recipe
      const g = new GainNode(ctx, { gain: 0 });
      const f = new BiquadFilterNode(ctx, { type: 'highpass', frequency: hp });
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 10000, Q: 0.6 });
      bp.connect(f).connect(g).connect(out);
      [205.3, 304.4, 369.6, 522.7, 540, 800].forEach((fr, i) => {
        const o = new OscillatorNode(ctx, { type: 'square', frequency: fr * 1.5 * pitch() });
        o.connect(bp); o.start(t); o.stop(t + dec * p.decay * 1.5 + 0.05);
        track(o, i === 0 ? [o, bp, f, g] : [o]);
      });
      g.gain.setValueAtTime(0.35 * vel, t);
      g.gain.setTargetAtTime(0, t + 0.001, (dec * p.decay) / 4);
      return g;
    };

    const hit = (note: number, vel: number, t: number) => {
      switch (note) {
        case 35: case 36:
          tone(t, vel, 160 + p.punch * 120, 42, 0.07 + p.punch * 0.03, 0.45, 1.1);
          noiseHit(t, vel * p.punch, 'highpass', 3000, 0.7, 0.008, 0.4);
          break;
        case 38: case 40:
          tone(t, vel, 330, 180, 0.03, 0.12, 0.55, 'triangle');
          noiseHit(t, vel, 'highpass', 1800, 0.8, 0.18, 0.35 + p.snappy * 0.45);
          break;
        case 37: tone(t, vel, 1700, 1600, 0.005, 0.02, 0.5, 'square'); noiseHit(t, vel, 'bandpass', 3500, 2, 0.02, 0.3); break;
        case 39:
          for (let i = 0; i < 3; i++) noiseHit(t + i * 0.011, vel, 'bandpass', 1200, 1.8, 0.012, 0.6);
          noiseHit(t + 0.033, vel, 'bandpass', 1200, 1.8, 0.22, 0.6);
          break;
        case 42: case 44:
          openHat?.gain.setTargetAtTime(0, t, 0.008); // choke
          metal(t, vel, note === 44 ? 0.06 : 0.045, 7000);
          break;
        case 46: openHat = metal(t, vel, 0.4, 6500); break;
        case 41: case 43: tone(t, vel, 140, 80, 0.1, 0.5, 0.9); break;
        case 45: case 47: tone(t, vel, 200, 120, 0.1, 0.4, 0.9); break;
        case 48: case 50: tone(t, vel, 280, 170, 0.1, 0.35, 0.9); break;
        case 49: case 57: noiseHit(t, vel, 'highpass', 5000, 0.5, 1.4, 0.35); metal(t, vel * 0.6, 1.2, 5000); break;
        case 51: case 59: metal(t, vel * 0.7, 0.8, 4000); break;
        case 56: tone(t, vel, 800, 800, 0.01, 0.12, 0.35, 'square'); tone(t, vel, 540, 540, 0.01, 0.12, 0.35, 'square'); break;
        default: tone(t, vel, mtof(note), mtof(note) * 0.6, 0.1, 0.3, 0.7);
      }
    };
    return {
      input: null, output: out,
      noteOn: (n, v, t) => hit(n, v, Math.max(t, ctx.currentTime)),
      noteOff: () => {},
      playNote: (n, v, t) => hit(n, v, t),
      allNotesOff(t = ctx.currentTime) { for (const n of live) { try { n.stop(t + 0.01); } catch { /* not started */ } } },
      setParam(id, v) { p[id] = v; if (id === 'volume') ramp(out.gain, dbToGain(v), ctx); },
      dispose() { setTimeout(() => out.disconnect(), 100); },
    } satisfies PluginInstance;
  },
};

export const INSTRUMENTS = [synth, epiano, drums];
