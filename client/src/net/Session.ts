// Connection to the room server: Yjs document sync, presence, chat, signaling
// and an NTP-style clock so all participants share one musical timeline.
import * as Y from 'yjs';

export type Listener<T> = (v: T) => void;
export class Emitter<E extends Record<string, unknown>> {
  private ls = new Map<keyof E, Set<Listener<any>>>();
  on<K extends keyof E>(k: K, f: Listener<E[K]>) {
    if (!this.ls.has(k)) this.ls.set(k, new Set());
    this.ls.get(k)!.add(f);
    return () => { this.ls.get(k)?.delete(f); };
  }
  emit<K extends keyof E>(k: K, v: E[K]) { this.ls.get(k)?.forEach((f) => f(v)); }
}

export interface PresenceState {
  track?: string; // track id currently played/monitored
  armed?: boolean;
  recording?: boolean;
  live?: boolean; // broadcasting live input
  editing?: string; // clip id open in the editor
  cursor?: number; // playhead beat when stopped
  latency?: number; // ms, local round trip
  tunedIn?: boolean; // following the shared transport
  mix?: Record<string, number>; // this person's volume (dB) for each friend's live audio
}

/** Remote pointer, in musical coordinates so it lands correctly at any zoom/scroll. */
export type CursorPos =
  | { v: 'a'; b: number; t: string; y: number } // arrangement: beat, track id, fraction down the row
  | { v: 'p'; clip: string; b: number; p: number }; // piano roll: clip, beat in clip, pitch

export interface PeerInfo { id: string; name: string; color: string; state: PresenceState }
export interface ChatMsg { from: string; name: string; color: string; text: string; ts: number }

type Events = {
  status: 'connecting' | 'online' | 'offline';
  peers: Map<string, PeerInfo>;
  'peer-join': PeerInfo;
  'peer-leave': string;
  signal: { from: string; data: any };
  midi: { from: string; ev: any };
  chat: ChatMsg;
  welcome: string;
  synced: void;
};

export class Session extends Emitter<Events> {
  readonly doc = new Y.Doc();
  readonly undo: Y.UndoManager;
  myId = '';
  peers = new Map<string, PeerInfo>();
  chatLog: ChatMsg[] = [];
  /** Latest pointer of each peer (read every frame by the cursor overlays; no React churn). */
  cursors = new Map<string, { c: CursorPos | null; at: number }>();
  private cursorTimer?: ReturnType<typeof setTimeout>;
  private pendingCursor: CursorPos | null | undefined;
  private lastCursorSent = 0;
  synced = false;
  rtt = 0;
  private ws?: WebSocket;
  private offset = 0; // serverMs - performance.now()
  private samples: { rtt: number; offset: number }[] = [];
  private pingTimer?: ReturnType<typeof setInterval>;
  private retry = 0;
  private closed = false;
  private presence: PresenceState = {};

  constructor(readonly room: string, public name: string, public color: string) {
    super();
    this.undo = new Y.UndoManager(
      [this.doc.getMap('tracks'), this.doc.getMap('clips'), this.doc.getArray('order'), this.doc.getMap('project')],
      { trackedOrigins: new Set([null, 'local']), captureTimeout: 400 },
    );
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(update);
    });
    this.connect();
  }

  /** Current time on the shared server clock (ms). */
  serverNow() { return performance.now() + this.offset; }
  /** Convert a server timestamp to the local performance.now() timebase. */
  toLocal(serverMs: number) { return serverMs - this.offset; }

  private connect() {
    this.emit('status', 'connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(this.room)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let first = true;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', name: this.name, color: this.color }));
      this.samples = [];
      for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 120);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 2500);
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        Y.applyUpdate(this.doc, new Uint8Array(e.data), 'remote');
        if (first) {
          first = false;
          // push anything we have that the server lacks (offline edits / reconnect)
          ws.send(Y.encodeStateAsUpdate(this.doc));
          this.synced = true;
          this.emit('synced', undefined);
        }
        return;
      }
      this.handle(JSON.parse(e.data));
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.peers.clear();
      this.emit('peers', this.peers);
      this.emit('status', 'offline');
      if (this.closed) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private handle(msg: any) {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        this.peers = new Map(msg.peers.map((p: PeerInfo) => [p.id, { ...p, state: p.state ?? {} }]));
        this.emit('status', 'online');
        this.emit('welcome', msg.id);
        this.emit('peers', this.peers);
        this.send({ t: 'presence', state: this.presence });
        break;
      case 'pong': {
        const t1 = performance.now();
        const rtt = t1 - msg.c;
        this.samples.push({ rtt, offset: msg.s - (msg.c + rtt / 2) });
        if (this.samples.length > 12) this.samples.shift();
        // the lowest-RTT samples have the least asymmetric queuing delay
        const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
        const off = best.reduce((s, x) => s + x.offset, 0) / best.length;
        // slew small corrections, jump on first sync or large error
        this.offset = this.samples.length <= 1 || Math.abs(off - this.offset) > 50 ? off : this.offset + (off - this.offset) * 0.3;
        this.rtt = best[0].rtt;
        break;
      }
      case 'peer-join':
        this.peers.set(msg.peer.id, { ...msg.peer, state: msg.peer.state ?? {} });
        this.emit('peer-join', msg.peer);
        this.emit('peers', this.peers);
        break;
      case 'peer-leave':
        this.peers.delete(msg.id);
        this.cursors.delete(msg.id);
        this.emit('peer-leave', msg.id);
        this.emit('peers', this.peers);
        break;
      case 'presence': {
        const p = this.peers.get(msg.id);
        if (p) { p.state = msg.state && typeof msg.state === 'object' ? msg.state : {}; this.emit('peers', this.peers); }
        break;
      }
      case 'cursor': this.cursors.set(msg.id, { c: msg.c, at: performance.now() }); break;
      case 'signal': this.emit('signal', { from: msg.from, data: msg.data }); break;
      case 'midi': this.emit('midi', { from: msg.from, ev: msg.ev }); break;
      case 'chat':
        this.chatLog.push(msg);
        if (this.chatLog.length > 200) this.chatLog.shift();
        this.emit('chat', msg);
        break;
    }
  }

  private ping() { this.send({ t: 'ping', c: performance.now() }); }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  signal(to: string, data: unknown) { this.send({ t: 'signal', to, data }); }
  relayMidi(to: string, ev: unknown) { this.send({ t: 'midi', to, ev }); }
  chat(text: string) {
    const msg: ChatMsg = { from: this.myId, name: this.name, color: this.color, text, ts: Date.now() };
    this.chatLog.push(msg);
    this.emit('chat', msg);
    this.send({ t: 'chat', text });
  }
  /** Share your pointer, throttled to ~25 Hz with a trailing update. */
  sendCursor(c: CursorPos | null) {
    this.pendingCursor = c;
    if (this.cursorTimer) return;
    const wait = Math.max(0, 40 - (performance.now() - this.lastCursorSent));
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      this.lastCursorSent = performance.now();
      this.send({ t: 'cursor', c: this.pendingCursor ?? null });
    }, wait);
  }
  setPresence(patch: PresenceState) {
    this.presence = { ...this.presence, ...patch };
    this.send({ t: 'presence', state: this.presence });
  }
  /** Apply a local edit (tracked by undo). */
  edit(fn: (doc: Y.Doc) => void) { this.doc.transact(() => fn(this.doc), 'local'); }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
