// Shared, CRDT-backed project model. Used by the server (to seed new rooms)
// and the client (to read/mutate the session). Everything collaborative lives
// in a single Y.Doc so edits from every participant merge without conflicts.
import * as Y from 'yjs';

export interface Note { p: number; s: number; d: number; v: number } // pitch, start (beats, clip-relative), duration (beats), velocity 0..1

export interface FxSlot { id: string; type: string; bypass: boolean; params: Record<string, number> }

export interface Track {
  id: string;
  name: string;
  kind: 'audio' | 'instrument';
  color: string;
  volume: number; // dB
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  instrument?: { type: string; params: Record<string, number> };
  fx: FxSlot[];
}

export interface Clip {
  id: string;
  trackId: string;
  kind: 'audio' | 'midi';
  name: string;
  start: number; // beats
  length: number; // beats
  offset: number; // seconds into the source audio (audio clips)
  gain: number; // dB
  audioId?: string;
  notes?: Note[];
  by?: string;
}

export interface Project {
  bpm: number;
  sig: number; // beats per bar
  loopOn: boolean;
  loopStart: number; // beats
  loopEnd: number; // beats
  master: number; // dB
  name: string;
}

export interface Transport {
  playing: boolean;
  startServerMs: number; // server clock time at which `startBeat` is heard
  startBeat: number;
  noLoop: boolean; // set while recording so takes are linear
  by: string;
  byId?: string; // peer id of whoever last drove the shared transport (the orchestrator)
  seq: number;
}

export interface Snapshot {
  project: Project;
  order: string[];
  tracks: Record<string, Track>;
  clips: Record<string, Clip>;
  transport: Transport;
}

export const TRACK_COLORS = ['#ff6b4a', '#ffb547', '#7bd88f', '#4ac7ff', '#a98bff', '#ff7ac6', '#56e0c8', '#e8e36b'];

export const uid = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const DEFAULT_PROJECT: Project = {
  bpm: 100, sig: 4, loopOn: true, loopStart: 0, loopEnd: 16, master: 0, name: 'Untitled Jam',
};

export const DEFAULT_TRANSPORT: Transport = {
  playing: false, startServerMs: 0, startBeat: 0, noLoop: false, by: '', seq: 0,
};

// ---------- Y.Doc accessors ----------
export const yProject = (doc: Y.Doc) => doc.getMap<unknown>('project');
export const yOrder = (doc: Y.Doc) => doc.getArray<string>('order');
export const yTracks = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('tracks');
export const yClips = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('clips');
export const yTransport = (doc: Y.Doc) => doc.getMap<unknown>('transport');

function mapFrom(obj: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) m.set(k, v);
  return m;
}

function fxToY(slot: FxSlot): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', slot.id);
  m.set('type', slot.type);
  m.set('bypass', slot.bypass);
  m.set('params', mapFrom(slot.params));
  return m;
}

export function snapshot(doc: Y.Doc): Snapshot {
  const project = { ...DEFAULT_PROJECT, ...(yProject(doc).toJSON() as Partial<Project>) };
  const transport = { ...DEFAULT_TRANSPORT, ...(yTransport(doc).toJSON() as Partial<Transport>) };
  const tracks = yTracks(doc).toJSON() as Record<string, Track>;
  const clips = yClips(doc).toJSON() as Record<string, Clip>;
  // Order can briefly reference deleted tracks (or miss new ones) during concurrent edits.
  const seen = new Set<string>();
  const order = yOrder(doc).toArray().filter((id) => tracks[id] && !seen.has(id) && seen.add(id));
  for (const id of Object.keys(tracks)) if (!seen.has(id)) order.push(id);
  for (const t of Object.values(tracks)) t.fx ??= [];
  return { project, order, tracks, clips, transport };
}

// ---------- mutations ----------
export function addTrack(doc: Y.Doc, t: Partial<Track> & Pick<Track, 'kind'>, index?: number): string {
  const id = t.id ?? uid('t');
  const count = yOrder(doc).length;
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('name', t.name ?? (t.kind === 'audio' ? `Audio ${count + 1}` : `Instrument ${count + 1}`));
    m.set('kind', t.kind);
    m.set('color', t.color ?? TRACK_COLORS[count % TRACK_COLORS.length]);
    m.set('volume', t.volume ?? -6);
    m.set('pan', t.pan ?? 0);
    m.set('mute', false);
    m.set('solo', false);
    if (t.kind === 'instrument') {
      const inst = new Y.Map<unknown>();
      inst.set('type', t.instrument?.type ?? 'synth');
      inst.set('params', mapFrom(t.instrument?.params ?? {}));
      m.set('instrument', inst);
    }
    const fx = new Y.Array<Y.Map<unknown>>();
    fx.push((t.fx ?? []).map(fxToY));
    m.set('fx', fx);
    yTracks(doc).set(id, m);
    const order = yOrder(doc);
    order.insert(index === undefined ? order.length : Math.min(index, order.length), [id]);
  });
  return id;
}

export function deleteTrack(doc: Y.Doc, id: string) {
  doc.transact(() => {
    yTracks(doc).delete(id);
    const order = yOrder(doc);
    for (let i = order.length - 1; i >= 0; i--) if (order.get(i) === id) order.delete(i, 1);
    for (const [cid, c] of yClips(doc).entries()) if (c.get('trackId') === id) yClips(doc).delete(cid);
  });
}

export function moveTrack(doc: Y.Doc, id: string, toIndex: number) {
  doc.transact(() => {
    const order = yOrder(doc);
    const from = order.toArray().indexOf(id);
    if (from < 0) return;
    order.delete(from, 1);
    order.insert(Math.max(0, Math.min(toIndex, order.length)), [id]);
  });
}

export function setTrack(doc: Y.Doc, id: string, patch: Partial<Pick<Track, 'name' | 'volume' | 'pan' | 'mute' | 'solo' | 'color'>>) {
  const m = yTracks(doc).get(id);
  if (!m) return;
  doc.transact(() => { for (const [k, v] of Object.entries(patch)) m.set(k, v); });
}

export function setInstrument(doc: Y.Doc, trackId: string, type: string, params: Record<string, number> = {}) {
  const m = yTracks(doc).get(trackId);
  if (!m) return;
  doc.transact(() => {
    const inst = new Y.Map<unknown>();
    inst.set('type', type);
    inst.set('params', mapFrom(params));
    m.set('instrument', inst);
  });
}

export function setInstrumentParam(doc: Y.Doc, trackId: string, param: string, value: number) {
  const inst = yTracks(doc).get(trackId)?.get('instrument') as Y.Map<unknown> | undefined;
  (inst?.get('params') as Y.Map<unknown> | undefined)?.set(param, value);
}

function fxArray(doc: Y.Doc, trackId: string) {
  return yTracks(doc).get(trackId)?.get('fx') as Y.Array<Y.Map<unknown>> | undefined;
}
function fxIndex(arr: Y.Array<Y.Map<unknown>>, fxId: string) {
  return arr.toArray().findIndex((m) => m.get('id') === fxId);
}

export function addFx(doc: Y.Doc, trackId: string, type: string, params: Record<string, number> = {}) {
  const id = uid('fx');
  fxArray(doc, trackId)?.push([fxToY({ id, type, bypass: false, params })]);
  return id;
}

export function removeFx(doc: Y.Doc, trackId: string, fxId: string) {
  const arr = fxArray(doc, trackId);
  if (!arr) return;
  const i = fxIndex(arr, fxId);
  if (i >= 0) arr.delete(i, 1);
}

export function moveFx(doc: Y.Doc, trackId: string, fxId: string, dir: -1 | 1) {
  const arr = fxArray(doc, trackId);
  if (!arr) return;
  const i = fxIndex(arr, fxId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  doc.transact(() => {
    const json = arr.get(i).toJSON() as FxSlot;
    arr.delete(i, 1);
    arr.insert(j, [fxToY(json)]);
  });
}

export function setFx(doc: Y.Doc, trackId: string, fxId: string, patch: { bypass?: boolean; param?: [string, number] }) {
  const arr = fxArray(doc, trackId);
  if (!arr) return;
  const i = fxIndex(arr, fxId);
  if (i < 0) return;
  const m = arr.get(i);
  doc.transact(() => {
    if (patch.bypass !== undefined) m.set('bypass', patch.bypass);
    if (patch.param) (m.get('params') as Y.Map<unknown>).set(patch.param[0], patch.param[1]);
  });
}

export function addClip(doc: Y.Doc, c: Omit<Clip, 'id' | 'offset' | 'gain'> & Partial<Pick<Clip, 'id' | 'offset' | 'gain'>>): string {
  const id = c.id ?? uid('c');
  yClips(doc).set(id, mapFrom({ offset: 0, gain: 0, ...c, id }));
  return id;
}

export function setClip(doc: Y.Doc, id: string, patch: Partial<Omit<Clip, 'id'>>) {
  const m = yClips(doc).get(id);
  if (!m) return;
  doc.transact(() => { for (const [k, v] of Object.entries(patch)) if (v !== undefined) m.set(k, v); });
}

export function deleteClip(doc: Y.Doc, id: string) { yClips(doc).delete(id); }

export function setProject(doc: Y.Doc, patch: Partial<Project>) {
  const m = yProject(doc);
  doc.transact(() => { for (const [k, v] of Object.entries(patch)) m.set(k, v); });
}

export function setTransport(doc: Y.Doc, patch: Partial<Transport>) {
  const m = yTransport(doc);
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) m.set(k, v);
    m.set('seq', ((m.get('seq') as number) ?? 0) + 1);
  });
}

// ---------- seed ----------
function beatPattern(): Note[] {
  const notes: Note[] = [];
  for (let bar = 0; bar < 4; bar++) {
    const b = bar * 4;
    notes.push({ p: 36, s: b, d: 0.25, v: 1 }, { p: 36, s: b + 2.5, d: 0.25, v: 0.8 });
    if (bar % 2 === 1) notes.push({ p: 36, s: b + 3.25, d: 0.25, v: 0.6 });
    notes.push({ p: 38, s: b + 1, d: 0.25, v: 0.9 }, { p: 38, s: b + 3, d: 0.25, v: 0.95 });
    for (let i = 0; i < 8; i++) notes.push({ p: 42, s: b + i / 2, d: 0.125, v: i % 2 ? 0.45 : 0.7 });
  }
  return notes;
}

function chordPattern(): Note[] {
  // i - VI - III - VII in A minor, voiced around middle C
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  return chords.flatMap((ch, bar) => ch.map((p) => ({ p, s: bar * 4, d: 3.5, v: 0.7 })));
}

export function seedProject(doc: Y.Doc) {
  doc.transact(() => {
    setProject(doc, DEFAULT_PROJECT);
    setTransport(doc, DEFAULT_TRANSPORT);
    const drums = addTrack(doc, { kind: 'instrument', name: 'Drums', instrument: { type: 'drums', params: {} }, volume: -4 });
    const keys = addTrack(doc, {
      kind: 'instrument', name: 'Keys', instrument: { type: 'epiano', params: {} }, volume: -8,
      fx: [{ id: uid('fx'), type: 'chorus', bypass: false, params: {} }, { id: uid('fx'), type: 'reverb', bypass: false, params: { mix: 0.25 } }],
    });
    addTrack(doc, { kind: 'instrument', name: 'Bass', instrument: { type: 'synth', params: { preset: 1 } }, volume: -8 });
    addTrack(doc, {
      kind: 'audio', name: 'Vocals', volume: -4,
      fx: [{ id: uid('fx'), type: 'eq', bypass: false, params: {} }, { id: uid('fx'), type: 'compressor', bypass: false, params: {} }, { id: uid('fx'), type: 'reverb', bypass: false, params: { mix: 0.18 } }],
    });
    addTrack(doc, { kind: 'audio', name: 'Guitar', volume: -6, fx: [{ id: uid('fx'), type: 'amp', bypass: false, params: {} }, { id: uid('fx'), type: 'delay', bypass: false, params: {} }] });
    addClip(doc, { trackId: drums, kind: 'midi', name: 'Beat', start: 0, length: 16, notes: beatPattern() });
    addClip(doc, { trackId: keys, kind: 'midi', name: 'Chords', start: 0, length: 16, notes: chordPattern() });
  });
}
