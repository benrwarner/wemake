// Integration: boots the real server and talks to it like two browsers would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as M from '../shared/model.ts';

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
let proc: ChildProcess;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wemake-test-'));

before(async () => {
  proc = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/time`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client(room: string, name: string) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
  const msgs: any[] = [];
  let synced: () => void;
  const ready = new Promise<void>((r) => { synced = r; });
  ws.on('message', (data, bin) => {
    if (bin) { Y.applyUpdate(doc, new Uint8Array(data as Buffer), 'remote'); synced(); return; }
    msgs.push(JSON.parse(data.toString()));
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, color: '#ff6b4a' })));
  doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote' && ws.readyState === 1) ws.send(u); });
  const waitFor = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 100; i++) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('timed out waiting for message');
  };
  return { doc, ws, msgs, ready, waitFor };
}

test('new rooms are seeded and edits propagate between clients', async () => {
  const a = client('itest-one', 'Ana');
  await a.ready;
  assert.equal(M.snapshot(a.doc).order.length, 5);
  const b = client('itest-one', 'Ben');
  await b.ready;
  await a.waitFor((m) => m.t === 'peer-join' && m.peer.name === 'Ben');
  M.setProject(a.doc, { bpm: 132 });
  for (let i = 0; i < 50 && M.snapshot(b.doc).project.bpm !== 132; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(M.snapshot(b.doc).project.bpm, 132);
  a.ws.close(); b.ws.close();
});

test('clock ping, cursor relay, chat and signaling', async () => {
  const a = client('itest-two', 'Ana');
  const b = client('itest-two', 'Ben');
  await Promise.all([a.ready, b.ready]);
  const welcomeB = await b.waitFor((m) => m.t === 'welcome');
  const welcomeA = await a.waitFor((m) => m.t === 'welcome');
  a.ws.send(JSON.stringify({ t: 'ping', c: 1 }));
  const pong = await a.waitFor((m) => m.t === 'pong');
  assert.ok(Math.abs(pong.s - Date.now()) < 1000);
  a.ws.send(JSON.stringify({ t: 'cursor', c: { v: 'a', b: 3, t: 'x', y: 0.5 } }));
  const cur = await b.waitFor((m) => m.t === 'cursor');
  assert.equal(cur.id, welcomeA.id);
  assert.equal(cur.c.b, 3);
  b.ws.send(JSON.stringify({ t: 'signal', to: welcomeA.id, data: { hello: 1 } }));
  const sig = await a.waitFor((m) => m.t === 'signal');
  assert.equal(sig.from, welcomeB.id);
  a.ws.send(JSON.stringify({ t: 'chat', text: 'ready?' }));
  assert.equal((await b.waitFor((m) => m.t === 'chat')).text, 'ready?');
  a.ws.close(); b.ws.close();
});

test('audio takes upload once and are served immutably; bad ids rejected', async () => {
  const body = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const put = await fetch(`${BASE}/api/audio/itest-three/abc123`, { method: 'PUT', body });
  assert.equal(put.status, 201);
  const again = await fetch(`${BASE}/api/audio/itest-three/abc123`, { method: 'PUT', body });
  assert.equal(again.status, 409);
  const get = await fetch(`${BASE}/api/audio/itest-three/abc123`);
  assert.equal(get.status, 200);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), body);
  assert.match(get.headers.get('cache-control') ?? '', /immutable/);
  assert.equal((await fetch(`${BASE}/api/audio/itest-three/..%2F..%2Fetc`)).status, 400);
});

test('room state persists after everyone leaves', async () => {
  const a = client('itest-four', 'Ana');
  await a.ready;
  M.setProject(a.doc, { name: 'Persisted Song' });
  await new Promise((r) => setTimeout(r, 100));
  a.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const b = client('itest-four', 'Ben');
  await b.ready;
  assert.equal(M.snapshot(b.doc).project.name, 'Persisted Song');
  b.ws.close();
});
