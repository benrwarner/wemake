// Studio controller: wires Session (shared doc + presence), Peers (live
// audio/MIDI mesh) and Engine (local rendering), and holds local UI state.
import * as M from '../../../shared/model';
import type { Snapshot } from '../../../shared/model';
import { Session, type PeerInfo } from '../net/Session';
import { Peers, type PeerStats } from '../net/Peers';
import { Engine, bounce, type Take } from '../audio/Engine';
import { audioBufferToWav, download, encodeMidi, encodeWav } from '../audio/files';

export type BottomTab = 'editor' | 'track' | 'mixer';

const SETTINGS_KEY = 'wemake.settings';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'); } catch { return {}; }
}

export interface Toast { id: number; text: string; kind: 'info' | 'error' }

export class Studio {
  readonly session: Session;
  readonly peers: Peers;
  readonly engine: Engine;
  snap: Snapshot;
  version = 0;
  private subs = new Set<() => void>();
  private raf = 0;

  // local UI state
  selectedTrack: string | null = null;
  selectedClip: string | null = null;
  editorClip: string | null = null;
  bottom: BottomTab = 'track';
  ppb = 28; // pixels per beat
  snapDiv = 1; // grid in beats (0 = off)
  octave = 4;
  velocity = 0.8;
  uploads = new Map<string, string>(); // id -> label
  toasts: Toast[] = [];
  peerStats = new Map<string, PeerStats>();
  peerVolume = new Map<string, number>();
  midiInputs: string[] = [];
  inputDevice = '';
  jitterTarget = 0;
  unread = 0;
  private toastId = 0;

  constructor(readonly room: string, readonly name: string, readonly color: string, password = '') {
    const saved = loadSettings();
    this.session = new Session(room, name, color, password);
    this.engine = new Engine(room, this.session, {
      latencyHint: saved.latencyHint ?? 'interactive',
      roundTripMs: saved.roundTripMs ?? null,
      countIn: saved.countIn ?? true,
      monitor: saved.monitor ?? true,
    });
    this.inputDevice = saved.inputDevice ?? '';
    this.jitterTarget = saved.jitterTarget ?? 0;
    this.engine.authHeaders = () => ({ 'x-wemake-token': this.session.token });
    this.peers = new Peers(this.session, this.engine.liveTrack);
    this.session.on('room', (m) => {
      if (m.error) this.toast(m.error, 'error');
      else this.toast(m.locked ? `${m.by ?? 'Someone'} set a session password` : `${m.by ?? 'Someone'} removed the session password`);
    });
    this.peers.setJitterTarget(this.jitterTarget);
    this.snap = M.snapshot(this.session.doc);

    this.session.doc.on('update', () => this.schedule());
    this.session.on('peers', () => { this.applyMirror(); this.bump(); });
    this.session.on('status', () => this.bump());
    this.session.on('chat', (m) => { if (m.from !== this.session.myId) this.unread++; this.bump(); });
    this.session.on('welcome', () => this.session.setPresence({ tunedIn: this.tunedIn }));
    this.session.on('synced', () => {
      this.schedule();
      if (!this.selectedTrack) this.selectedTrack = this.snap.order[0] ?? null;
    });
    this.peers.on('stream', ({ id, stream }) => { this.engine.addPeer(id, stream); this.applyMirror(); });
    this.peers.on('stream-end', (id) => this.engine.removePeer(id));
    this.peers.on('midi', ({ ev }) => {
      if (!this.tunedIn) return; // live notes would be out of time with private playback
      if (ev.type === 'panic') return this.engine.panic();
      if (ev.note != null) this.engine.noteNow(ev.track, ev.note, ev.vel ?? 0.8, ev.type === 'on');
    });
    this.peers.on('stats', (s) => { this.peerStats = new Map(s); this.bump(); });
    let wasRecording = false;
    this.engine.on('change', () => {
      if (wasRecording !== this.engine.recording) { wasRecording = this.engine.recording; this.session.setPresence({ recording: wasRecording }); }
      this.bump();
    });
    this.engine.on('take', (t: Take) => this.handleTake(t));
    this.setupMidi();
    this.engine.setLive(true);
    this.peers.setLive(true);
  }

  // ---------------- subscription (React) ----------------
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  getVersion = () => this.version;
  bump() { this.version++; this.subs.forEach((f) => f()); }
  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.snap = M.snapshot(this.session.doc);
      this.engine.sync(this.snap);
      if (this.selectedTrack && !this.snap.tracks[this.selectedTrack]) this.selectedTrack = this.snap.order[0] ?? null;
      if (this.editorClip && !this.snap.clips[this.editorClip]) this.editorClip = null;
      if (this.selectedClip && !this.snap.clips[this.selectedClip]) this.selectedClip = null;
      this.bump();
    });
  }

  edit(fn: (doc: import('yjs').Doc) => void) { this.session.edit(fn); }
  get doc() { return this.session.doc; }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const t = { id: ++this.toastId, text, kind };
    this.toasts = [...this.toasts, t];
    this.bump();
    setTimeout(() => { this.toasts = this.toasts.filter((x) => x !== t); this.bump(); }, kind === 'error' ? 7000 : 3500);
  }

  saveSettings() {
    const s = this.engine.settings;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        latencyHint: s.latencyHint, roundTripMs: s.roundTripMs, countIn: s.countIn, monitor: s.monitor,
        inputDevice: this.inputDevice, jitterTarget: this.jitterTarget,
      }));
    } catch { /* storage unavailable */ }
  }

  // ---------------- selection ----------------
  selectTrack(id: string | null) { this.selectedTrack = id; this.bump(); }
  selectClip(id: string | null) {
    this.selectedClip = id;
    if (id) this.selectedTrack = this.snap.clips[id]?.trackId ?? this.selectedTrack;
    this.bump();
  }
  openEditor(clipId: string) {
    this.editorClip = clipId;
    this.selectClip(clipId);
    this.bottom = 'editor';
    this.session.setPresence({ editing: clipId });
    this.bump();
  }
  setBottom(tab: BottomTab) { this.bottom = tab; this.bump(); }
  setZoom(ppb: number) { this.ppb = Math.max(4, Math.min(240, ppb)); this.bump(); }

  // ---------------- transport ----------------
  /** Tuned in = follow the room's shared transport; tuned out = private playback. */
  tunedIn = true;
  /** Mirror the orchestrator's per-friend volumes while tuned in. */
  mirrorMix = true;
  private localT: M.Transport = { ...M.DEFAULT_TRANSPORT };

  get transport(): M.Transport { return this.tunedIn ? this.snap.transport : this.localT; }
  get playing() { return this.transport.playing; }
  /** Peer id (or null for you / nobody) currently driving shared playback. */
  get orchestrator(): { id: string; name: string } | null {
    const t = this.snap.transport;
    if (!t.by) return null;
    return { id: t.byId ?? '', name: t.byId === this.session.myId ? 'you' : t.by };
  }

  private setT(patch: Partial<M.Transport>) {
    const full = { by: this.name, byId: this.session.myId, ...patch };
    if (this.tunedIn) { this.edit((d) => M.setTransport(d, full)); return; }
    this.localT = { ...this.localT, ...full, seq: this.localT.seq + 1 };
    this.engine.setLocalTransport(this.localT);
    this.bump();
  }

  setTunedIn(on: boolean) {
    if (on === this.tunedIn) return;
    if (!on) this.localT = { ...M.DEFAULT_TRANSPORT, startBeat: Math.max(0, this.engine.position()) };
    this.tunedIn = on;
    this.engine.setFollow(on);
    this.session.setPresence({ tunedIn: on });
    this.applyMirror();
    this.toast(on ? 'Tuned in: you hear the shared playback' : 'Tuned out: private playback. Friends are muted, and your edits still sync');
    this.bump();
  }

  setMirrorMix(on: boolean) { this.mirrorMix = on; this.applyMirror(); this.bump(); }

  /** Hear what the orchestrator hears: copy their volume for each friend (except you). */
  private applyMirror() {
    const lead = this.orchestrator;
    const leader = lead && this.session.peers.get(lead.id);
    for (const id of this.session.peers.keys()) {
      const mirrored = this.tunedIn && this.mirrorMix && leader && id !== leader.id ? leader.state.mix?.[id] : undefined;
      this.engine.setPeerVolume(id, mirrored ?? this.peerVolume.get(id) ?? 0);
    }
  }

  play() {
    if (this.playing) return this.stop();
    this.engine.ctx.resume();
    this.setT(this.engine.playRequest(this.engine.cursor));
  }

  stop() {
    if (this.engine.recording) this.engine.stopRecording();
    if (!this.playing) { this.seek(0); return; }
    this.setT({ playing: false, startBeat: Math.max(0, this.engine.position()), noLoop: false });
  }

  seek(beat: number) {
    beat = Math.max(0, beat);
    if (this.playing) {
      this.setT({ ...this.engine.playRequest(beat), noLoop: this.transport.noLoop });
    } else {
      this.engine.cursor = beat;
      this.session.setPresence({ cursor: beat });
      this.bump();
    }
  }

  async record() {
    const e = this.engine;
    if (e.recording) {
      await e.stopRecording();
      this.session.setPresence({ recording: false });
      return;
    }
    if (!e.canRecord()) {
      this.toast('Arm a track first: press R on an audio track (with an input open) or an instrument track.', 'error');
      return;
    }
    e.ctx.resume();
    if (this.playing) {
      e.startRecording(e.position(), true);
    } else {
      const from = e.cursor;
      this.setT(e.playRequest(from, { record: true }));
      e.startRecording(from, false);
    }
    this.session.setPresence({ recording: true });
  }

  // ---------------- tracks ----------------
  addTrack(kind: 'audio' | 'instrument', instrument = 'synth') {
    let id = '';
    this.edit((d) => { id = M.addTrack(d, { kind, instrument: kind === 'instrument' ? { type: instrument, params: {} } : undefined }); });
    this.selectedTrack = id;
    this.bottom = 'track';
    this.bump();
    return id;
  }

  /** Arm a track for recording/playing. One audio + one instrument track per person. */
  async arm(trackId: string) {
    const t = this.snap.tracks[trackId];
    if (!t) return;
    const e = this.engine;
    if (t.kind === 'audio') {
      if (e.armedAudio === trackId) { e.setArmed(null, 'audio'); }
      else {
        if (!e.hasInput) {
          try { await e.openInput(this.inputDevice || undefined); }
          catch (err) { this.toast(`Could not open audio input: ${(err as Error).message}`, 'error'); return; }
        }
        e.setArmed(trackId, 'audio');
      }
    } else {
      e.setArmed(e.armedInstrument === trackId ? null : trackId, 'instrument');
    }
    this.session.setPresence({ track: e.armedAudio ?? e.armedInstrument ?? undefined, armed: !!(e.armedAudio || e.armedInstrument) });
  }

  // ---------------- notes ----------------
  get playTrack() {
    const sel = this.selectedTrack && this.snap.tracks[this.selectedTrack];
    if (this.engine.armedInstrument) return this.engine.armedInstrument;
    return sel && sel.kind === 'instrument' ? sel.id : null;
  }

  noteInput(note: number, vel: number, on: boolean, trackId = this.playTrack) {
    if (!trackId) return;
    this.engine.ctx.resume();
    this.engine.playLocal(trackId, note, vel, on);
    this.peers.sendMidi({ track: trackId, type: on ? 'on' : 'off', note, vel });
  }

  panic() { this.engine.panic(); this.peers.sendMidi({ track: '', type: 'panic' }); }

  private async setupMidi() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
      const bind = () => {
        this.midiInputs = [];
        access.inputs.forEach((input) => {
          this.midiInputs.push(input.name ?? 'MIDI input');
          input.onmidimessage = (m) => {
            const [st, d1, d2] = m.data ?? [];
            const cmd = st & 0xf0;
            if (cmd === 0x90 && d2 > 0) this.noteInput(d1, d2 / 127, true);
            else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.noteInput(d1, 0, false);
          };
        });
        this.bump();
      };
      bind();
      access.onstatechange = bind;
    } catch { /* user declined or unsupported */ }
  }

  // ---------------- takes & media ----------------
  private async handleTake(t: Take) {
    const spb = 60 / this.snap.project.bpm;
    const track = this.snap.tracks[t.trackId];
    const n = Object.values(this.snap.clips).filter((c) => c.trackId === t.trackId).length + 1;
    if (t.kind === 'midi') {
      this.edit((d) => M.addClip(d, { trackId: t.trackId, kind: 'midi', name: `Take ${n}`, start: t.startBeat, length: t.length, notes: t.notes, by: this.name }));
      return;
    }
    const id = M.uid();
    const buf = new AudioBuffer({ length: t.channels[0].length, numberOfChannels: t.channels.length, sampleRate: t.sampleRate });
    t.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    this.engine.addBuffer(id, buf);
    const ok = await this.upload(id, encodeWav(t.channels, t.sampleRate, 24), `${track?.name ?? 'Take'} take`);
    if (!ok) return;
    this.edit((d) => M.addClip(d, {
      trackId: t.trackId, kind: 'audio', name: `${track?.name ?? 'Audio'} ${n}`, start: t.startBeat,
      length: buf.duration / spb, audioId: id, by: this.name,
    }));
  }

  private async upload(id: string, data: ArrayBuffer, label: string) {
    this.uploads.set(id, label);
    this.bump();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`/api/audio/${this.room}/${id}`, { method: 'PUT', body: data, headers: { 'content-type': 'audio/wav', 'x-wemake-token': this.session.token } });
          if (!res.ok) throw new Error(`upload failed (${res.status})`);
          return true;
        } catch (err) {
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    } catch (err) {
      this.toast(`Could not save ${label}: ${(err as Error).message}`, 'error');
      return false;
    } finally {
      this.uploads.delete(id);
      this.bump();
    }
  }

  async importFile(file: File, trackId: string | null, beat: number) {
    const spb = 60 / this.snap.project.bpm;
    try {
      const buf = await this.engine.ctx.decodeAudioData(await file.arrayBuffer());
      if (!trackId || this.snap.tracks[trackId]?.kind !== 'audio') trackId = this.addTrack('audio');
      const id = M.uid();
      this.engine.addBuffer(id, buf);
      // normalise to WAV so every participant's browser can decode it
      if (!(await this.upload(id, audioBufferToWav(buf, 24), file.name))) return;
      const tid = trackId;
      this.edit((d) => M.addClip(d, { trackId: tid, kind: 'audio', name: file.name.replace(/\.[^.]+$/, ''), start: beat, length: buf.duration / spb, audioId: id, by: this.name }));
    } catch (err) {
      this.toast(`Could not import ${file.name}: ${(err as Error).message}`, 'error');
    }
  }

  // ---------------- export ----------------
  private safeName() { return (this.snap.project.name || 'wemake').replace(/[^\w-]+/g, '_'); }

  async exportMix(stems = false) {
    const missing = Object.values(this.snap.clips).filter((c) => c.audioId && !this.engine.buffers.has(c.audioId));
    await Promise.all(missing.map((c) => this.engine.loadAudio(c.audioId!)));
    const sr = this.engine.ctx.sampleRate;
    const targets = stems ? this.snap.order.map((id) => this.snap.tracks[id]) : [null];
    this.toast(stems ? 'Rendering stems…' : 'Rendering mixdown…');
    for (const t of targets) {
      const { buffer, warnings } = await bounce(this.snap, this.engine.buffers, { sampleRate: sr, onlyTrack: t?.id });
      warnings.forEach((w) => this.toast(w, 'error'));
      download(audioBufferToWav(buffer, 24), `${this.safeName()}${t ? `-${t.name.replace(/[^\w-]+/g, '_')}` : ''}.wav`, 'audio/wav');
    }
  }

  exportMidi() {
    const tracks = this.snap.order.map((id) => this.snap.tracks[id]).filter((t) => t.kind === 'instrument').map((t, i) => {
      const notes = Object.values(this.snap.clips).filter((c) => c.trackId === t.id && c.notes)
        .flatMap((c) => c.notes!.filter((n) => n.s < c.length).map((n) => ({ ...n, s: n.s + c.start, d: Math.min(n.d, c.length - n.s) })));
      return { name: t.name, channel: t.instrument?.type === 'drums' ? 9 : i % 9, notes };
    });
    download(encodeMidi(this.snap.project.bpm, this.snap.project.sig, tracks), `${this.safeName()}.mid`, 'audio/midi');
  }

  async toggleJamRecording() {
    if (!this.engine.jamRecording) { await this.engine.startJamRecording(); this.toast('Recording everything you hear…'); return; }
    const chans = await this.engine.stopJamRecording();
    if (chans?.[0].length) download(encodeWav(chans, this.engine.ctx.sampleRate, 24), `${this.safeName()}-jam-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.wav`, 'audio/wav');
  }

  // ---------------- meters (one analyser read per frame, shared by all meters) ----------------
  private meterCache: Record<string, number> = {};
  private meterAt = 0;
  meter = (id: string) => {
    const now = performance.now();
    if (now - this.meterAt > 12) { this.meterCache = this.engine.meters(); this.meterAt = now; }
    return this.meterCache[id];
  };

  // ---------------- people ----------------
  setPeerVolume(id: string, db: number) {
    this.peerVolume.set(id, db);
    this.session.setPresence({ mix: Object.fromEntries(this.peerVolume) });
    this.applyMirror();
    this.bump();
  }
  setJitterTarget(ms: number) { this.jitterTarget = ms; this.peers.setJitterTarget(ms); this.saveSettings(); this.bump(); }
  setLive(on: boolean) { this.engine.setLive(on); this.peers.setLive(on); this.session.setPresence({ live: on }); }

  peerList(): PeerInfo[] { return [...this.session.peers.values()]; }

  dispose() {
    this.peers.close();
    this.session.close();
    this.engine.dispose();
  }
}
