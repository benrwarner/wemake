import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as M from '../shared/model.ts';

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

test('seeded project has tracks, clips and defaults', () => {
  const doc = new Y.Doc();
  M.seedProject(doc);
  const s = M.snapshot(doc);
  assert.equal(s.project.bpm, 100);
  assert.equal(s.order.length, 5);
  assert.equal(Object.keys(s.clips).length, 2);
  assert.ok(s.order.every((id) => s.tracks[id]));
  assert.equal(s.transport.playing, false);
});

test('concurrent edits from two people merge without loss', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  M.seedProject(a);
  sync(a, b);
  const track = M.snapshot(a).order[0];
  const fxA = M.addFx(a, track, 'delay');
  const fxB = M.addFx(b, track, 'reverb');
  M.setTrack(a, track, { volume: -3 });
  M.addTrack(b, { kind: 'audio', name: 'Bass DI' });
  sync(a, b);
  const sa = M.snapshot(a), sb = M.snapshot(b);
  assert.deepEqual(sa, sb);
  const ids = sa.tracks[track].fx.map((f) => f.id);
  assert.ok(ids.includes(fxA) && ids.includes(fxB));
  assert.equal(sa.tracks[track].volume, -3);
  assert.ok(Object.values(sa.tracks).some((t) => t.name === 'Bass DI'));
});

test('param edits on different plugins of one track do not clobber each other', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  M.seedProject(a);
  sync(a, b);
  const vocals = Object.values(M.snapshot(a).tracks).find((t) => t.name === 'Vocals')!;
  const [eq, comp] = vocals.fx;
  M.setFx(a, vocals.id, eq.id, { param: ['low', 4] });
  M.setFx(b, vocals.id, comp.id, { param: ['ratio', 8] });
  sync(a, b);
  const fx = M.snapshot(a).tracks[vocals.id].fx;
  assert.equal(fx.find((f) => f.id === eq.id)!.params.low, 4);
  assert.equal(fx.find((f) => f.id === comp.id)!.params.ratio, 8);
});

test('moving and removing fx keeps params; deleting a track removes its clips', () => {
  const doc = new Y.Doc();
  M.seedProject(doc);
  const vocals = Object.values(M.snapshot(doc).tracks).find((t) => t.name === 'Vocals')!;
  const comp = vocals.fx[1];
  M.setFx(doc, vocals.id, comp.id, { param: ['ratio', 6] });
  M.moveFx(doc, vocals.id, comp.id, -1);
  let fx = M.snapshot(doc).tracks[vocals.id].fx;
  assert.equal(fx[0].id, comp.id);
  assert.equal(fx[0].params.ratio, 6);
  M.removeFx(doc, vocals.id, comp.id);
  fx = M.snapshot(doc).tracks[vocals.id].fx;
  assert.equal(fx.length, 2);
  const drums = M.snapshot(doc).order[0];
  M.deleteTrack(doc, drums);
  const s = M.snapshot(doc);
  assert.ok(!s.tracks[drums]);
  assert.ok(Object.values(s.clips).every((c) => c.trackId !== drums));
});

test('transport seq increments on every change', () => {
  const doc = new Y.Doc();
  M.seedProject(doc);
  const before = M.snapshot(doc).transport.seq;
  M.setTransport(doc, { playing: true, startBeat: 4 });
  M.setTransport(doc, { playing: false });
  assert.equal(M.snapshot(doc).transport.seq, before + 2);
});
