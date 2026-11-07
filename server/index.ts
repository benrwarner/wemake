// WeMake realtime server
//  - Yjs document relay + persistence (the shared project)
//  - WebRTC signaling for the peer-to-peer live-audio mesh
//  - Clock sync (ping/pong) so every client starts the transport on the same beat
//  - Recorded-take storage (WAV upload/download)
//  - Serves the built client in production
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { seedProject, yProject } from '../shared/model.ts';
import { Auth } from './auth.ts';
import { clientIp as resolveClientIp, parseTrust } from './clientIp.ts';
import { Db } from './db.ts';
import { Accounts } from './accounts.ts';
import { Api, currentUser, originAllowed } from './api.ts';
import { Songs } from './songs.ts';
import { Sounds } from './sounds.ts';
import { Storage } from './storage.ts';
import { Quota } from './quota.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 300) * 1024 * 1024;
const TRUSTED_PROXIES = parseTrust(process.env.TRUSTED_PROXIES);
// Optional WebSocket Origin allowlist, e.g. "https://wemake.example.com,https://pi.tailnet.ts.net"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const ID_RE = /^[a-z0-9]{4,40}$/i;

fs.mkdirSync(path.join(DATA, 'rooms'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'audio'), { recursive: true });

const MIN_FREE_GB = process.env.MIN_FREE_GB && Number(process.env.MIN_FREE_GB) >= 0 ? Number(process.env.MIN_FREE_GB) : 5;
const storage = new Storage({ audioDir: path.join(DATA, 'audio'), minFreeBytes: MIN_FREE_GB * 1024 ** 3 });

const now = () => performance.timeOrigin + performance.now();
const auth = new Auth(path.join(DATA, 'rooms'));

/** Client address; forwarded headers are only honoured from trusted proxies (see server/clientIp.ts). */
const clientIp = (req: http.IncomingMessage) => resolveClientIp(req, TRUSTED_PROXIES);

// ---------------- accounts ----------------
const db = new Db(path.join(DATA, 'wemake.db'));
const accounts = new Accounts(db);
const songs = new Songs(db);
const sounds = new Sounds(db);
// Each account's songs share this much take storage (ACCOUNT_QUOTA_GB=0 turns the cap off).
const QUOTA_GB = process.env.ACCOUNT_QUOTA_GB && Number(process.env.ACCOUNT_QUOTA_GB) >= 0 ? Number(process.env.ACCOUNT_QUOTA_GB) : 5;
const quota = new Quota({
  limitBytes: QUOTA_GB > 0 ? QUOTA_GB * 1024 ** 3 : Infinity,
  ownerOf: (room) => songs.ownerOf(room),
  ownedRooms: (user) => songs.ownedRooms(user),
  roomBytes: (room) => storage.roomBytes(room),
});
const QUOTA_FULL = `This song's owner has used all ${QUOTA_GB} GB of their storage`;
const api = new Api({ accounts, songs, sounds, quota, ip: clientIp, allowedOrigins: ALLOWED_ORIGINS, signupCode: process.env.SIGNUP_CODE || undefined });
const BACKUPS = path.join(DATA, 'backups');
function backupDb() {
  try { db.backup(BACKUPS); } catch (err) { console.error('database backup failed', err); }
}
setInterval(() => accounts.sweep(), 3600_000).unref();
setInterval(backupDb, 24 * 3600_000).unref();
setTimeout(backupDb, 60_000).unref(); // one shortly after start, so a fresh deploy has a backup

// Hourly: delete takes that songs closed for over a day no longer use.
function cleanTakes() {
  try {
    for (const { room, deleted } of storage.collectIdle(path.join(DATA, 'rooms'), (r) => rooms.has(r))) {
      console.log(`removed ${deleted.length} unused take(s) from ${room}`);
    }
  } catch (err) { console.error('take cleanup failed', err); }
}
setInterval(cleanTakes, 3600_000).unref();

function iceServers() {
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS is not valid JSON'); }
  }
  const list: Record<string, unknown>[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  return list;
}

// ---------------- rooms ----------------
interface Peer { id: string; ws: WebSocket; name: string; color: string; state: Record<string, unknown>; userId?: number }
interface Room { id: string; doc: Y.Doc; peers: Map<string, Peer>; conns: number; fresh: boolean; saveTimer?: NodeJS.Timeout }
const rooms = new Map<string, Room>();

const roomFile = (id: string) => path.join(DATA, 'rooms', `${id.toLowerCase()}.ybin`);

function getRoom(id: string): Room {
  const key = id.toLowerCase();
  let room = rooms.get(key);
  if (room) return room;
  const doc = new Y.Doc();
  const file = roomFile(key);
  const exists = fs.existsSync(file);
  if (exists) Y.applyUpdate(doc, fs.readFileSync(file));
  else seedProject(doc);
  // fresh = nobody has joined yet; its first visitor may set the password
  room = { id: key, doc, peers: new Map(), conns: 0, fresh: !exists && !auth.isLocked(key) };
  const r = room;
  doc.on('update', () => scheduleSave(r));
  rooms.set(key, room);
  return room;
}

function scheduleSave(room: Room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => saveRoom(room), 1500);
}
function saveRoom(room: Room) {
  clearTimeout(room.saveTimer);
  const tmp = roomFile(room.id) + '.tmp';
  fs.writeFileSync(tmp, Y.encodeStateAsUpdate(room.doc));
  fs.renameSync(tmp, roomFile(room.id));
  try { songs.setTitle(room.id, String(yProject(room.doc).get('name') ?? '')); } catch (err) { console.error('song title update failed', err); }
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room: Room, msg: unknown, except?: string) {
  const data = JSON.stringify(msg);
  for (const p of room.peers.values()) if (p.id !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
}
// Presence is relayed to every client, so only well-typed known fields pass.
function sanitizePresence(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const str = (k: string) => { if (typeof r[k] === 'string') out[k] = (r[k] as string).slice(0, 64); };
  const bool = (k: string) => { if (typeof r[k] === 'boolean') out[k] = r[k]; };
  const num = (k: string) => { if (typeof r[k] === 'number' && Number.isFinite(r[k])) out[k] = r[k]; };
  str('track'); str('editing'); bool('armed'); bool('recording'); bool('live'); bool('tunedIn'); num('cursor'); num('latency');
  if (r.mix && typeof r.mix === 'object' && !Array.isArray(r.mix)) {
    const mix: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.mix).slice(0, 32)) if (typeof v === 'number' && Number.isFinite(v)) mix[k.slice(0, 32)] = Math.max(-60, Math.min(12, v));
    out.mix = mix;
  }
  return out;
}

const peerInfo = (p: Peer) => ({ id: p.id, name: p.name, color: p.color, state: p.state });

// ---------------- HTTP ----------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.wav': 'audio/wav', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function audioPath(room: string, id: string) {
  return path.join(DATA, 'audio', room.toLowerCase(), `${id}.wav`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api' && (parts[1] === 'auth' || parts[1] === 'me')) {
    void api.handle(req, res, url);
    return;
  }
  if (parts[0] === 'api') {
    if (parts[1] === 'time') return json(res, 200, { t: now() });
    if (parts[1] === 'config') return json(res, 200, { iceServers: iceServers() });
    if (parts[1] === 'audio' && parts.length === 4) {
      const [, , room, id] = parts;
      if (!ROOM_RE.test(room) || !ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
      const file = audioPath(room, id);
      if (!auth.tokenValid(room, req.headers['x-wemake-token'] as string | undefined)) return json(res, 401, { error: 'join the session first' });
      if (req.method === 'PUT') {
        if (storage.resolveTake(room, id)) return json(res, 409, { error: 'exists' }); // takes are immutable
        if (!storage.hasRoom()) return json(res, 507, { error: 'The server is almost out of space' });
        const len = Number(req.headers['content-length'] ?? 0);
        if (len > MAX_UPLOAD) return json(res, 413, { error: 'too large' });
        const hold = quota.reserve(room.toLowerCase(), len, MAX_UPLOAD);
        if (!hold) return json(res, 507, { error: QUOTA_FULL });
        res.on('close', hold.release);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.part`;
        const out = fs.createWriteStream(tmp);
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > hold.maxBytes) { hold.release(); req.destroy(); out.destroy(); fs.rm(tmp, () => {}); }
        });
        req.pipe(out);
        out.on('finish', () => {
          if (size > hold.maxBytes) return;
          fs.renameSync(tmp, file);
          hold.release(); // the file itself counts from here on
          json(res, 201, { ok: true, size });
          void storage.enqueueFlac(file);
        });
        out.on('error', () => { hold.release(); json(res, 500, { error: 'write failed' }); });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const take = storage.resolveTake(room, id);
        if (!take) return json(res, 404, { error: 'not found' });
        let stat: fs.Stats;
        try { stat = fs.statSync(take.file); } catch { return json(res, 404, { error: 'not found' }); }
        res.writeHead(200, { 'content-type': take.type, 'content-length': stat.size, 'cache-control': 'private, max-age=31536000, immutable' });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(take.file).on('error', () => res.destroy()).pipe(res);
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  // static client (production build)
  let file = path.join(DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('WeMake server running. In development open the Vite dev server (http://localhost:5173).');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGINS.length) {
    const origin = String(req.headers.origin ?? '').replace(/\/+$/, '').toLowerCase();
    if (!ALLOWED_ORIGINS.includes(origin)) return ws.close(4403, 'origin not allowed');
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const roomId = url.searchParams.get('room') ?? '';
  if (!ROOM_RE.test(roomId)) return ws.close(4000, 'bad room');
  const room = getRoom(roomId);
  const peer: Peer = { id: Math.random().toString(36).slice(2, 10), ws, name: 'Guest', color: '#888', state: {} };
  let joined = false;
  room.conns++;

  const ip = clientIp(req);
  let user: ReturnType<typeof currentUser> = null;
  // The cookie is ambient, so only trust it from our own pages (blocks cross-site WebSocket hijacking).
  if (originAllowed(req, ALLOWED_ORIGINS)) try { user = currentUser(req, accounts); } catch (err) { console.error('session lookup failed', err); }
  // Nothing about the session is sent until the client has said hello (and passed the password check).
  const helloTimer = setTimeout(() => { if (!joined) ws.close(4408, 'hello timeout'); }, 15_000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!joined) return; // must announce yourself before editing
      const update = new Uint8Array(data as Buffer);
      try { Y.applyUpdate(room.doc, update, peer.id); } catch { return; }
      for (const p of room.peers.values()) if (p.id !== peer.id && p.ws.readyState === WebSocket.OPEN) p.ws.send(update);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.t) {
      case 'ping': return send(ws, { t: 'pong', c: msg.c, s: now() });
      case 'hello': {
        if (joined) return;
        const deny = (error: string) => { send(ws, { t: 'auth', error }); ws.close(4401, 'auth'); };
        if (auth.throttled(room.id, ip)) return deny('Too many wrong passwords. Try again in 10 minutes.');
        if (auth.isLocked(room.id)) {
          if (!auth.check(room.id, ip, msg.password)) return deny(msg.password ? 'Wrong password' : 'This session is password protected');
        } else if (room.fresh && msg.password) {
          const bad = Auth.validate(msg.password);
          if (bad) return deny(bad);
          auth.setPassword(room.id, msg.password);
        }
        joined = true;
        clearTimeout(helloTimer);
        const wasFresh = room.fresh;
        if (room.fresh) { room.fresh = false; scheduleSave(room); }
        if (user) {
          peer.userId = user.id;
          try {
            songs.touch(user.id, room.id, wasFresh ? 'owner' : 'member');
            if (wasFresh) songs.setOwner(room.id, user.id);
          } catch (err) { console.error('song list update failed', err); }
        }
        peer.name = String(msg.name ?? '').slice(0, 32) || user?.username || 'Guest';
        peer.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#888';
        send(ws, { t: 'welcome', id: peer.id, peers: [...room.peers.values()].map(peerInfo), s: now(), token: auth.issueToken(room.id), locked: auth.isLocked(room.id) });
        // Full document; the client merges and sends back anything the server lacks.
        ws.send(Y.encodeStateAsUpdate(room.doc));
        room.peers.set(peer.id, peer);
        broadcast(room, { t: 'peer-join', peer: peerInfo(peer) }, peer.id);
        return;
      }
      case 'set-password': {
        if (!joined) return;
        if (msg.password == null) auth.setPassword(room.id, null);
        else {
          const bad = Auth.validate(msg.password);
          if (bad) return send(ws, { t: 'room', locked: auth.isLocked(room.id), error: bad });
          auth.setPassword(room.id, msg.password);
          // Only the song's owner re-locking it prunes absent members; otherwise anyone could grief lists.
          try {
            if (peer.userId != null && songs.isOwner(peer.userId, room.id)) {
              const present = [...room.peers.values()].map((p) => p.userId).filter((id): id is number => id != null);
              songs.dropAbsentMembers(room.id, present);
            }
          } catch (err) { console.error('song list update failed', err); }
        }
        return broadcast(room, { t: 'room', locked: auth.isLocked(room.id), by: peer.name });
      }
      case 'presence':
        if (!joined) return;
        peer.state = sanitizePresence(msg.state);
        return broadcast(room, { t: 'presence', id: peer.id, state: peer.state }, peer.id);
      case 'signal': {
        if (!joined) return; // only visible participants may negotiate media
        const target = room.peers.get(msg.to);
        if (target) send(target.ws, { t: 'signal', from: peer.id, data: msg.data });
        return;
      }
      case 'cursor': // ephemeral pointer position, never stored
        if (!joined) return;
        return broadcast(room, { t: 'cursor', id: peer.id, c: msg.c ?? null }, peer.id);
      case 'chat':
        if (!joined) return;
        return broadcast(room, { t: 'chat', from: peer.id, name: peer.name, color: peer.color, text: String(msg.text ?? '').slice(0, 500), ts: Date.now() });
      case 'midi': // fallback relay when a data channel is not (yet) open
        if (!joined) return;
        if (msg.to) { const target = room.peers.get(msg.to); if (target) send(target.ws, { t: 'midi', from: peer.id, ev: msg.ev }); }
        return;
    }
  });

  ws.on('close', () => {
    room.peers.delete(peer.id);
    if (joined) broadcast(room, { t: 'peer-leave', id: peer.id });
    clearTimeout(helloTimer);
    if (--room.conns === 0) {
      if (!room.fresh) saveRoom(room); // never persist rooms nobody actually joined
      room.doc.destroy();
      rooms.delete(room.id);
    }
  });
});

// keep NATs/proxies from dropping idle sockets
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000).unref();

function shutdown() {
  for (const room of rooms.values()) if (!room.fresh) saveRoom(room);
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const HOST = process.env.HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`WeMake server on http://${HOST}:${PORT}`));
