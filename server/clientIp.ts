// Works out the real client address when WeMake sits behind proxies
// (Docker's port proxy, nginx, cloudflared, tailscale serve).
import type http from 'node:http';
import net from 'node:net';

export type TrustSpec = 'loopback' | 'private';

/** `::ffff:1.2.3.4` → `1.2.3.4`; trims whitespace and IPv6 zone ids. */
export function normalizeIp(ip: string): string {
  let s = ip.trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']')); // [::1]:port
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

function ipv4Octets(ip: string): number[] | null {
  if (net.isIPv4(ip)) return ip.split('.').map(Number);
  return null;
}

export function isLoopback(raw: string): boolean {
  const ip = normalizeIp(raw);
  const v4 = ipv4Octets(ip);
  if (v4) return v4[0] === 127;
  return ip === '::1';
}

/** RFC 1918 ranges (Docker bridge networks live in 172.16.0.0/12) plus IPv6 ULA fc00::/7. */
export function isPrivate(raw: string): boolean {
  const ip = normalizeIp(raw);
  const v4 = ipv4Octets(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIPv6(ip) && /^f[cd]/i.test(ip);
}

export function parseTrust(spec: string | undefined): Set<TrustSpec> {
  const out = new Set<TrustSpec>();
  for (const part of (spec ?? 'loopback').split(',').map((s) => s.trim().toLowerCase())) {
    if (part === 'loopback' || part === 'private') out.add(part);
    else if (part && part !== 'none') console.warn(`TRUSTED_PROXIES: ignoring unknown entry "${part}"`);
  }
  return out;
}

export function isTrustedProxy(ip: string, trust: Set<TrustSpec>): boolean {
  return (trust.has('loopback') && isLoopback(ip)) || (trust.has('private') && isPrivate(ip));
}

function header(req: Pick<http.IncomingMessage, 'headers'>, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
}

/**
 * Client address for rate limiting.
 * - Socket peer not a trusted proxy → its address; headers ignored.
 * - Trusted peer → CF-Connecting-IP (Cloudflare overwrites any client-sent value),
 *   else X-Forwarded-For walked from the right, returning the first untrusted hop.
 *   The leftmost entries are client-controlled and are never used.
 * Caveat: any client that can reach the app through a trusted peer *without* passing Cloudflare
 * (e.g. via tailscale serve, or nginx listening on the LAN) can choose its CF-Connecting-IP.
 * Keep the published port on 127.0.0.1 and nginx on 127.0.0.1 so only cloudflared and tailnet
 * devices have that path, or set TRUSTED_PROXIES=loopback / none if that's not acceptable.
 */
export function clientIp(req: Pick<http.IncomingMessage, 'headers' | 'socket'>, trust: Set<TrustSpec>): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? '');
  if (!isTrustedProxy(remote, trust)) return remote;

  const cf = header(req, 'cf-connecting-ip');
  if (cf && net.isIP(normalizeIp(cf))) return normalizeIp(cf);

  const xff = header(req, 'x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map(normalizeIp).filter((h) => net.isIP(h));
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(hops[i], trust)) return hops[i];
    }
    // Every hop is a private address (client on the LAN). Use the entry our nearest proxy appended;
    // anything left of it is client-controlled and would let one client rotate rate-limit buckets.
    if (hops.length) return hops[hops.length - 1];
  }
  return remote;
}
