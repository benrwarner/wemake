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
  for (const part of (spec ?? 'loopback,private').split(',').map((s) => s.trim().toLowerCase())) {
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
 *   The leftmost entry is client-controlled, so it is only used when every hop is trusted.
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
    if (hops.length) return hops[0]; // every hop is a trusted (private) address: the origin is on the LAN
  }
  return remote;
}
