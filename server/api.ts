// JSON API for accounts, "My songs" and saved sounds (/api/auth/*, /api/me*).
import type http from 'node:http';
import { Limiter, type Accounts, type User } from './accounts.ts';
import type { Songs } from './songs.ts';

export const COOKIE = 'wm_session';
const MAX_AGE = 30 * 24 * 3600; // seconds

export interface ApiDeps {
  accounts: Accounts;
  songs: Songs;
  ip: (req: http.IncomingMessage) => string;
  allowedOrigins: string[];
  signupCode?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const hostOf = (req: Pick<http.IncomingMessage, 'headers'>) => String(req.headers.host ?? '').toLowerCase();
const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

/** Set-Cookie value for a session token; null clears the cookie. */
export function sessionCookie(token: string | null, req: Pick<http.IncomingMessage, 'headers'>): string {
  const attrs = [`${COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? MAX_AGE : 0}`];
  if (!isLocalHost(hostOf(req))) attrs.push('Secure');
  return attrs.join('; ');
}

/** True when the request's Origin is this site (same host) or explicitly allowed. */
export function originAllowed(req: Pick<http.IncomingMessage, 'headers'>, allowed: string[]): boolean {
  const origin = String(req.headers.origin ?? '').replace(/\/+$/, '').toLowerCase();
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === hostOf(req);
  } catch {
    return false;
  }
}

export function readJson(req: http.IncomingMessage, maxBytes = 32768): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function currentUser(req: Pick<http.IncomingMessage, 'headers'>, accounts: Accounts): User | null {
  return accounts.userForToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function send(res: http.ServerResponse, status: number, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const TOO_MANY = 'Too many attempts. Try again in 15 minutes.';
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export class Api {
  private ipLimit = new Limiter(10, 15 * 60_000);
  private userLimit = new Limiter(10, 15 * 60_000);

  constructor(private deps: ApiDeps) {}

  user(req: Pick<http.IncomingMessage, 'headers'>): User | null {
    return currentUser(req, this.deps.accounts);
  }

  /** Handles /api/auth/* and /api/me*; returns false for any other path. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith('/api/auth/') && p !== '/api/me' && !p.startsWith('/api/me/')) return false;
    try {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        if (!originAllowed(req, this.deps.allowedOrigins)) throw new HttpError(403, 'Cross-site request refused');
        if (method !== 'DELETE' && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
          throw new HttpError(415, 'Expected JSON');
        }
      }
      await this.route(req, res, method, p);
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error('api error', err);
        send(res, 500, { error: 'Something went wrong' });
      }
    }
    return true;
  }

  protected async route(req: http.IncomingMessage, res: http.ServerResponse, method: string, p: string): Promise<void> {
    const { accounts } = this.deps;
    if (p === '/api/me' && method === 'GET') return send(res, 200, { user: this.user(req) });

    if (p === '/api/auth/signup' && method === 'POST') {
      const ip = this.deps.ip(req);
      if (this.ipLimit.blocked(ip)) throw new HttpError(429, TOO_MANY);
      const body = (await readJson(req)) as Record<string, unknown>;
      if (!this.deps.signupCode) throw new HttpError(403, 'Sign-up is closed');
      if (str(body.code) !== this.deps.signupCode) {
        this.ipLimit.fail(ip);
        throw new HttpError(403, 'Wrong invite code');
      }
      const r = accounts.signup(str(body.username), str(body.password));
      if ('error' in r) throw new HttpError(r.error === 'That username is taken' ? 409 : 400, r.error);
      return send(res, 201, { user: r }, sessionCookie(accounts.createSession(r.id), req));
    }

    if (p === '/api/auth/login' && method === 'POST') {
      const ip = this.deps.ip(req);
      const body = (await readJson(req)) as Record<string, unknown>;
      const userKey = str(body.username).toLowerCase().slice(0, 64);
      if (this.ipLimit.blocked(ip) || this.userLimit.blocked(userKey)) throw new HttpError(429, TOO_MANY);
      const user = accounts.login(str(body.username), str(body.password));
      if (!user) {
        this.ipLimit.fail(ip);
        this.userLimit.fail(userKey);
        throw new HttpError(401, 'Wrong username or password');
      }
      this.userLimit.clear(userKey);
      return send(res, 200, { user }, sessionCookie(accounts.createSession(user.id), req));
    }

    if (p === '/api/auth/logout' && method === 'POST') {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) accounts.logout(token);
      return send(res, 204, undefined, sessionCookie(null, req));
    }

    if (p === '/api/me/songs' || p.startsWith('/api/me/songs/')) {
      const user = this.requireUser(req);
      if (p === '/api/me/songs' && method === 'GET') return send(res, 200, { songs: this.deps.songs.list(user.id) });
      const room = decodeURIComponent(p.slice('/api/me/songs/'.length));
      if (method === 'DELETE' && room) {
        if (!ROOM_RE.test(room)) throw new HttpError(400, 'Bad song id');
        this.deps.songs.remove(user.id, room.toLowerCase());
        return send(res, 204);
      }
    }

    throw new HttpError(404, 'Not found');
  }

  private requireUser(req: http.IncomingMessage): User {
    const user = this.user(req);
    if (!user) throw new HttpError(401, 'Sign in first');
    return user;
  }
}

export { HttpError, send as sendJson };
