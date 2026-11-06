// WAV + Standard MIDI File encoders (for uploads, bounces and DAW interop —
// exported files open directly in SoundCraft, GarageBand, Logic, Ableton…).
import type { Note } from '../../../shared/model';

export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 | 32 = 32): ArrayBuffer {
  const nch = channels.length, len = channels[0]?.length ?? 0;
  const bps = bits / 8, dataSize = len * nch * bps;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); // 3 = IEEE float
  v.setUint16(22, nch, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = channels[c][i];
      if (bits === 32) { v.setFloat32(o, s, true); o += 4; continue; }
      const x = Math.max(-1, Math.min(1, s));
      if (bits === 16) { v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2; }
      else { const n = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff); v.setUint8(o, n & 0xff); v.setUint8(o + 1, (n >> 8) & 0xff); v.setUint8(o + 2, (n >> 16) & 0xff); o += 3; }
    }
  }
  return buf;
}

export function audioBufferToWav(b: AudioBuffer, bits: 16 | 24 | 32 = 24) {
  return encodeWav(Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)), b.sampleRate, bits);
}

const PPQ = 480;
function vlq(n: number) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

/** Type-1 Standard MIDI File: one MTrk per WeMake track. */
export function encodeMidi(bpm: number, sig: number, tracks: { name: string; channel: number; notes: Note[] }[]) {
  const chunks: number[][] = [];
  const tempo = Math.round(60_000_000 / bpm);
  const meta = [0, 0xff, 0x51, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff, 0, 0xff, 0x58, 4, sig, 2, 24, 8, 0, 0xff, 0x2f, 0];
  chunks.push(meta);
  for (const t of tracks) {
    const name = Array.from(new TextEncoder().encode(t.name.slice(0, 60)));
    const evs: { tick: number; bytes: number[] }[] = [];
    for (const n of t.notes) {
      const on = Math.round(n.s * PPQ), off = Math.round((n.s + n.d) * PPQ);
      evs.push({ tick: on, bytes: [0x90 | t.channel, n.p & 0x7f, Math.max(1, Math.round(n.v * 127))] });
      evs.push({ tick: Math.max(off, on + 1), bytes: [0x80 | t.channel, n.p & 0x7f, 0] });
    }
    evs.sort((a, b) => a.tick - b.tick || (a.bytes[0] & 0xf0) - (b.bytes[0] & 0xf0));
    const data = [0, 0xff, 0x03, ...vlq(name.length), ...name];
    let last = 0;
    for (const e of evs) { data.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    data.push(0, 0xff, 0x2f, 0);
    chunks.push(data);
  }
  const out: number[] = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 0xff, chunks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff];
  for (const c of chunks) out.push(0x4d, 0x54, 0x72, 0x6b, (c.length >>> 24) & 0xff, (c.length >> 16) & 0xff, (c.length >> 8) & 0xff, c.length & 0xff, ...c);
  return new Uint8Array(out);
}

export function download(data: ArrayBuffer | Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** min/max peaks for waveform drawing. */
export function computePeaks(b: AudioBuffer, samplesPerPeak = 256) {
  const n = Math.ceil(b.length / samplesPerPeak);
  const peaks = new Float32Array(n * 2);
  const chans = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    const end = Math.min(b.length, (i + 1) * samplesPerPeak);
    for (const d of chans) for (let j = i * samplesPerPeak; j < end; j++) { const s = d[j]; if (s < lo) lo = s; else if (s > hi) hi = s; }
    peaks[i * 2] = lo; peaks[i * 2 + 1] = hi;
  }
  return { peaks, samplesPerPeak, sampleRate: b.sampleRate, duration: b.duration };
}
export type Peaks = ReturnType<typeof computePeaks>;
