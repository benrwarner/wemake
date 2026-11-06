// WeMake audio engine.
//
// Every participant renders the arrangement locally (sample-accurate, full
// quality) against a shared server clock, so playback is identical for
// everyone. Only *live* input travels over the network: mic/guitar as Opus
// audio, instruments as MIDI events.
import type { Clip, FxSlot, Note, Snapshot, Track, Transport } from '../../../shared/model';
import { instantiate, isTrusted, onTrustChange } from './plugins/registry';
import { type PluginHost, type PluginInstance, dbToGain } from './plugins/types';
import { computePeaks, type Peaks } from './files';
import recorderUrl from './worklets/recorder.js?url';

const LOOKAHEAD = 0.15; // seconds scheduled ahead of the audio clock
const TICK_MS = 20;

export interface AudioTake { kind: 'audio'; trackId: string; channels: Float32Array[]; sampleRate: number; startBeat: number }
export interface MidiTake { kind: 'midi'; trackId: string; notes: Note[]; startBeat: number; length: number }
export type Take = AudioTake | MidiTake;

export interface EngineSettings {
  latencyHint: AudioContextLatencyCategory | number;
  roundTripMs: number | null; // calibrated input+output latency
  metronome: boolean;
  countIn: boolean;
  monitor: boolean; // hear your own live input through the FX
}

// ------------------------------------------------------------------ FX chain
interface SlotState { type: string; inst?: PluginInstance; applied: Record<string, number>; error?: string; gen: number }

class Chain {
  readonly input: GainNode;
  readonly output: GainNode;
  private slots = new Map<string, SlotState>();
  private order: FxSlot[] = [];
  private wiredSig = '';
  private disposed = false;

  constructor(private host: PluginHost, private onChange: () => void) {
    this.input = host.ctx.createGain();
    this.output = host.ctx.createGain();
    this.input.connect(this.output);
  }

  instance(fxId: string) { return this.slots.get(fxId); }

  sync(fx: FxSlot[], trustVersion: number) {
    this.order = fx;
    const ids = new Set(fx.map((f) => f.id));
    for (const [id, s] of this.slots) if (!ids.has(id)) { s.inst?.dispose(); this.slots.delete(id); }
    for (const f of fx) {
      let s = this.slots.get(f.id);
      const retry = s?.error === 'untrusted' && s.gen !== trustVersion && isTrusted(f.type);
      if (!s || s.type !== f.type || retry) {
        s?.inst?.dispose();
        s = { type: f.type, applied: {}, gen: trustVersion };
        this.slots.set(f.id, s);
        if (!isTrusted(f.type)) { s.error = 'untrusted'; continue; }
        const state = s;
        instantiate(f.type, this.host, f.params).then(
          ({ inst, applied }) => {
            if (this.disposed || this.slots.get(f.id) !== state) return inst.dispose();
            state.inst = inst;
            state.applied = applied;
            this.rewire();
            this.applyParams();
            this.onChange();
          },
          (err) => { state.error = String(err?.message ?? err); this.onChange(); },
        );
      }
    }
    this.applyParams();
    this.rewire();
  }

  private applyParams() {
    for (const f of this.order) {
      const s = this.slots.get(f.id);
      if (!s?.inst) continue;
      for (const [k, v] of Object.entries(f.params)) if (s.applied[k] !== v) { s.inst.setParam(k, v); s.applied[k] = v; }
    }
  }

  private rewire() {
    const live = this.order.filter((f) => !f.bypass && this.slots.get(f.id)?.inst?.input);
    const sig = live.map((f) => f.id).join('|');
    if (sig === this.wiredSig) return;
    this.wiredSig = sig;
    this.input.disconnect();
    for (const s of this.slots.values()) s.inst?.output.disconnect();
    let prev: AudioNode = this.input;
    for (const f of live) {
      const inst = this.slots.get(f.id)!.inst!;
      prev.connect(inst.input!);
      prev = inst.output;
    }
    prev.connect(this.output);
  }

  dispose() {
    this.disposed = true;
    for (const s of this.slots.values()) s.inst?.dispose();
    this.slots.clear();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ------------------------------------------------------------------ track strip
interface InstrumentState { type: string; inst?: PluginInstance; applied: Record<string, number>; error?: string }

class Strip {
  readonly input: GainNode;
  readonly chain: Chain;
  readonly fader: GainNode;
  readonly panner: StereoPannerNode;
  readonly meter: AnalyserNode;
  instrument?: InstrumentState;
  live?: { chain: Chain; fader: GainNode; panner: StereoPannerNode; monitor: GainNode };
  track: Track;

  constructor(private engine: Engine, track: Track) {
    const ctx = engine.ctx;
    this.track = track;
    this.input = ctx.createGain();
    this.chain = new Chain(engine.host, engine.notify);
    this.fader = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.meter = new AnalyserNode(ctx, { fftSize: 512, smoothingTimeConstant: 0 });
    this.input.connect(this.chain.input);
    this.chain.output.connect(this.fader).connect(this.panner);
    this.panner.connect(engine.masterIn);
    this.panner.connect(this.meter);
  }

  sync(t: Track, audible: boolean, trustVersion: number) {
    this.track = t;
    const ctx = this.engine.ctx;
    const g = audible ? dbToGain(t.volume) : 0;
    this.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
    this.panner.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
    this.chain.sync(t.fx, trustVersion);
    if (this.live) {
      this.live.chain.sync(t.fx, trustVersion);
      this.live.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
      this.live.panner.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
    }
    if (t.kind === 'instrument' && t.instrument) this.syncInstrument(t.instrument);
  }

  private syncInstrument(spec: { type: string; params: Record<string, number> }) {
    let s = this.instrument;
    if (!s || s.type !== spec.type) {
      s?.inst?.dispose();
      s = { type: spec.type, applied: {} };
      this.instrument = s;
      const state = s;
      if (!isTrusted(spec.type)) { s.error = 'untrusted'; return; }
      instantiate(spec.type, this.engine.host, spec.params).then(({ inst, applied }) => {
        if (this.instrument !== state) return inst.dispose();
        state.inst = inst;
        state.applied = applied;
        inst.output.connect(this.input);
        this.engine.notify();
      }, (err) => { state.error = String(err?.message ?? err); this.engine.notify(); });
      return;
    }
    if (!s.inst) return;
    // switching preset re-seeds every value from the preset
    for (const [k, v] of Object.entries(spec.params)) if (s.applied[k] !== v) { s.inst.setParam(k, v); s.applied[k] = v; }
  }

  /** Live monitoring path: input -> own FX instances -> fader -> master + network send. */
  setLive(input: AudioNode | null, monitor: boolean, trustVersion: number) {
    const ctx = this.engine.ctx;
    if (!input) {
      if (this.live) { this.live.chain.dispose(); [this.live.fader, this.live.panner, this.live.monitor].forEach((n) => n.disconnect()); this.live = undefined; }
      return;
    }
    if (!this.live) {
      const chain = new Chain(this.engine.host, this.engine.notify);
      const fader = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const mon = ctx.createGain();
      input.connect(chain.input);
      chain.output.connect(fader).connect(panner);
      panner.connect(mon).connect(this.engine.masterIn);
      panner.connect(this.meter);
      panner.connect(this.engine.liveSend);
      this.live = { chain, fader, panner, monitor: mon };
      chain.sync(this.track.fx, trustVersion);
      fader.gain.value = this.fader.gain.value;
      panner.pan.value = this.track.pan;
    }
    this.live.monitor.gain.setTargetAtTime(monitor ? 1 : 0, ctx.currentTime, 0.01);
  }

  dispose() {
    this.instrument?.inst?.dispose();
    this.setLive(null, false, 0);
    this.chain.dispose();
    [this.input, this.fader, this.panner, this.meter].forEach((n) => n.disconnect());
  }
}

// ------------------------------------------------------------------ engine
interface Anchor { time: number; beat: number; spb: number }
interface Peer { src: MediaStreamAudioSourceNode; gain: GainNode; meter: AnalyserNode; el: HTMLAudioElement }

type EngineEvent = 'change' | 'take' | 'wrap';

export class Engine {
  readonly ctx: AudioContext;
  readonly host: PluginHost;
  readonly masterIn: GainNode;
  readonly masterFader: GainNode;
  readonly masterMeter: AnalyserNode;
  readonly liveSend: GainNode;
  readonly liveTrack: MediaStreamTrack;
  private limiter: DynamicsCompressorNode;
  private metro: GainNode;
  private strips = new Map<string, Strip>();
  private peers = new Map<string, Peer>();
  private snap?: Snapshot;
  private trustVersion = 0;

  // transport
  playing = false;
  cursor = 0;
  private anchors: Anchor[] = [];
  private cur: Anchor = { time: 0, beat: 0, spb: 0.6 };
  private noLoop = false;
  private lastSeq = -1;
  /** true: follow the room's shared transport. false: private playback ("tuned out"). */
  followShared = true;
  private peersMuted = false;
  private peerDb = new Map<string, number>();
  private started = new Set<string>();
  private active = new Map<string, Set<AudioBufferSourceNode>>();
  private timer: Worker | ReturnType<typeof setInterval> | null = null;
  private countInUntil = -Infinity;

  // input & recording
  private stream?: MediaStream;
  private inputSrc?: MediaStreamAudioSourceNode;
  readonly inputGain: GainNode;
  readonly inputMeter: AnalyserNode;
  private recorder?: AudioWorkletNode;
  private workletReady: Promise<void>;
  inputChannels = 1;
  armedAudio: string | null = null;
  armedInstrument: string | null = null;
  live = true;
  recording = false;
  private rec?: { chunks: Float32Array[][]; startFrame: number | null; fromBeat: number; punchIn: boolean; done?: (endFrame: number) => void; onStart?: () => void };
  private midiRec = new Map<number, { p: number; s: number; v: number }>();
  private midiNotes: Note[] = [];
  private jamRec?: { node: AudioWorkletNode; chunks: Float32Array[][] };

  // media
  readonly buffers = new Map<string, AudioBuffer>();
  readonly peaks = new Map<string, Peaks>();
  private loadingAudio = new Map<string, Promise<AudioBuffer | null>>();

  settings: EngineSettings;
  private listeners = new Map<EngineEvent, Set<(v: any) => void>>();
  private wamGroup?: Promise<string>;

  constructor(readonly room: string, private clock: { serverNow(): number; toLocal(ms: number): number }, settings: Partial<EngineSettings> = {}) {
    this.settings = { latencyHint: 'interactive', roundTripMs: null, metronome: false, countIn: true, monitor: true, ...settings };
    this.ctx = new AudioContext({ latencyHint: this.settings.latencyHint });
    const ctx = this.ctx;
    this.host = { ctx, bpm: () => this.snap?.project.bpm ?? 120, wamGroupId: () => this.wamHost() };
    this.masterIn = ctx.createGain();
    this.masterFader = ctx.createGain();
    // safety limiter so a feedback loop or hot plugin can never blow ears/speakers
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });
    this.masterMeter = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    this.masterIn.connect(this.masterFader).connect(this.limiter).connect(ctx.destination);
    this.limiter.connect(this.masterMeter);
    this.metro = ctx.createGain();
    this.metro.gain.value = 0.5;
    this.metro.connect(ctx.destination);
    this.liveSend = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.liveSend.connect(dest);
    this.liveTrack = dest.stream.getAudioTracks()[0];
    this.inputGain = ctx.createGain();
    this.inputMeter = new AnalyserNode(ctx, { fftSize: 512, smoothingTimeConstant: 0 });
    this.inputGain.connect(this.inputMeter);
    this.workletReady = ctx.audioWorklet.addModule(recorderUrl);
    onTrustChange(() => { this.trustVersion++; if (this.snap) this.sync(this.snap); });
    this.startTimer();
  }

  // ---------------- events ----------------
  on(ev: EngineEvent, f: (v: any) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(f);
    return () => { this.listeners.get(ev)?.delete(f); };
  }
  private emit(ev: EngineEvent, v?: unknown) { this.listeners.get(ev)?.forEach((f) => f(v)); }
  notify = () => this.emit('change');

  private wamHost() {
    this.wamGroup ??= import('@webaudiomodules/sdk').then(async ({ initializeWamHost }) => (await initializeWamHost(this.ctx))[0]);
    return this.wamGroup;
  }

  // ---------------- time ----------------
  /** The AudioContext time whose samples reach the speakers at performance time `perfMs`. */
  ctxTimeForPerf(perfMs: number) {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts?.contextTime && ts.performanceTime) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0) + (perfMs - performance.now()) / 1000;
  }
  ctxTimeForServer(serverMs: number) { return this.ctxTimeForPerf(this.clock.toLocal(serverMs)); }

  get latency() {
    const out = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return { output: out, roundTrip: this.settings.roundTripMs != null ? this.settings.roundTripMs / 1000 : out * 2 + 0.005 };
  }

  private beatAt(time: number) {
    let a = this.anchors[0] ?? this.cur;
    for (const x of this.anchors) if (x.time <= time) a = x; else break;
    return a.beat + (time - a.time) / a.spb;
  }

  /** Beat currently heard (for the playhead). */
  position() {
    if (!this.playing) return this.cursor;
    const t = this.ctxTimeForPerf(performance.now());
    if (this.anchors.length && t < this.anchors[0].time) return this.anchors[0].beat;
    return this.beatAt(t);
  }

  // ---------------- model sync ----------------
  sync(snap: Snapshot) {
    const prev = this.snap;
    this.snap = snap;
    const anySolo = Object.values(snap.tracks).some((t) => t.solo);
    for (const [id, s] of this.strips) if (!snap.tracks[id]) { s.dispose(); this.strips.delete(id); }
    for (const t of Object.values(snap.tracks)) {
      let s = this.strips.get(t.id);
      if (!s) { s = new Strip(this, t); this.strips.set(t.id, s); }
      s.sync(t, !t.mute && (!anySolo || t.solo), this.trustVersion);
    }
    if (this.armedAudio && !snap.tracks[this.armedAudio]) this.armedAudio = null;
    if (this.armedInstrument && !snap.tracks[this.armedInstrument]) this.armedInstrument = null;
    this.updateLivePath();
    this.masterFader.gain.setTargetAtTime(dbToGain(snap.project.master), this.ctx.currentTime, 0.01);
    // clips removed while sounding
    for (const [cid, srcs] of this.active) if (!snap.clips[cid]) { srcs.forEach((s) => { try { s.stop(); } catch { /* */ } }); this.active.delete(cid); }
    // preload audio
    for (const c of Object.values(snap.clips)) if (c.audioId && !this.buffers.has(c.audioId)) this.loadAudio(c.audioId);
    // tempo change while playing: re-anchor at the scheduling cursor
    if (this.playing && prev && prev.project.bpm !== snap.project.bpm) {
      this.cur = { ...this.cur, spb: 60 / snap.project.bpm };
      this.pushAnchor(this.cur);
    }
    if (this.followShared && snap.transport.seq !== this.lastSeq) { this.lastSeq = snap.transport.seq; this.applyTransport(snap.transport); }
  }

  strip(id: string) { return this.strips.get(id); }

  // ---------------- transport ----------------
  private loopActive(beat: number) {
    const p = this.snap?.project;
    return !!p && p.loopOn && !this.noLoop && p.loopEnd > p.loopStart && beat < p.loopEnd;
  }

  /** Tune in to (or out of) the room's shared playback. */
  setFollow(on: boolean) {
    if (on === this.followShared) return;
    this.followShared = on;
    this.setPeersMuted(!on);
    if (this.recording) this.stopRecording();
    if (on) {
      this.lastSeq = -1;
      if (this.snap) { this.lastSeq = this.snap.transport.seq; this.applyTransport(this.snap.transport); }
    } else if (this.playing) {
      const here = this.position();
      this.stopPlayback();
      this.cursor = Math.max(0, here);
    }
    this.emit('change');
  }

  /** Drive playback privately while tuned out. */
  setLocalTransport(t: Transport) {
    if (!this.followShared) this.applyTransport(t);
  }

  private applyTransport(t: Transport) {
    if (!t.playing) {
      if (this.playing) this.stopPlayback();
      this.cursor = t.startBeat;
      if (this.recording) this.stopRecording();
      this.emit('change');
      return;
    }
    if (this.playing) this.stopPlayback();
    this.ctx.resume();
    this.noLoop = t.noLoop;
    const spb = 60 / (this.snap?.project.bpm ?? 120);
    const startAt = this.ctxTimeForServer(t.startServerMs);
    const earliest = this.ctx.currentTime + 0.04;
    let beat = t.startBeat, time = startAt;
    if (startAt < earliest) {
      // joined late (or slow device): jump in at the right musical position
      time = earliest;
      beat = this.wrap(t.startBeat, t.startBeat + (earliest - startAt) / spb);
    }
    this.cur = { time, beat, spb };
    this.anchors = [];
    this.pushAnchor(this.cur);
    this.started.clear();
    this.playing = true;
    this.tick();
    this.emit('change');
  }

  private wrap(from: number, beat: number) {
    const p = this.snap?.project;
    if (!p || !this.loopActive(from) || beat < p.loopEnd) return beat;
    const len = p.loopEnd - p.loopStart;
    return p.loopStart + ((beat - p.loopEnd) % len);
  }

  private pushAnchor(a: Anchor) {
    this.anchors.push({ ...a });
    if (this.anchors.length > 32) this.anchors.splice(0, this.anchors.length - 32);
  }

  private stopPlayback() {
    this.playing = false;
    const now = this.ctx.currentTime;
    for (const srcs of this.active.values()) srcs.forEach((s) => { try { s.stop(now + 0.01); } catch { /* */ } });
    this.active.clear();
    for (const s of this.strips.values()) s.instrument?.inst?.allNotesOff?.(now);
  }

  private startTimer() {
    // A worker timer keeps scheduling steady when the tab is in the background.
    try {
      const src = `let id; onmessage = (e) => { clearInterval(id); if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = () => this.tick();
      w.postMessage(TICK_MS);
      this.timer = w;
    } catch {
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  private tick() {
    if (!this.playing || !this.snap) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (this.cur.time < horizon && guard++ < 64) {
      const { beat: a, time: t0, spb } = this.cur;
      const p = this.snap.project;
      const looping = this.loopActive(a);
      let b = a + (horizon - t0) / spb;
      let wraps = false;
      if (looping && b >= p.loopEnd) { b = p.loopEnd; wraps = true; }
      this.scheduleRange(a, b, t0, spb, looping ? p.loopEnd : Infinity);
      this.cur = { time: t0 + (b - a) * spb, beat: b, spb };
      if (wraps) {
        const wrapTime = this.cur.time;
        this.cur = { time: wrapTime, beat: p.loopStart, spb };
        this.pushAnchor(this.cur);
        this.started.clear();
        this.emit('wrap', wrapTime);
        if (this.recording && this.rec?.punchIn && this.armedAudio) {
          // a punched-in take ends at the loop boundary
          const ms = (wrapTime + this.latency.roundTrip - this.ctx.currentTime) * 1000;
          setTimeout(() => this.recording && this.stopRecording(), Math.max(0, ms));
        }
      }
    }
  }

  private scheduleRange(a: number, b: number, t0: number, spb: number, cutAt: number) {
    const snap = this.snap!;
    const timeOf = (beat: number) => t0 + (beat - a) * spb;
    for (const c of Object.values(snap.clips)) {
      const strip = this.strips.get(c.trackId);
      if (!strip) continue;
      const end = c.start + c.length;
      if (c.start >= b || end <= a) continue;
      if (c.kind === 'midi') this.scheduleNotes(c, strip, a, b, timeOf, spb, cutAt);
      else this.scheduleAudio(c, strip, a, timeOf, spb, cutAt);
    }
    if (this.settings.metronome || a < this.countInUntil) {
      const sig = snap.project.sig;
      for (let beat = Math.ceil(a - 1e-9); beat < b; beat++) {
        if (!this.settings.metronome && beat >= this.countInUntil) break;
        this.click(timeOf(beat), ((beat % sig) + sig) % sig === 0);
      }
    }
  }

  private scheduleNotes(c: Clip, strip: Strip, a: number, b: number, timeOf: (x: number) => number, spb: number, cutAt: number) {
    const inst = strip.instrument?.inst;
    if (!inst || !c.notes) return;
    for (const n of c.notes) {
      if (n.s >= c.length || n.s < 0) continue;
      const abs = c.start + n.s;
      if (abs < a || abs >= b) continue;
      const dur = Math.max(0.01, Math.min(n.d, c.length - n.s, cutAt - abs)) * spb;
      const t = timeOf(abs);
      if (inst.playNote) inst.playNote(n.p, n.v, t, dur);
      else { inst.noteOn?.(n.p, n.v, t); inst.noteOff?.(n.p, t + dur); }
    }
  }

  private scheduleAudio(c: Clip, strip: Strip, a: number, timeOf: (x: number) => number, spb: number, cutAt: number) {
    if (this.started.has(c.id) || !c.audioId) return;
    const buf = this.buffers.get(c.audioId);
    if (!buf) return;
    this.started.add(c.id);
    const end = c.start + c.length;
    const sb = Math.max(c.start, a);
    const offset = c.offset + (sb - c.start) * spb;
    if (offset >= buf.duration) return;
    const dur = Math.min((Math.min(end, cutAt) - sb) * spb, buf.duration - offset);
    if (dur <= 0) return;
    const src = new AudioBufferSourceNode(this.ctx, { buffer: buf });
    const g = new GainNode(this.ctx, { gain: dbToGain(c.gain) });
    src.connect(g).connect(strip.input);
    const when = timeOf(sb);
    const late = Math.max(0, this.ctx.currentTime - when);
    src.start(when + late, offset + late, Math.max(0.001, dur - late));
    // 3 ms fades avoid clicks at clip edges
    g.gain.setValueAtTime(0, when + late);
    g.gain.linearRampToValueAtTime(dbToGain(c.gain), when + late + 0.003);
    g.gain.setValueAtTime(dbToGain(c.gain), when + late + Math.max(0.004, dur - late - 0.003));
    g.gain.linearRampToValueAtTime(0, when + dur);
    let set = this.active.get(c.id);
    if (!set) { set = new Set(); this.active.set(c.id, set); }
    set.add(src);
    src.onended = () => { set!.delete(src); src.disconnect(); g.disconnect(); };
  }

  private click(t: number, accent: boolean) {
    const o = new OscillatorNode(this.ctx, { type: 'square', frequency: accent ? 1760 : 1100 });
    const g = new GainNode(this.ctx, { gain: 0 });
    o.connect(g).connect(this.metro);
    g.gain.setValueAtTime(accent ? 0.5 : 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    o.start(t); o.stop(t + 0.05);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  /** Transport start parameters for "play from the cursor". */
  playRequest(fromBeat: number, opts: { record?: boolean } = {}) {
    const sig = this.snap?.project.sig ?? 4;
    const countIn = opts.record && this.settings.countIn ? sig : 0;
    this.countInUntil = countIn ? fromBeat : -Infinity;
    return { startBeat: fromBeat - countIn, startServerMs: this.clock.serverNow() + 120, noLoop: !!opts.record, playing: true };
  }

  // ---------------- audio loading ----------------
  loadAudio(audioId: string) {
    let p = this.loadingAudio.get(audioId);
    if (p) return p;
    p = (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const res = await fetch(`/api/audio/${this.room}/${audioId}`);
          if (res.status === 404) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; } // upload may be in flight
          if (!res.ok) throw new Error(String(res.status));
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.addBuffer(audioId, buf);
          return buf;
        } catch (err) {
          console.warn('audio load failed', audioId, err);
        }
      }
      this.loadingAudio.delete(audioId);
      return null;
    })();
    this.loadingAudio.set(audioId, p);
    return p;
  }

  addBuffer(audioId: string, buf: AudioBuffer) {
    this.buffers.set(audioId, buf);
    this.peaks.set(audioId, computePeaks(buf));
    this.loadingAudio.set(audioId, Promise.resolve(buf));
    this.emit('change');
  }

  // ---------------- input & live monitoring ----------------
  async openInput(deviceId?: string) {
    this.closeInput();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // music, not a phone call: no voice processing
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 },
        // @ts-expect-error non-standard but honoured by Chromium
        latency: 0,
      },
    });
    this.stream = stream;
    const settings = stream.getAudioTracks()[0]?.getSettings();
    this.inputChannels = Math.min(2, settings?.channelCount ?? 1);
    this.inputSrc = this.ctx.createMediaStreamSource(stream);
    this.inputSrc.connect(this.inputGain);
    await this.workletReady;
    this.recorder = new AudioWorkletNode(this.ctx, 'wemake-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: this.inputChannels, channelCountMode: 'explicit',
      processorOptions: { channels: this.inputChannels },
    });
    this.inputGain.connect(this.recorder);
    const sink = new GainNode(this.ctx, { gain: 0 });
    this.recorder.connect(sink).connect(this.ctx.destination); // keep the worklet pulled
    this.recorder.port.onmessage = (e) => this.onRecorderMessage(e.data);
    this.updateLivePath();
    this.emit('change');
    return settings;
  }

  closeInput() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.inputSrc?.disconnect();
    this.recorder?.disconnect();
    this.stream = undefined; this.inputSrc = undefined; this.recorder = undefined;
    this.updateLivePath();
  }

  get hasInput() { return !!this.stream; }

  setArmed(trackId: string | null, kind: 'audio' | 'instrument') {
    if (kind === 'audio') this.armedAudio = trackId; else this.armedInstrument = trackId;
    this.updateLivePath();
    this.emit('change');
  }

  setMonitor(on: boolean) { this.settings.monitor = on; this.updateLivePath(); this.emit('change'); }
  setLive(on: boolean) { this.live = on; this.liveSend.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); this.emit('change'); }

  private updateLivePath() {
    for (const [id, s] of this.strips) {
      const want = id === this.armedAudio && this.stream && s.track.kind === 'audio';
      s.setLive(want ? this.inputGain : null, this.settings.monitor, this.trustVersion);
    }
  }

  // ---------------- live notes ----------------
  /** Play a note on a track right now (local keyboard/MIDI or a remote friend). */
  noteNow(trackId: string, note: number, vel: number, on: boolean) {
    const inst = this.strips.get(trackId)?.instrument?.inst;
    if (!inst) return;
    const t = this.ctx.currentTime;
    if (on) inst.noteOn?.(note, vel, t); else inst.noteOff?.(note, t);
  }

  /** Local performance: plays, and captures into the take while recording. */
  playLocal(trackId: string, note: number, vel: number, on: boolean) {
    this.noteNow(trackId, note, vel, on);
    if (!this.recording || trackId !== this.armedInstrument || !this.playing) return;
    const beat = this.beatAt(this.ctxTimeForPerf(performance.now()));
    if (on) this.midiRec.set(note, { p: note, s: beat, v: vel });
    else {
      const n = this.midiRec.get(note);
      if (n) { this.midiNotes.push({ ...n, d: Math.max(0.03, beat - n.s) }); this.midiRec.delete(note); }
    }
  }

  panic() {
    for (const s of this.strips.values()) s.instrument?.inst?.allNotesOff?.();
  }

  // ---------------- recording ----------------
  canRecord() { return !!(this.armedInstrument || (this.armedAudio && this.recorder)); }

  /** Begin capturing. Call right after the transport has been (re)started or while it plays. */
  startRecording(fromBeat: number, punchIn: boolean) {
    this.recording = true;
    this.midiRec.clear();
    this.midiNotes = [];
    if (this.armedAudio && this.recorder) {
      this.rec = { chunks: [], startFrame: null, fromBeat, punchIn };
      this.recorder.port.postMessage('start');
    }
    this.emit('change');
  }

  private onRecorderMessage(m: any) {
    const rec = this.rec;
    if (!rec) return;
    if (m.type === 'start') { rec.startFrame = m.frame; rec.onStart?.(); }
    else if (m.type === 'chunk') rec.chunks.push(m.data);
    else if (m.type === 'done') rec.done?.(m.endFrame);
  }

  async stopRecording(): Promise<Take[]> {
    if (!this.recording) return [];
    this.recording = false;
    const takes: Take[] = [];
    const sig = this.snap?.project.sig ?? 4;
    // MIDI take
    if (this.armedInstrument) {
      const endBeat = this.playing ? this.beatAt(this.ctxTimeForPerf(performance.now())) : this.cursor;
      for (const n of this.midiRec.values()) this.midiNotes.push({ ...n, d: Math.max(0.05, endBeat - n.s) });
      this.midiRec.clear();
      const notes = this.midiNotes.filter((n) => n.s >= 0);
      if (notes.length) {
        const start = Math.floor(Math.min(...notes.map((n) => n.s)) / sig) * sig;
        const end = Math.max(...notes.map((n) => n.s + n.d));
        const length = Math.max(sig, Math.ceil((end - start) / sig) * sig);
        takes.push({ kind: 'midi', trackId: this.armedInstrument, startBeat: start, length, notes: notes.map((n) => ({ ...n, s: n.s - start })) });
      }
    }
    // Audio take
    const rec = this.rec;
    if (rec && this.recorder && this.armedAudio) {
      const trackId = this.armedAudio;
      await new Promise<void>((resolve) => { rec.done = () => resolve(); this.recorder!.port.postMessage('stop'); });
      this.rec = undefined;
      if (rec.startFrame != null && rec.chunks.length) {
        const nch = rec.chunks[0].length;
        const total = rec.chunks.reduce((s, c) => s + c[0].length, 0);
        const channels = Array.from({ length: nch }, (_, ch) => {
          const out = new Float32Array(total);
          let o = 0;
          for (const c of rec.chunks) { out.set(c[ch], o); o += c[ch].length; }
          return out;
        });
        const sr = this.ctx.sampleRate;
        // what the performer heard when this sample was captured
        const musical = rec.startFrame / sr - this.latency.roundTrip;
        let startBeat = this.beatAt(musical);
        let skip = 0;
        if (startBeat < rec.fromBeat) {
          // drop count-in / pre-roll
          const spb = this.cur.spb;
          skip = Math.round(((rec.fromBeat - startBeat) * spb) * sr);
          startBeat = rec.fromBeat;
        }
        if (skip < total - sr * 0.05) {
          takes.push({ kind: 'audio', trackId, channels: channels.map((c) => c.slice(skip)), sampleRate: sr, startBeat });
        }
      }
    }
    this.countInUntil = -Infinity;
    this.emit('change');
    for (const t of takes) this.emit('take', t);
    return takes;
  }

  /** Measure true input+output latency by playing clicks and finding them in the input. */
  async calibrate(): Promise<number> {
    if (!this.recorder) throw new Error('Open an audio input first');
    if (this.recording) throw new Error('Stop recording first');
    const sr = this.ctx.sampleRate;
    const chunks: Float32Array[][] = [];
    let startFrame = 0;
    const done = new Promise<void>((resolve) => {
      this.rec = { chunks, startFrame: null, fromBeat: -Infinity, punchIn: false, done: () => resolve() };
    });
    const started = new Promise<void>((r) => { this.rec!.onStart = r; });
    this.recorder.port.postMessage('start');
    await started;
    startFrame = this.rec!.startFrame!;
    const t0 = this.ctx.currentTime + 0.3;
    const clicks = [0, 0.45, 0.9, 1.35, 1.8].map((x) => t0 + x);
    for (const t of clicks) {
      const o = new OscillatorNode(this.ctx, { type: 'square', frequency: 1000 });
      const g = new GainNode(this.ctx, { gain: 0.8 });
      o.connect(g).connect(this.ctx.destination);
      o.start(t); o.stop(t + 0.006);
    }
    await new Promise((r) => setTimeout(r, (clicks[clicks.length - 1] - this.ctx.currentTime + 0.5) * 1000));
    this.recorder.port.postMessage('stop');
    await done;
    this.rec = undefined;
    const total = chunks.reduce((s, c) => s + c[0].length, 0);
    const data = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { data.set(c[0], o); o += c[0].length; }
    const delays: number[] = [];
    for (const t of clicks) {
      const from = Math.round((t - startFrame / sr) * sr);
      const to = Math.min(total, from + Math.round(0.4 * sr));
      if (from < 0 || from >= total) continue;
      let max = 0;
      for (let i = from; i < to; i++) max = Math.max(max, Math.abs(data[i]));
      if (max < 0.01) continue;
      for (let i = from; i < to; i++) if (Math.abs(data[i]) > max * 0.4) { delays.push((i - from) / sr); break; }
    }
    if (delays.length < 3) throw new Error("Couldn't hear the test clicks. Turn your speakers up, or loop an output back into your input, and try again.");
    delays.sort((x, y) => x - y);
    const ms = delays[Math.floor(delays.length / 2)] * 1000;
    this.settings.roundTripMs = Math.round(ms * 10) / 10;
    this.emit('change');
    return this.settings.roundTripMs;
  }

  // ---------------- jam recorder (everything you hear) ----------------
  async startJamRecording() {
    await this.workletReady;
    const node = new AudioWorkletNode(this.ctx, 'wemake-recorder', {
      channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [1], processorOptions: { channels: 2 },
    });
    const chunks: Float32Array[][] = [];
    node.port.onmessage = (e) => { if (e.data.type === 'chunk') chunks.push(e.data.data); };
    this.limiter.connect(node);
    const sink = new GainNode(this.ctx, { gain: 0 });
    node.connect(sink).connect(this.ctx.destination);
    node.port.postMessage('start');
    this.jamRec = { node, chunks };
    this.emit('change');
  }
  get jamRecording() { return !!this.jamRec; }
  async stopJamRecording() {
    const jr = this.jamRec;
    if (!jr) return null;
    await new Promise<void>((resolve) => {
      const prev = jr.node.port.onmessage;
      jr.node.port.onmessage = (e) => { prev?.call(jr.node.port, e); if (e.data.type === 'done') resolve(); };
      jr.node.port.postMessage('stop');
    });
    jr.node.disconnect();
    this.jamRec = undefined;
    this.emit('change');
    const total = jr.chunks.reduce((s, c) => s + c[0].length, 0);
    return [0, 1].map((ch) => {
      const out = new Float32Array(total);
      let o = 0;
      for (const c of jr.chunks) { out.set(c[ch], o); o += c[ch].length; }
      return out;
    });
  }

  // ---------------- remote peers ----------------
  addPeer(id: string, stream: MediaStream) {
    this.removePeer(id);
    // Chromium only pulls remote WebRTC audio into Web Audio if an element also consumes it.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const meter = new AnalyserNode(this.ctx, { fftSize: 512, smoothingTimeConstant: 0 });
    src.connect(gain).connect(this.masterIn);
    gain.connect(meter);
    this.peers.set(id, { src, gain, meter, el });
    this.setPeerVolume(id, this.peerDb.get(id) ?? 0);
    this.emit('change');
  }
  removePeer(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    p.src.disconnect(); p.gain.disconnect(); p.el.srcObject = null;
    this.peers.delete(id);
    this.emit('change');
  }
  setPeerVolume(id: string, db: number) {
    this.peerDb.set(id, db);
    const p = this.peers.get(id);
    if (p) p.gain.gain.setTargetAtTime(this.peersMuted ? 0 : dbToGain(db), this.ctx.currentTime, 0.01);
  }
  /** Silence friends' live audio (used while tuned out: it would be out of time with private playback). */
  setPeersMuted(m: boolean) {
    this.peersMuted = m;
    for (const id of this.peers.keys()) this.setPeerVolume(id, this.peerDb.get(id) ?? 0);
  }

  // ---------------- meters ----------------
  private buf = new Float32Array(1024);
  private peak(a: AnalyserNode) {
    const n = a.fftSize;
    const b = this.buf.length >= n ? this.buf.subarray(0, n) : (this.buf = new Float32Array(n));
    a.getFloatTimeDomainData(b);
    let m = 0;
    for (let i = 0; i < n; i++) { const v = Math.abs(b[i]); if (v > m) m = v; }
    return m;
  }
  meters() {
    const out: Record<string, number> = { master: this.peak(this.masterMeter) };
    if (this.stream) out.input = this.peak(this.inputMeter);
    for (const [id, s] of this.strips) out[id] = this.peak(s.meter);
    for (const [id, p] of this.peers) out[`peer:${id}`] = this.peak(p.meter);
    return out;
  }

  pluginError(trackId: string, fxId: string) { return this.strips.get(trackId)?.chain.instance(fxId)?.error; }
  pluginInstance(trackId: string, fxId: string) { return this.strips.get(trackId)?.chain.instance(fxId)?.inst; }

  dispose() {
    this.stopPlayback();
    if (this.timer instanceof Worker) this.timer.terminate(); else if (this.timer) clearInterval(this.timer);
    this.closeInput();
    this.ctx.close();
  }
}

// ------------------------------------------------------------------ offline bounce
export async function bounce(snap: Snapshot, buffers: Map<string, AudioBuffer>, opts: { sampleRate: number; from?: number; to?: number; onlyTrack?: string }) {
  const spb = 60 / snap.project.bpm;
  const clips = Object.values(snap.clips).filter((c) => snap.tracks[c.trackId]);
  const songEnd = Math.max(snap.project.sig * 4, ...clips.map((c) => c.start + c.length));
  const from = opts.from ?? 0;
  const to = opts.to ?? songEnd;
  const tail = 2.5;
  const length = Math.ceil(((to - from) * spb + tail) * opts.sampleRate);
  const ctx = new OfflineAudioContext(2, length, opts.sampleRate);
  const host: PluginHost = { ctx, bpm: () => snap.project.bpm };
  const master = new GainNode(ctx, { gain: dbToGain(snap.project.master) });
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });
  master.connect(limiter).connect(ctx.destination);
  const warnings: string[] = [];
  const anySolo = Object.values(snap.tracks).some((t) => t.solo);

  for (const t of Object.values(snap.tracks)) {
    if (opts.onlyTrack ? t.id !== opts.onlyTrack : t.mute || (anySolo && !t.solo)) continue;
    const input = ctx.createGain();
    let prev: AudioNode = input;
    for (const f of t.fx) {
      if (f.bypass) continue;
      try {
        const { inst } = await instantiate(f.type, host, f.params);
        if (inst.input) { prev.connect(inst.input); prev = inst.output; }
      } catch (e) { warnings.push(`${t.name}: skipped ${f.type} (${(e as Error).message})`); }
    }
    const fader = new GainNode(ctx, { gain: dbToGain(t.volume) });
    const pan = new StereoPannerNode(ctx, { pan: t.pan });
    prev.connect(fader).connect(pan).connect(master);
    let inst: PluginInstance | undefined;
    if (t.kind === 'instrument' && t.instrument) {
      try { inst = (await instantiate(t.instrument.type, host, t.instrument.params)).inst; inst.output.connect(input); }
      catch (e) { warnings.push(`${t.name}: instrument unavailable (${(e as Error).message})`); }
    }
    for (const c of clips) {
      if (c.trackId !== t.id) continue;
      const cs = Math.max(c.start, from), ce = Math.min(c.start + c.length, to);
      if (ce <= cs) continue;
      if (c.kind === 'audio' && c.audioId) {
        const buf = buffers.get(c.audioId);
        if (!buf) { warnings.push(`${t.name}: audio not loaded for "${c.name}"`); continue; }
        const src = new AudioBufferSourceNode(ctx, { buffer: buf });
        const g = new GainNode(ctx, { gain: dbToGain(c.gain) });
        src.connect(g).connect(input);
        const off = c.offset + (cs - c.start) * spb;
        if (off < buf.duration) src.start((cs - from) * spb, off, Math.min((ce - cs) * spb, buf.duration - off));
      } else if (c.kind === 'midi' && inst && c.notes) {
        for (const n of c.notes) {
          const abs = c.start + n.s;
          if (n.s >= c.length || abs < from || abs >= to) continue;
          const dur = Math.min(n.d, c.length - n.s, to - abs) * spb;
          const time = (abs - from) * spb;
          if (inst.playNote) inst.playNote(n.p, n.v, time, dur);
          else { inst.noteOn?.(n.p, n.v, time); inst.noteOff?.(n.p, time + dur); }
        }
      }
    }
  }
  const rendered = await ctx.startRendering();
  return { buffer: rendered, warnings };
}
