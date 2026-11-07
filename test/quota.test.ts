import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quota } from '../server/quota.ts';

function setup(limit = 1000) {
  const bytes: Record<string, number> = { a: 300, b: 200, guest: 5000 };
  const owners: Record<string, number> = { a: 1, b: 1 };
  const q = new Quota({
    limitBytes: limit,
    ownerOf: (r) => owners[r] ?? null,
    ownedRooms: (u) => Object.keys(owners).filter((r) => owners[r] === u),
    roomBytes: (r) => bytes[r] ?? 0,
  });
  return { q, bytes };
}

test('usage sums every song the account started', () => {
  assert.equal(setup().q.used(1), 500);
  assert.equal(setup().q.used(2), 0);
});

test('uploads past the cap are refused; guest songs are not capped', () => {
  const { q } = setup();
  assert.equal(q.reserve('a', 501, 10_000), null);
  const ok = q.reserve('a', 500, 10_000);
  assert.ok(ok);
  assert.equal(ok.maxBytes, 500);
  assert.equal(q.reserve('guest', 1e9, 2e9)?.maxBytes, 2e9);
});

test('reservations hold space for parallel uploads until released, once', () => {
  const { q } = setup();
  const r1 = q.reserve('a', 400, 10_000)!;
  assert.equal(q.used(1), 900);
  assert.equal(q.reserve('b', 200, 10_000), null, 'the in-flight upload counts');
  r1.release();
  r1.release();
  assert.equal(q.used(1), 500);
  // unknown size holds everything that is left
  const r2 = q.reserve('b', 0, 10_000)!;
  assert.equal(r2.maxBytes, 500);
  assert.equal(q.reserve('a', 1, 10_000), null);
  r2.release();
  assert.ok(q.reserve('a', 1, 10_000));
});

test('the max upload size still caps a reservation', () => {
  assert.equal(setup().q.reserve('a', 0, 100)?.maxBytes, 100);
});
