// Session passwords. Only a salted scrypt hash is stored (beside the room file,
// never inside the shared document). Successful logins get a random token that
// authorises the audio endpoints for that room.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface Lock { salt: string; hash: string }

const MIN_LEN = 4;
const MAX_LEN = 128;
const FAIL_WINDOW_MS = 10 * 60_000;
const MAX_FAILS = 8;
const TOKEN_TTL_MS = 24 * 60 * 60_000;

export class Auth {
  private tokens = new Map<string, { room: string; exp: number }>();
  private fails = new Map<string, number[]>();

  constructor(private dir: string) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private file(room: string) { return path.join(this.dir, `${room.toLowerCase()}.auth.json`); }

  private read(room: string): Lock | null {
    try { return JSON.parse(fs.readFileSync(this.file(room), 'utf8')); } catch { return null; }
  }

  isLocked(room: string) { return fs.existsSync(this.file(room)); }

  static validate(password: unknown): string | null {
    if (typeof password !== 'string') return 'Password must be text';
    if (password.length < MIN_LEN) return `Password must be at least ${MIN_LEN} characters`;
    if (password.length > MAX_LEN) return 'Password is too long';
    return null;
  }

  setPassword(room: string, password: string | null) {
    const f = this.file(room);
    if (password == null) { fs.rmSync(f, { force: true }); return; }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    fs.writeFileSync(f, JSON.stringify({ salt, hash }), { mode: 0o600 });
  }

  /** Too many wrong guesses from this address for this room recently? */
  throttled(room: string, ip: string) {
    const now = Date.now();
    const list = (this.fails.get(`${room}|${ip}`) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    return list.length >= MAX_FAILS;
  }

  check(room: string, ip: string, password: unknown): boolean {
    const lock = this.read(room);
    if (!lock) return true;
    const key = `${room}|${ip}`;
    const ok = typeof password === 'string' && password.length <= MAX_LEN &&
      crypto.timingSafeEqual(crypto.scryptSync(password, lock.salt, 32), Buffer.from(lock.hash, 'hex'));
    if (!ok) this.fails.set(key, [...(this.fails.get(key) ?? []), Date.now()]);
    else this.fails.delete(key);
    return ok;
  }

  issueToken(room: string) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, { room: room.toLowerCase(), exp: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  tokenValid(room: string, token: string | undefined) {
    if (!token) return false;
    const t = this.tokens.get(token);
    return !!t && t.room === room.toLowerCase() && t.exp > Date.now();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.tokens) if (v.exp < now) this.tokens.delete(k);
    for (const [k, v] of this.fails) { const keep = v.filter((t) => now - t < FAIL_WINDOW_MS); if (keep.length) this.fails.set(k, keep); else this.fails.delete(k); }
  }
}
