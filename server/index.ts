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
import { seedProject } from '../shared/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD = 300 * 1024 * 1024;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/i;
const ID_RE = /^[a-z0-9]{4,40}$/i;

fs.mkdirSync(path.join(DATA, 'rooms'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'audio'), { recursive: true });

const now = () => performance.timeOrigin + performance.now();

function iceServers() {
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS is not valid JSON'); }
  }
  const list: Record<string, unknown>[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  return list;
}

// ---------------- rooms ----------------
interface Peer { id: string; ws: WebSocket; name: string; color: string; state: Record<string, unknown> }
interface Room { id: string; doc: Y.Doc; peers: Map<string, Peer>; conns: number; saveTimer?: NodeJS.Timeout }
const rooms = new Map<string, Room>();

const roomFile = (id: string) => path.join(DATA, 'rooms', `${id.toLowerCase()}.ybin`);

function getRoom(id: string): Room {
  const key = id.toLowerCase();
  let room = rooms.get(key);
  if (room) return room;
  const doc = new Y.Doc();
  const file = roomFile(key);
  if (fs.existsSync(file)) Y.applyUpdate(doc, fs.readFileSync(file));
  else seedProject(doc);
  room = { id: key, doc, peers: new Map(), conns: 0 };
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
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room: Room, msg: unknown, except?: string) {
  const data = JSON.stringify(msg);
  for (const p of room.peers.values()) if (p.id !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
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

  if (parts[0] === 'api') {
    if (parts[1] === 'time') return json(res, 200, { t: now() });
    if (parts[1] === 'config') return json(res, 200, { iceServers: iceServers() });
    if (parts[1] === 'audio' && parts.length === 4) {
      const [, , room, id] = parts;
      if (!ROOM_RE.test(room) || !ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
      const file = audioPath(room, id);
      if (req.method === 'PUT') {
        if (fs.existsSync(file)) return json(res, 409, { error: 'exists' }); // takes are immutable
        const len = Number(req.headers['content-length'] ?? 0);
        if (len > MAX_UPLOAD) return json(res, 413, { error: 'too large' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.part`;
        const out = fs.createWriteStream(tmp);
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); fs.rm(tmp, () => {}); }
        });
        req.pipe(out);
        out.on('finish', () => {
          if (size > MAX_UPLOAD) return;
          fs.renameSync(tmp, file);
          json(res, 201, { ok: true, size });
        });
        out.on('error', () => json(res, 500, { error: 'write failed' }));
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
        const stat = fs.statSync(file);
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': stat.size, 'cache-control': 'public, max-age=31536000, immutable' });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file).pipe(res);
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
  const url = new URL(req.url ?? '/', 'http://x');
  const roomId = url.searchParams.get('room') ?? '';
  if (!ROOM_RE.test(roomId)) return ws.close(4000, 'bad room');
  const room = getRoom(roomId);
  const peer: Peer = { id: Math.random().toString(36).slice(2, 10), ws, name: 'Guest', color: '#888', state: {} };
  let joined = false;
  room.conns++;

  // Full document first; client merges and sends back anything the server lacks.
  ws.send(Y.encodeStateAsUpdate(room.doc));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
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
        joined = true;
        peer.name = String(msg.name ?? 'Guest').slice(0, 32) || 'Guest';
        peer.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#888';
        send(ws, { t: 'welcome', id: peer.id, peers: [...room.peers.values()].map(peerInfo), s: now() });
        room.peers.set(peer.id, peer);
        broadcast(room, { t: 'peer-join', peer: peerInfo(peer) }, peer.id);
        return;
      }
      case 'presence':
        if (!joined || typeof msg.state !== 'object') return;
        peer.state = msg.state;
        return broadcast(room, { t: 'presence', id: peer.id, state: msg.state }, peer.id);
      case 'signal': {
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
    if (--room.conns === 0) {
      saveRoom(room);
      room.doc.destroy();
      rooms.delete(room.id);
    }
  });
});

// keep NATs/proxies from dropping idle sockets
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000).unref();

function shutdown() {
  for (const room of rooms.values()) saveRoom(room);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const HOST = process.env.HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`WeMake server on http://${HOST}:${PORT}`));
