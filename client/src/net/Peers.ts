// Peer-to-peer live audio mesh (WebRTC).
//
// Latency choices:
//  * Opus is negotiated for music, not speech: stereo, 256 kbps, FEC on, DTX off,
//    10 ms packets; browser voice processing (AEC/NS/AGC) is disabled at capture.
//  * Receivers ask for the smallest jitter buffer the network allows
//    (RTCRtpReceiver.jitterBufferTarget, adjustable by the user).
//  * The audio transceiver is created up front and tracks are swapped with
//    replaceTrack(), so going live never triggers a renegotiation round trip.
//  * Instrument notes travel as tiny MIDI messages on an RTCDataChannel and are
//    synthesized by every receiver: no codec, no jitter buffer, full quality.
import { Emitter, type Session } from './Session';

export interface PeerStats { rtt: number; jitterBuffer: number; loss: number; bitrate: number; oneWay: number }

type Events = {
  stream: { id: string; stream: MediaStream };
  'stream-end': string;
  midi: { from: string; ev: MidiEvent };
  stats: Map<string, PeerStats>;
  state: { id: string; state: RTCPeerConnectionState };
};

export interface MidiEvent { track: string; type: 'on' | 'off' | 'panic'; note?: number; vel?: number }

interface Conn {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  sender?: RTCRtpSender;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  lastBytes?: { t: number; bytes: number };
}

function tuneOpus(sdp: string) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000;maxplaybackrate=48000;useinbandfec=1;usedtx=0;cbr=0;minptime=10';
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  sdp = re.test(sdp)
    ? sdp.replace(re, (_l, params: string) => {
      const kept = params.split(';').filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate|useinbandfec|usedtx|cbr|minptime)=/.test(p.trim()));
      return `a=fmtp:${pt} ${[...kept, extra].join(';')}`;
    })
    : sdp.replace(`a=rtpmap:${pt} opus/48000/2`, `a=rtpmap:${pt} opus/48000/2\r\na=fmtp:${pt} ${extra}`);
  // 10 ms packets halve packetisation delay vs. the 20 ms default
  if (!/a=ptime:/.test(sdp)) sdp = sdp.replace(/(m=audio[^\r\n]*\r\n)/, '$1a=ptime:10\r\n');
  return sdp;
}

export class Peers extends Emitter<Events> {
  private conns = new Map<string, Conn>();
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  private liveTrack: MediaStreamTrack | null = null;
  private jitterTarget = 0; // ms, 0 = as low as possible
  private statsTimer: ReturnType<typeof setInterval>;
  stats = new Map<string, PeerStats>();

  constructor(private session: Session, private liveSource: MediaStreamTrack) {
    super();
    fetch('/api/config').then((r) => r.json()).then((c) => { if (c.iceServers) this.iceServers = c.iceServers; }).catch(() => {});
    session.on('welcome', () => {
      // newcomer dials everyone already in the room
      for (const id of session.peers.keys()) this.connect(id, true);
    });
    session.on('peer-leave', (id) => this.drop(id));
    session.on('status', (s) => { if (s === 'offline') for (const id of [...this.conns.keys()]) this.drop(id); });
    session.on('signal', ({ from, data }) => this.onSignal(from, data));
    session.on('midi', ({ from, ev }) => { if (session.peers.has(from)) this.emit('midi', { from, ev }); });
    this.statsTimer = setInterval(() => this.pollStats(), 2000);
  }

  setLive(on: boolean) {
    this.liveTrack = on ? this.liveSource : null;
    for (const c of this.conns.values()) c.sender?.replaceTrack(this.liveTrack).catch(() => {});
  }

  setJitterTarget(ms: number) {
    this.jitterTarget = ms;
    for (const c of this.conns.values()) for (const r of c.pc.getReceivers()) this.tuneReceiver(r);
  }

  private tuneReceiver(r: RTCRtpReceiver) {
    const rx = r as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
    try { if ('jitterBufferTarget' in rx) rx.jitterBufferTarget = this.jitterTarget; } catch { /* unsupported */ }
    try { if ('playoutDelayHint' in rx) rx.playoutDelayHint = this.jitterTarget / 1000; } catch { /* unsupported */ }
  }

  sendMidi(ev: MidiEvent) {
    const data = JSON.stringify(ev);
    for (const [id, c] of this.conns) {
      if (c.dc?.readyState === 'open') c.dc.send(data);
      else this.session.relayMidi(id, ev); // fall back to the server while the P2P link comes up
    }
    for (const id of this.session.peers.keys()) if (!this.conns.has(id)) this.session.relayMidi(id, ev);
  }

  private connect(id: string, initiator: boolean): Conn {
    const existing = this.conns.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const conn: Conn = { pc, polite: this.session.myId > id, makingOffer: false, ignoreOffer: false };
    this.conns.set(id, conn);
    // Only the dialer creates the audio transceiver + data channel; the answerer
    // adopts the ones described in the offer (avoids duplicate m-lines).
    if (initiator) this.attachMedia(id, conn, pc.addTransceiver('audio', { direction: 'sendrecv' }));
    pc.onicecandidate = (e) => this.session.signal(id, { candidate: e.candidate });
    pc.onnegotiationneeded = async () => {
      try {
        conn.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') });
        this.session.signal(id, { description: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        conn.makingOffer = false;
      }
    };
    pc.ontrack = (e) => {
      this.tuneReceiver(e.receiver);
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.emit('stream', { id, stream });
    };
    pc.onconnectionstatechange = () => {
      this.emit('state', { id, state: pc.connectionState });
      if (pc.connectionState === 'connected') this.tuneSender(conn);
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    return conn;
  }

  private attachMedia(id: string, conn: Conn, tx: RTCRtpTransceiver) {
    tx.direction = 'sendrecv';
    conn.sender = tx.sender;
    if (this.liveTrack) tx.sender.replaceTrack(this.liveTrack).catch(() => {});
    // prefer Opus; drop speech-only codecs
    try {
      const opus = RTCRtpReceiver.getCapabilities?.('audio')?.codecs.filter((c) => /opus/i.test(c.mimeType));
      if (opus?.length) tx.setCodecPreferences(opus);
    } catch { /* not supported */ }
    const dc = conn.pc.createDataChannel('midi', { negotiated: true, id: 0, ordered: true });
    dc.onmessage = (e) => { try { this.emit('midi', { from: id, ev: JSON.parse(e.data) }); } catch { /* ignore */ } };
    conn.dc = dc;
  }

  private async tuneSender(c: Conn) {
    if (!c.sender) return;
    try {
      const p = c.sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 256_000;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      await c.sender.setParameters(p);
    } catch { /* not supported */ }
  }

  // "Perfect negotiation" (W3C pattern) handles offers crossing in flight.
  private async onSignal(from: string, data: any) {
    if (!this.session.peers.has(from)) return; // never negotiate media with someone not visibly in the room
    const c = this.conns.get(from) ?? this.connect(from, false);
    const { pc } = c;
    try {
      if (data.description) {
        const desc = data.description as RTCSessionDescriptionInit;
        const collision = desc.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
        c.ignoreOffer = !c.polite && collision;
        if (c.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (!c.sender) {
          const tx = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
          if (tx) this.attachMedia(from, c, tx);
        }
        if (desc.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp ?? '') });
          this.session.signal(from, { description: pc.localDescription });
        }
      } else if (data.candidate !== undefined) {
        try { await pc.addIceCandidate(data.candidate ?? undefined); } catch (err) { if (!c.ignoreOffer) throw err; }
      }
    } catch (err) {
      console.warn('signaling error', err);
    }
  }

  private drop(id: string) {
    const c = this.conns.get(id);
    if (!c) return;
    c.pc.close();
    this.conns.delete(id);
    this.stats.delete(id);
    this.emit('stream-end', id);
  }

  private async pollStats() {
    for (const [id, c] of this.conns) {
      if (c.pc.connectionState !== 'connected') continue;
      try {
        const report = await c.pc.getStats();
        let rtt = 0, jb = 0, lost = 0, recv = 0, bytes = 0;
        report.forEach((s: any) => {
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') rtt = (s.currentRoundTripTime ?? 0) * 1000;
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            if (s.jitterBufferEmittedCount) jb = (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000;
            lost = s.packetsLost ?? 0; recv = s.packetsReceived ?? 0; bytes = s.bytesReceived ?? 0;
          }
        });
        const now = performance.now();
        const bitrate = c.lastBytes ? ((bytes - c.lastBytes.bytes) * 8) / ((now - c.lastBytes.t) / 1000) : 0;
        c.lastBytes = { t: now, bytes };
        // mouth-to-ear estimate: half RTT + jitter buffer + 10 ms packetisation + ~5 ms codec
        this.stats.set(id, { rtt, jitterBuffer: jb, loss: recv ? lost / (lost + recv) : 0, bitrate, oneWay: rtt / 2 + jb + 15 });
      } catch { /* closed */ }
    }
    this.emit('stats', this.stats);
  }

  close() {
    clearInterval(this.statsTimer);
    for (const id of [...this.conns.keys()]) this.drop(id);
  }
}
