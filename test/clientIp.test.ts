import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, normalizeIp, parseTrust } from '../server/clientIp.ts';

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as any;
const DEFAULT = parseTrust(undefined);
const LOOPBACK_ONLY = parseTrust('loopback');

test('direct connection uses the socket address', () => {
  assert.equal(clientIp(req('203.0.113.7'), DEFAULT), '203.0.113.7');
  assert.equal(clientIp(req('::ffff:203.0.113.7'), DEFAULT), '203.0.113.7');
});

test('Docker gateway peer with CF-Connecting-IP', () => {
  const r = req('::ffff:172.18.0.1', { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '1.1.1.1, 198.51.100.20' });
  assert.equal(clientIp(r, DEFAULT), '198.51.100.20');
});

test('Docker gateway peer with a spoofed leftmost X-Forwarded-For', () => {
  // client sent "X-Forwarded-For: 6.6.6.6"; nginx appended the real peer, then the request came via 127.0.0.1
  const r = req('172.17.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.30, 127.0.0.1' });
  assert.equal(clientIp(r, DEFAULT), '198.51.100.30');
});

test('untrusted peer: headers are ignored', () => {
  const r = req('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' });
  assert.equal(clientIp(r, DEFAULT), '203.0.113.9');
});

test('TRUSTED_PROXIES=loopback does not trust the Docker bridge', () => {
  const r = req('172.18.0.1', { 'cf-connecting-ip': '198.51.100.20' });
  assert.equal(clientIp(r, LOOPBACK_ONLY), '172.18.0.1');
  assert.equal(clientIp(req('::1', { 'cf-connecting-ip': '198.51.100.20' }), LOOPBACK_ONLY), '198.51.100.20');
});

test('all-private forwarding chain falls back to the originating LAN address', () => {
  const r = req('172.18.0.1', { 'x-forwarded-for': '192.168.1.50, 127.0.0.1' });
  assert.equal(clientIp(r, DEFAULT), '192.168.1.50');
});

test('garbage headers are ignored', () => {
  const r = req('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'nope' });
  assert.equal(clientIp(r, DEFAULT), '127.0.0.1');
});

test('normalizeIp', () => {
  assert.equal(normalizeIp(' ::FFFF:10.0.0.1 '), '10.0.0.1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
});
