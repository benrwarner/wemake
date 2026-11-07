// Username/password accounts and login sessions.
import crypto from 'node:crypto';
import type { Db } from './db.ts';

export type User = { id: number; username: string };

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
const SESSION_MS = 30 * 24 * 3600_000;
const SLIDE_MS = 24 * 3600_000;

export function validateUsername(u: unknown): string | null {
  if (typeof u !== 'string' || !/^[a-z0-9_-]{3,32}$/.test(u.toLowerCase())) {
    return 'Usernames are 3–32 characters: letters, numbers, _ or -';
  }
  return null;
}

export function validatePassword(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < 8 || p.length > 128) return 'Passwords are 8–128 characters';
  return null;
}

// Async so hashing runs on the libuv thread pool instead of stalling realtime sessions.
function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Used when the username doesn't exist, so a miss costs the same scrypt time as a hit.
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_HASH = crypto.scryptSync('not-a-real-password', DUMMY_SALT, KEYLEN, SCRYPT);

export class Accounts {
  constructor(private db: Db) {}

  async signup(username: string, password: string): Promise<User | { error: string }> {
    const bad = validateUsername(username) ?? validatePassword(password);
    if (bad) return { error: bad };
    const name = username.toLowerCase();
    const salt = crypto.randomBytes(16);
    const hash = await hashPassword(password, salt);
    try {
      const r = this.db.sql
        .prepare('INSERT INTO users (username, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(name, salt.toString('hex'), hash.toString('hex'), Date.now());
      return { id: Number(r.lastInsertRowid), username: name };
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) return { error: 'That username is taken' };
      throw err;
    }
  }

  async login(username: string, password: string): Promise<User | null> {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) return null;
    const row = this.db.sql
      .prepare('SELECT id, username, pass_salt, pass_hash FROM users WHERE username = ?')
      .get(username.toLowerCase()) as { id: number; username: string; pass_salt: string; pass_hash: string } | undefined;
    const salt = row ? Buffer.from(row.pass_salt, 'hex') : DUMMY_SALT;
    const expected = row ? Buffer.from(row.pass_hash, 'hex') : DUMMY_HASH;
    const ok = crypto.timingSafeEqual(await hashPassword(password, salt), expected);
    return row && ok ? { id: row.id, username: row.username } : null;
  }

  createSession(userId: number): string {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.sql
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, now, now + SESSION_MS, now);
    return token;
  }

  /** The signed-in user for a raw cookie token; slides the expiry at most once a day. */
  userForToken(token: string | undefined): User | null {
    if (!token || token.length > 256) return null;
    const h = sha256(token);
    const now = Date.now();
    const row = this.db.sql
      .prepare(
        `SELECT u.id, u.username, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(h, now) as { id: number; username: string; last_seen_at: number } | undefined;
    if (!row) return null;
    if (now - row.last_seen_at > SLIDE_MS) {
      this.db.sql.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, now + SESSION_MS, h);
    }
    return { id: row.id, username: row.username };
  }

  logout(token: string): void {
    this.db.sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /** Sets a new random password, signs the user out everywhere, returns the password. */
  async resetPassword(username: string): Promise<string | null> {
    const row = this.db.sql.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase()) as { id: number } | undefined;
    if (!row) return null;
    const password = crypto.randomBytes(12).toString('base64url');
    const salt = crypto.randomBytes(16);
    this.db.sql
      .prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?')
      .run(salt.toString('hex'), (await hashPassword(password, salt)).toString('hex'), row.id);
    this.db.sql.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    return password;
  }

  deleteUser(username: string): boolean {
    return Number(this.db.sql.prepare('DELETE FROM users WHERE username = ?').run(username.toLowerCase()).changes) > 0;
  }

  listUsers(): { username: string; created_at: number }[] {
    return this.db.sql.prepare('SELECT username, created_at FROM users ORDER BY username').all() as {
      username: string;
      created_at: number;
    }[];
  }

  sweep(): void {
    this.db.sql.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
}

/** Counts failures per key in a fixed window. */
export class Limiter {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  blocked(key: string): boolean {
    const e = this.fails.get(key);
    if (!e) return false;
    if (Date.now() > e.until) {
      this.fails.delete(key);
      return false;
    }
    return e.n >= this.max;
  }

  fail(key: string): void {
    const now = Date.now();
    const e = this.fails.get(key);
    if (!e || now > e.until) this.fails.set(key, { n: 1, until: now + this.windowMs });
    else e.n++;
    if (this.fails.size > 10_000) {
      for (const [k, v] of this.fails) if (now > v.until) this.fails.delete(k);
    }
  }

  clear(key: string): void {
    this.fails.delete(key);
  }

  /** Takes back one fail() (used when an attempt reserved up front turns out to be good). */
  undo(key: string): void {
    const e = this.fails.get(key);
    if (e && --e.n <= 0) this.fails.delete(key);
  }
}
