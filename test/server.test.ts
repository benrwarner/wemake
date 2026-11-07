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
  proc = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SIGNUP_CODE: 'letmein', MIN_FREE_GB: '0' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/time`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client(room: string, name: string, password?: string, cookie?: string, origin: string = BASE) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`, cookie ? { headers: { cookie, origin } } : undefined);
  const msgs: any[] = [];
  let synced: () => void;
  const ready = new Promise<void>((r) => { synced = r; });
  ws.on('message', (data, bin) => {
    if (bin) { Y.applyUpdate(doc, new Uint8Array(data as Buffer), 'remote'); synced(); return; }
    msgs.push(JSON.parse(data.toString()));
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, color: '#ff6b4a', password })));
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

test('audio takes need a session token, upload once and are served immutably; bad ids rejected', async () => {
  const c = client('itest-three', 'Ana');
  await c.ready;
  const { token } = await c.waitFor((m) => m.t === 'welcome');
  const headers = { 'x-wemake-token': token };
  const body = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  assert.equal((await fetch(`${BASE}/api/audio/itest-three/abc123`, { method: 'PUT', body })).status, 401);
  const put = await fetch(`${BASE}/api/audio/itest-three/abc123`, { method: 'PUT', body, headers });
  assert.equal(put.status, 201);
  const again = await fetch(`${BASE}/api/audio/itest-three/abc123`, { method: 'PUT', body, headers });
  assert.equal(again.status, 409);
  assert.equal((await fetch(`${BASE}/api/audio/itest-three/abc123`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/audio/other-room/abc123`, { headers })).status, 401, 'token is scoped to its room');
  c.ws.close();
  const get = await fetch(`${BASE}/api/audio/itest-three/abc123`, { headers });
  assert.equal(get.status, 200);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), body);
  assert.match(get.headers.get('cache-control') ?? '', /immutable/);
  assert.match(get.headers.get('cache-control') ?? '', /^private\b/, 'token-gated takes must not be stored by shared caches');
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

test('unjoined sockets cannot edit or signal; presence is sanitized', async () => {
  const a = client('itest-five', 'Ana');
  await a.ready;
  const welcomeA = await a.waitFor((m) => m.t === 'welcome');
  // raw socket that never says hello
  const lurker = new WebSocket(`ws://localhost:${PORT}/ws?room=itest-five`);
  const lurkerGot: unknown[] = [];
  lurker.on('message', (m) => lurkerGot.push(m));
  await new Promise((r) => lurker.on('open', r));
  lurker.send(JSON.stringify({ t: 'signal', to: welcomeA.id, data: { description: { type: 'offer', sdp: 'x' } } }));
  const evil = new Y.Doc(); M.setProject(evil, { name: 'hijacked' });
  lurker.send(Y.encodeStateAsUpdate(evil));
  const b = client('itest-five', 'Ben');
  await b.ready;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!a.msgs.some((m) => m.t === 'signal'), 'signal from unjoined socket was relayed');
  assert.notEqual(M.snapshot(b.doc).project.name, 'hijacked');
  assert.equal(lurkerGot.length, 0, 'unjoined socket received session data');
  b.ws.send(JSON.stringify({ t: 'presence', state: [1, 2] }));
  b.ws.send(JSON.stringify({ t: 'presence', state: { track: 'x', armed: 'yes', evil: { deep: 1 }, mix: { p: 999 } } }));
  const pres = await a.waitFor((m) => m.t === 'presence' && m.state.track === 'x');
  assert.deepEqual(pres.state, { track: 'x', mix: { p: 12 } });
  lurker.close(); a.ws.close(); b.ws.close();
});

test('password-protected sessions', async () => {
  // creator locks a brand-new session from the lobby
  const owner = client('itest-locked', 'Ana', 'hunter22');
  await owner.ready;
  assert.equal((await owner.waitFor((m) => m.t === 'welcome')).locked, true);
  M.setProject(owner.doc, { name: 'Secret Song' });

  // no password: rejected, and receives nothing about the session
  const noPw = client('itest-locked', 'Eve');
  const denied = await noPw.waitFor((m) => m.t === 'auth');
  assert.match(denied.error, /password/i);
  assert.equal(M.snapshot(noPw.doc).project.name, M.DEFAULT_PROJECT.name);
  assert.ok(!noPw.msgs.some((m) => m.t === 'welcome' || m.t === 'peer-join'));

  // wrong password: rejected; right password: in
  const wrong = client('itest-locked', 'Eve', 'nope1234');
  assert.equal((await wrong.waitFor((m) => m.t === 'auth')).error, 'Wrong password');
  const friend = client('itest-locked', 'Ben', 'hunter22');
  await friend.ready;
  for (let i = 0; i < 50 && M.snapshot(friend.doc).project.name !== 'Secret Song'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(M.snapshot(friend.doc).project.name, 'Secret Song');

  // a password supplied for an existing open room does not lock it
  const open1 = client('itest-open', 'Ana');
  await open1.ready;
  const late = client('itest-open', 'Ben', 'sneaky99');
  assert.equal((await late.waitFor((m) => m.t === 'welcome')).locked, false);

  // members can change and remove the password
  owner.ws.send(JSON.stringify({ t: 'set-password', password: 'ab' }));
  assert.match((await owner.waitFor((m) => m.t === 'room' && m.error)).error, /at least/);
  owner.ws.send(JSON.stringify({ t: 'set-password', password: null }));
  await friend.waitFor((m) => m.t === 'room' && m.locked === false);
  const anyone = client('itest-locked', 'Cy');
  await anyone.ready;
  for (const c of [owner, friend, anyone, open1, late, noPw, wrong]) c.ws.close();
});

test('repeated wrong passwords are throttled', async () => {
  const owner = client('itest-brute', 'Ana', 'correct-horse');
  await owner.ready;
  for (let i = 0; i < 8; i++) {
    const c = client('itest-brute', 'Eve', `guess${i}`);
    await c.waitFor((m) => m.t === 'auth');
  }
  const right = client('itest-brute', 'Eve', 'correct-horse');
  assert.match((await right.waitFor((m) => m.t === 'auth')).error, /Too many/);
  owner.ws.close();
});

test('wrong-password throttling is per client IP behind a proxy', async () => {
  const owner = client('itest-brute-ip', 'Ana', 'correct-horse');
  await owner.ready;
  // the test connects from loopback, which is a trusted proxy, so CF-Connecting-IP identifies the user
  const as = (ip: string, password: string) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=itest-brute-ip`, { headers: { 'cf-connecting-ip': ip } });
    return new Promise<any>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'X', color: '#ff6b4a', password })));
      ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d.toString()); if (m.t === 'auth' || m.t === 'welcome') { resolve(m); ws.close(); } });
      ws.on('error', reject);
    });
  };
  for (let i = 0; i < 8; i++) await as('198.51.100.1', `guess${i}`);
  assert.match((await as('198.51.100.1', 'correct-horse')).error, /Too many/);
  assert.equal((await as('198.51.100.2', 'correct-horse')).t, 'welcome', 'another user must not be locked out');
  owner.ws.close();
});

// ---------------- accounts ----------------
let ipSeq = 1;
const freshIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;
async function api(p: string, opts: { method?: string; body?: unknown; cookie?: string; ip?: string; origin?: string | null; ctype?: string } = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip ?? freshIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = opts.ctype ?? 'application/json';
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}
async function newUser(name: string, password = 'password123') {
  const r = await api('/api/auth/signup', { body: { username: name, password, code: 'letmein' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { cookie: r.cookie, user: r.body.user };
}

test('signup needs the invite code', async () => {
  assert.equal((await api('/api/auth/signup', { body: { username: 'codeless', password: 'password123' } })).status, 403);
  assert.equal((await api('/api/auth/signup', { body: { username: 'codeless', password: 'password123', code: 'nope' } })).status, 403);
  const r = await api('/api/auth/signup', { body: { username: 'Coded', password: 'password123', code: 'letmein' } });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['id', 'username']);
  assert.equal(r.body.user.username, 'coded');
  const sc = r.headers.get('set-cookie') ?? '';
  assert.match(sc, /wm_session=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
  assert.doesNotMatch(sc, /Secure/i);
  const dup = await api('/api/auth/signup', { body: { username: 'coded', password: 'password123', code: 'letmein' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'That username is taken');
  assert.equal((await api('/api/auth/signup', { body: { username: 'x', password: 'password123', code: 'letmein' } })).status, 400);
});

test('login, me, logout round trip', async () => {
  await newUser('roundtrip');
  const me0 = await api('/api/me');
  assert.deepEqual(me0.body, { user: null });
  const r = await api('/api/auth/login', { body: { username: 'RoundTrip', password: 'password123' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'roundtrip');
  const me = await api('/api/me', { cookie: r.cookie });
  assert.equal(me.body.user.username, 'roundtrip');
  const out = await api('/api/auth/logout', { method: 'POST', body: {}, cookie: r.cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.deepEqual((await api('/api/me', { cookie: r.cookie })).body, { user: null });
});

test('wrong login copy', async () => {
  await newUser('copytest');
  for (const username of ['copytest', 'nosuchuser']) {
    const r = await api('/api/auth/login', { body: { username, password: 'wrongwrong' } });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Wrong username or password' });
  }
});

test('cross-origin POST is rejected', async () => {
  const r = await api('/api/auth/login', { body: { username: 'a', password: 'b' }, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal((await api('/api/auth/login', { body: { username: 'a', password: 'b' }, origin: null })).status, 403);
});

test('non-JSON POST is rejected', async () => {
  const r = await api('/api/auth/login', { body: 'username=a&password=b', ctype: 'text/plain' });
  assert.equal(r.status, 415);
});

test('login is rate limited per username and IP, without locking the real user out', async () => {
  await newUser('limited');
  const attacker = '203.0.113.50';
  for (let i = 0; i < 10; i++) assert.equal((await api('/api/auth/login', { body: { username: 'limited', password: 'wrongwrong' }, ip: attacker })).status, 401);
  const r = await api('/api/auth/login', { body: { username: 'limited', password: 'password123' }, ip: attacker });
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: 'Too many attempts. Try again in 15 minutes.' });
  assert.equal((await api('/api/auth/login', { body: { username: 'limited', password: 'password123' } })).status, 200, 'owner on another IP still signs in');
});

test('guesses spread over many IPs hit a per-username cap', async () => {
  await newUser('spread');
  for (let i = 0; i < 50; i++) await api('/api/auth/login', { body: { username: 'spread', password: 'wrongwrong' } });
  assert.equal((await api('/api/auth/login', { body: { username: 'spread', password: 'password123' } })).status, 429);
});

test('login is rate limited per IP', async () => {
  const ip = '203.0.113.99';
  for (let i = 0; i < 10; i++) await api('/api/auth/login', { body: { username: `who${i}`, password: 'wrongwrong' }, ip });
  assert.equal((await api('/api/auth/login', { body: { username: 'whoever', password: 'wrongwrong' }, ip })).status, 429);
});

test('/api/me responses are no-store', async () => {
  assert.equal((await api('/api/me')).headers.get('cache-control'), 'no-store');
  assert.equal((await api('/api/auth/login', { body: { username: 'zz', password: 'q' } })).headers.get('cache-control'), 'no-store');
});

// ---------------- my songs ----------------
const waitUntil = async (fn: () => Promise<boolean> | boolean, ms = 3000) => {
  for (let t = 0; t < ms; t += 50) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('condition not met');
};

test('joining while signed in adds the song', async () => {
  const ana = await newUser('songana');
  const bob = await newUser('songbob');
  const a = client('itest-songs', '', undefined, ana.cookie);
  await a.ready;
  const welcome = await a.waitFor((m) => m.t === 'welcome');
  assert.ok(welcome);
  M.setProject(a.doc, { name: 'My Tune' });
  const b = client('itest-songs', 'Bobby', undefined, bob.cookie);
  await b.ready;
  const join = await a.waitFor((m) => m.t === 'peer-join');
  assert.equal(join.peer.name, 'Bobby');
  const bJoin = await b.waitFor((m) => m.t === 'welcome');
  assert.equal(bJoin.peers.find((p: any) => p.id === welcome.id)?.name, 'songana', 'empty name defaults to username');
  a.ws.close(); b.ws.close();
  await waitUntil(async () => (await api('/api/me/songs', { cookie: ana.cookie })).body.songs?.[0]?.title === 'My Tune');
  const mine = (await api('/api/me/songs', { cookie: ana.cookie })).body.songs;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].room, 'itest-songs');
  assert.equal(mine[0].role, 'owner');
  assert.equal(typeof mine[0].last_opened_at, 'number');
  const theirs = (await api('/api/me/songs', { cookie: bob.cookie })).body.songs;
  assert.equal(theirs[0].role, 'member');
  assert.equal(theirs[0].title, 'My Tune');
});

test('removing a song only removes it from my list', async () => {
  const u = await newUser('remover');
  const c = client('itest-remove', 'x', undefined, u.cookie);
  await c.ready;
  c.ws.close();
  await waitUntil(async () => (await api('/api/me/songs', { cookie: u.cookie })).body.songs.length === 1);
  const r = await api('/api/me/songs/itest-remove', { method: 'DELETE', cookie: u.cookie });
  assert.equal(r.status, 204);
  assert.deepEqual((await api('/api/me/songs', { cookie: u.cookie })).body.songs, []);
  await waitUntil(() => fs.existsSync(path.join(dataDir, 'rooms', 'itest-remove.ybin')));
  assert.equal((await api('/api/me/songs/bad..room', { method: 'DELETE', cookie: u.cookie })).status, 400);
});

test('stale cookie joins as guest', async () => {
  const u = await newUser('stale');
  const { DatabaseSync } = await import('node:sqlite');
  const sql = new DatabaseSync(path.join(dataDir, 'wemake.db'));
  sql.exec('PRAGMA busy_timeout = 5000');
  sql.prepare("DELETE FROM users WHERE username = 'stale'").run();
  const c = client('itest-stale', 'Guesty', undefined, u.cookie);
  await c.ready;
  assert.ok(await c.waitFor((m) => m.t === 'welcome'));
  c.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((sql.prepare("SELECT COUNT(*) n FROM user_rooms WHERE room = 'itest-stale'").get() as any).n, 0);
  sql.close();
});

test('songs API requires sign-in', async () => {
  assert.equal((await api('/api/me/songs')).status, 401);
  assert.equal((await api('/api/me/songs/x', { method: 'DELETE' })).status, 401);
});

// ---------------- saved sounds ----------------
test('sounds CRUD round trip', async () => {
  const u = await newUser('sounder');
  assert.deepEqual((await api('/api/me/sounds', { cookie: u.cookie })).body, { sounds: [] });
  const add = await api('/api/me/sounds', { cookie: u.cookie, body: { name: '  Big Room  ', kind: 'fx', plugin_type: 'reverb', params: { mix: 0.4, decay: 3 } } });
  assert.equal(add.status, 201);
  const s = add.body.sound;
  assert.equal(s.name, 'Big Room');
  assert.equal(s.kind, 'fx');
  assert.equal(s.plugin_type, 'reverb');
  assert.deepEqual(s.params, { mix: 0.4, decay: 3 });
  assert.equal(typeof s.id, 'string');
  assert.equal(typeof s.created_at, 'number');
  const ren = await api(`/api/me/sounds/${s.id}`, { method: 'PATCH', cookie: u.cookie, body: { name: 'Hall' } });
  assert.equal(ren.status, 204);
  const list = (await api('/api/me/sounds', { cookie: u.cookie })).body.sounds;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Hall');
  assert.deepEqual(list[0].params, { mix: 0.4, decay: 3 });
  assert.equal((await api(`/api/me/sounds/${s.id}`, { method: 'DELETE', cookie: u.cookie })).status, 204);
  assert.deepEqual((await api('/api/me/sounds', { cookie: u.cookie })).body.sounds, []);
  assert.equal((await api('/api/me/sounds')).status, 401);
});

test("one user cannot see or delete another user's sound", async () => {
  const a = await newUser('owner1');
  const b = await newUser('thief1');
  const s = (await api('/api/me/sounds', { cookie: a.cookie, body: { name: 'Mine', kind: 'instrument', plugin_type: 'synth', params: {} } })).body.sound;
  assert.deepEqual((await api('/api/me/sounds', { cookie: b.cookie })).body.sounds, []);
  assert.equal((await api(`/api/me/sounds/${s.id}`, { method: 'DELETE', cookie: b.cookie })).status, 404);
  assert.equal((await api(`/api/me/sounds/${s.id}`, { method: 'PATCH', cookie: b.cookie, body: { name: 'Stolen' } })).status, 404);
  assert.equal((await api('/api/me/sounds', { cookie: a.cookie })).body.sounds[0].name, 'Mine');
});

test('bad sound payloads are rejected', async () => {
  const u = await newUser('badpayload');
  const ok = { name: 'n', kind: 'fx', plugin_type: 'reverb', params: { mix: 1 } };
  const bad = [
    { ...ok, params: { mix: 'loud' } },
    { ...ok, params: { mix: null } },
    { ...ok, params: [1, 2] },
    { ...ok, name: 'x'.repeat(65) },
    { ...ok, name: '   ' },
    { ...ok, kind: 'video' },
    { ...ok, plugin_type: '' },
    { ...ok, plugin_type: 'x'.repeat(2049) },
    { ...ok, params: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`param_${i}`, i])) }, // > 16 KB
  ];
  for (const body of bad) {
    const r = await api('/api/me/sounds', { cookie: u.cookie, body });
    assert.equal(r.status, r.status === 413 ? 413 : 400, JSON.stringify(body).slice(0, 80));
    assert.ok(r.body.error);
  }
  assert.equal((await api('/api/me/sounds', { cookie: u.cookie })).body.sounds.length, 0);
});

test('a cross-site page cannot join as the signed-in user', async () => {
  const u = await newUser('hijackme');
  const c = client('itest-xsite', '', undefined, u.cookie, 'https://evil.example');
  await c.ready;
  const w = await c.waitFor((m) => m.t === 'welcome');
  assert.ok(w);
  c.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await api('/api/me/songs', { cookie: u.cookie })).body.songs, []);
});

test('locking a song drops absent members from its list', async () => {
  const owner = await newUser('lockowner');
  const old = await newUser('lockformer');
  const stay = await newUser('lockstayer');
  const a = client('itest-lockdrop', 'o', undefined, owner.cookie);
  await a.ready;
  const b = client('itest-lockdrop', 'f', undefined, old.cookie);
  await b.ready;
  b.ws.close();
  const c = client('itest-lockdrop', 's', undefined, stay.cookie);
  await c.ready;
  await waitUntil(async () => (await api('/api/me/songs', { cookie: old.cookie })).body.songs.length === 1);
  a.ws.send(JSON.stringify({ t: 'set-password', password: 'secret123' }));
  await a.waitFor((m) => m.t === 'room' && m.locked);
  await waitUntil(async () => (await api('/api/me/songs', { cookie: old.cookie })).body.songs.length === 0);
  assert.equal((await api('/api/me/songs', { cookie: stay.cookie })).body.songs.length, 1, 'connected member keeps it');
  assert.equal((await api('/api/me/songs', { cookie: owner.cookie })).body.songs.length, 1, 'owner keeps it');
  a.ws.close(); c.ws.close();
});

test('a guest locking a song does not drop members from their lists', async () => {
  const owner = await newUser('glockowner');
  const mem = await newUser('glockmember');
  const a = client('itest-guestlock', 'o', undefined, owner.cookie);
  await a.ready;
  const b = client('itest-guestlock', 'm', undefined, mem.cookie);
  await b.ready;
  b.ws.close();
  const g = client('itest-guestlock', 'guest');
  await g.ready;
  await waitUntil(async () => (await api('/api/me/songs', { cookie: mem.cookie })).body.songs.length === 1);
  g.ws.send(JSON.stringify({ t: 'set-password', password: 'secret123' }));
  await g.waitFor((m) => m.t === 'room' && m.locked);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await api('/api/me/songs', { cookie: mem.cookie })).body.songs.length, 1);
  a.ws.close(); g.ws.close();
});

test("strangers can't lock a friend out from a device they've used before", async () => {
  await newUser('lockout');
  const home = '203.0.113.77';
  assert.equal((await api('/api/auth/login', { body: { username: 'lockout', password: 'password123' }, ip: home })).status, 200);
  for (let i = 0; i < 50; i++) await api('/api/auth/login', { body: { username: 'lockout', password: 'wrongwrong' } });
  assert.equal((await api('/api/auth/login', { body: { username: 'lockout', password: 'password123' } })).status, 429, 'new address is capped');
  assert.equal((await api('/api/auth/login', { body: { username: 'lockout', password: 'password123' }, ip: home })).status, 200, 'known address still works');
});

test('parallel guesses cannot slip past the limit while hashing', async () => {
  await newUser('parallel');
  const ip = '203.0.113.88';
  const codes = await Promise.all(Array.from({ length: 30 }, () => api('/api/auth/login', { body: { username: 'parallel', password: 'wrongwrong' }, ip }).then((r) => r.status)));
  assert.ok(codes.filter((c) => c === 401).length <= 10, codes.join(','));
  assert.ok(codes.every((c) => c === 401 || c === 429));
});
