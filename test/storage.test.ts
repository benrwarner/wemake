import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as M from '../shared/model.ts';
import { Storage, freeBytes, referencedAudioIds } from '../server/storage.ts';

const hasFlac = spawnSync('flac', ['--version']).status === 0;

function tmpAudio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wemake-store-'));
  fs.mkdirSync(path.join(dir, 'room1'));
  return dir;
}

function sineWav(seconds = 1, rate = 44100): Buffer {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('freeBytes reports a positive number', async () => {
  assert.ok(freeBytes(os.tmpdir()) > 0);
});

test('resolveTake prefers flac over wav', async () => {
  const dir = tmpAudio();
  const s = new Storage({ audioDir: dir, minFreeBytes: 0 });
  assert.equal(s.resolveTake('room1', 'abcd'), null);
  fs.writeFileSync(path.join(dir, 'room1', 'abcd.wav'), 'w');
  assert.deepEqual(s.resolveTake('ROOM1', 'abcd'), { file: path.join(dir, 'room1', 'abcd.wav'), type: 'audio/wav' });
  fs.writeFileSync(path.join(dir, 'room1', 'abcd.flac'), 'f');
  assert.deepEqual(s.resolveTake('room1', 'abcd'), { file: path.join(dir, 'room1', 'abcd.flac'), type: 'audio/flac' });
});

test('collect deletes only old unreferenced takes', async () => {
  const dir = tmpAudio();
  const s = new Storage({ audioDir: dir, minFreeBytes: 0 });
  const f = (n: string) => path.join(dir, 'room1', n);
  for (const n of ['keep1.wav', 'gone1.wav', 'gone2.flac', 'young1.wav', 'upload.wav.123.part']) fs.writeFileSync(f(n), 'x');
  const old = (Date.now() - 2 * 3600_000) / 1000;
  for (const n of ['keep1.wav', 'gone1.wav', 'gone2.flac', 'upload.wav.123.part']) fs.utimesSync(f(n), old, old);
  const deleted = s.collect('room1', new Set(['keep1']));
  assert.deepEqual(deleted.sort(), ['gone1', 'gone2']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'room1')).sort(), ['keep1.wav', 'upload.wav.123.part', 'young1.wav']);
  assert.deepEqual(s.collect('no-such-room', new Set()), []);
});

test('hasRoom compares free space with the limit', async () => {
  const dir = tmpAudio();
  assert.equal(new Storage({ audioDir: dir, minFreeBytes: 0 }).hasRoom(), true);
  assert.equal(new Storage({ audioDir: dir, minFreeBytes: Number.MAX_SAFE_INTEGER }).hasRoom(), false);
});

test('enqueueFlac keeps the wav when the encoder is missing', async () => {
  const dir = tmpAudio();
  const wav = path.join(dir, 'room1', 'take1.wav');
  fs.writeFileSync(wav, sineWav(0.1));
  const s = new Storage({ audioDir: dir, minFreeBytes: 0, flacBin: '/nonexistent/flac' });
  await s.enqueueFlac(wav);
  assert.ok(fs.existsSync(wav));
  assert.ok(!fs.existsSync(path.join(dir, 'room1', 'take1.flac')));
  assert.equal(s.resolveTake('room1', 'take1')?.type, 'audio/wav');
});

test('enqueueFlac replaces wav with flac', { skip: !hasFlac && 'flac not installed' }, async () => {
  const dir = tmpAudio();
  const wav = path.join(dir, 'room1', 'take2.wav');
  fs.writeFileSync(wav, sineWav(1));
  const s = new Storage({ audioDir: dir, minFreeBytes: 0 });
  await Promise.all([s.enqueueFlac(wav), s.enqueueFlac(wav)]); // second is a no-op
  const flac = path.join(dir, 'room1', 'take2.flac');
  assert.ok(fs.existsSync(flac));
  assert.ok(!fs.existsSync(wav));
  assert.ok(fs.statSync(flac).size < sineWav(1).length);
  assert.equal(s.resolveTake('room1', 'take2')?.type, 'audio/flac');
});

test('referencedAudioIds lists clip audio ids', async () => {
  const doc = new Y.Doc();
  M.seedProject(doc);
  const track = M.snapshot(doc).order[0];
  M.addClip(doc, { trackId: track, start: 0, length: 4, audioId: 'abc123' } as any);
  assert.ok(referencedAudioIds(doc).has('abc123'));
});

test('upload refused when disk is nearly full', async () => {
  const port = 8900 + Math.floor(Math.random() * 90);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wemake-full-'));
  const proc = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, MIN_FREE_GB: '1000000000' }, stdio: 'pipe' });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://localhost:${port}/api/time`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const ws = new WebSocket(`ws://localhost:${port}/ws?room=fullroom`);
    const token = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'x' })));
      ws.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); if (m.t === 'welcome') resolve(m.token); } });
      ws.on('error', reject);
    });
    const r = await fetch(`http://localhost:${port}/api/audio/fullroom/abcd1234`, { method: 'PUT', headers: { 'x-wemake-token': token }, body: new Uint8Array(sineWav(0.1)) });
    assert.equal(r.status, 507);
    assert.deepEqual(await r.json(), { error: 'The server is almost out of space' });
    ws.close();
  } finally {
    proc.kill();
  }
});

test('admin CLI lists users, resets passwords and deletes users', async () => {
  const { Db } = await import('../server/db.ts');
  const { Accounts } = await import('../server/accounts.ts');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wemake-admin-'));
  const db = new Db(path.join(dataDir, 'wemake.db'));
  const acc = new Accounts(db);
  await acc.signup('alice', 'password1');
  const admin = (...args: string[]) => spawnSync('npx', ['tsx', 'server/admin.ts', ...args], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  const list = admin('list-users');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /alice/);
  const reset = admin('reset-password', 'alice');
  assert.equal(reset.status, 0, reset.stderr);
  const pw = /New password for alice: (\S+)/.exec(reset.stdout)?.[1];
  assert.ok(pw);
  assert.ok(await acc.login('alice', pw!));
  assert.notEqual(admin('reset-password', 'ghost').status, 0);
  assert.equal(admin('delete-user', 'alice').status, 0);
  assert.equal(acc.listUsers().length, 0);
  fs.mkdirSync(path.join(dataDir, 'audio', 'r'), { recursive: true });
  const ct = admin('compress-takes');
  assert.equal(ct.status, 0, ct.stderr);
  assert.notEqual(admin('bogus').status, 0);
  db.close();
});

test('collectIdle only cleans songs that have been closed for a day', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wemake-idle-'));
  const audio = path.join(root, 'audio');
  const roomsDir = path.join(root, 'rooms');
  fs.mkdirSync(roomsDir, { recursive: true });
  const old = (Date.now() - 2 * 24 * 3600_000) / 1000;
  const mkRoom = (room: string, ybinAgeOld: boolean) => {
    const doc = new Y.Doc();
    M.seedProject(doc);
    M.addClip(doc, { trackId: M.snapshot(doc).order[0], start: 0, length: 4, audioId: 'keep1' } as any);
    const ybin = path.join(roomsDir, `${room}.ybin`);
    fs.writeFileSync(ybin, Y.encodeStateAsUpdate(doc));
    if (ybinAgeOld) fs.utimesSync(ybin, old, old);
    fs.mkdirSync(path.join(audio, room), { recursive: true });
    for (const n of ['keep1.flac', 'gone1.wav']) {
      fs.writeFileSync(path.join(audio, room, n), 'x');
      fs.utimesSync(path.join(audio, room, n), old, old);
    }
  };
  mkRoom('idle', true);
  mkRoom('recent', false); // closed less than a day ago: undo after a reconnect must still work
  mkRoom('open', true);
  fs.mkdirSync(path.join(audio, 'orphan'), { recursive: true }); // takes but no song file: leave alone
  fs.writeFileSync(path.join(audio, 'orphan', 'x1.wav'), 'x');
  fs.utimesSync(path.join(audio, 'orphan', 'x1.wav'), old, old);
  const s = new Storage({ audioDir: audio, minFreeBytes: 0 });
  const out = s.collectIdle(roomsDir, (r) => r === 'open');
  assert.deepEqual(out, [{ room: 'idle', deleted: ['gone1'] }]);
  assert.deepEqual(fs.readdirSync(path.join(audio, 'idle')), ['keep1.flac']);
  assert.equal(fs.readdirSync(path.join(audio, 'recent')).length, 2);
  assert.equal(fs.readdirSync(path.join(audio, 'open')).length, 2);
  assert.equal(fs.readdirSync(path.join(audio, 'orphan')).length, 1);
});

test('two encoders racing on one wav leave a valid flac', { skip: !hasFlac && 'flac not installed' }, async () => {
  for (let round = 0; round < 3; round++) {
    const dir = tmpAudio();
    const wav = path.join(dir, 'room1', 'race1.wav');
    fs.writeFileSync(wav, sineWav(3));
    const a = new Storage({ audioDir: dir, minFreeBytes: 0 });
    const b = new Storage({ audioDir: dir, minFreeBytes: 0 }); // e.g. the server and `admin.ts compress-takes`
    await Promise.all([a.enqueueFlac(wav), b.enqueueFlac(wav)]);
    const flac = path.join(dir, 'room1', 'race1.flac');
    assert.ok(fs.existsSync(flac));
    assert.equal(spawnSync('flac', ['-t', '--silent', flac]).status, 0, 'flac verifies');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'room1')), ['race1.flac']);
  }
});
