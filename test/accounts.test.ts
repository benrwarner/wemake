import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../server/db.ts';
import { Accounts, Limiter, validatePassword, validateUsername } from '../server/accounts.ts';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wemake-acc-'));
  const db = new Db(path.join(dir, 'wemake.db'));
  return { dir, db, acc: new Accounts(db) };
}

test('signup then login works; wrong password and unknown user both return null', () => {
  const { acc, db } = setup();
  const u = acc.signup('ana', 'correct horse');
  assert.ok('id' in u);
  assert.equal(u.username, 'ana');
  assert.deepEqual(acc.login('ANA', 'correct horse'), { id: u.id, username: 'ana' });
  assert.equal(acc.login('ana', 'wrong password'), null);
  assert.equal(acc.login('nobody', 'correct horse'), null);
  db.close();
});

test('usernames are case-insensitive unique', () => {
  const { acc, db } = setup();
  acc.signup('Ana', 'password1');
  assert.deepEqual(acc.signup('ana', 'password2'), { error: 'That username is taken' });
  db.close();
});

test("validateUsername rejects 'ab', 'a b', 'x'.repeat(33); validatePassword rejects 'short'", () => {
  for (const bad of ['ab', 'a b', 'x'.repeat(33), 42, undefined]) assert.equal(typeof validateUsername(bad), 'string');
  assert.equal(validateUsername('ok_name-1'), null);
  assert.equal(typeof validatePassword('short'), 'string');
  assert.equal(typeof validatePassword('x'.repeat(129)), 'string');
  assert.equal(validatePassword('longenough'), null);
});

test('session token is not stored raw', () => {
  const { acc, db } = setup();
  const u = acc.signup('ben', 'password1') as { id: number; username: string };
  const token = acc.createSession(u.id);
  const rows = db.sql.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.ok(!rows[0].token_hash.includes(token));
  assert.deepEqual(acc.userForToken(token), { id: u.id, username: 'ben' });
  assert.equal(acc.userForToken('nope'), null);
  assert.equal(acc.userForToken(undefined), null);
  acc.logout(token);
  assert.equal(acc.userForToken(token), null);
  db.close();
});

test('expired session returns null', () => {
  const { acc, db } = setup();
  const u = acc.signup('ben', 'password1') as { id: number };
  const token = acc.createSession(u.id);
  db.sql.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
  assert.equal(acc.userForToken(token), null);
  acc.sweep();
  assert.equal((db.sql.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n, 0);
  db.close();
});

test('deleteUser cascades sessions, user_rooms and sounds', () => {
  const { acc, db } = setup();
  const u = acc.signup('ben', 'password1') as { id: number };
  acc.createSession(u.id);
  db.sql.prepare("INSERT INTO user_rooms (user_id, room, role, last_opened_at) VALUES (?, 'r1', 'owner', 0)").run(u.id);
  db.sql
    .prepare("INSERT INTO sounds (id, user_id, name, kind, plugin_type, params_json, created_at) VALUES ('s1', ?, 'n', 'fx', 'reverb', '{}', 0)")
    .run(u.id);
  assert.equal(acc.deleteUser('BEN'), true);
  assert.equal(acc.deleteUser('ben'), false);
  for (const t of ['sessions', 'user_rooms', 'sounds']) {
    assert.equal((db.sql.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 0, t);
  }
  db.close();
});

test('resetPassword returns a new password that logs in; old one fails', () => {
  const { acc, db } = setup();
  const u = acc.signup('ben', 'password1') as { id: number };
  const token = acc.createSession(u.id);
  const pw = acc.resetPassword('ben');
  assert.ok(pw && pw.length >= 12);
  assert.equal(acc.login('ben', 'password1'), null);
  assert.ok(acc.login('ben', pw!));
  assert.equal(acc.userForToken(token), null, 'reset signs out existing sessions');
  assert.equal(acc.resetPassword('ghost'), null);
  db.close();
});

test('listUsers lists usernames', () => {
  const { acc, db } = setup();
  acc.signup('b', 'x');
  acc.signup('bob', 'password1');
  acc.signup('amy', 'password1');
  assert.deepEqual(
    acc.listUsers().map((u) => u.username),
    ['amy', 'bob'],
  );
  db.close();
});

test('two Db handles on one file can both write', () => {
  const { dir, db, acc } = setup();
  const db2 = new Db(path.join(dir, 'wemake.db'));
  const acc2 = new Accounts(db2);
  assert.ok('id' in acc.signup('one', 'password1'));
  assert.ok('id' in acc2.signup('two', 'password1'));
  assert.equal(acc.listUsers().length, 2);
  db.close();
  db2.close();
});

test('backup writes wemake-YYYYMMDD.db and keeps only 7', () => {
  const { dir, db, acc } = setup();
  acc.signup('ben', 'password1');
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(bdir, `wemake-2020010${i}.db`), 'old');
  fs.writeFileSync(path.join(bdir, 'unrelated.txt'), 'keep me');
  const out = db.backup(bdir);
  assert.match(path.basename(out), /^wemake-\d{8}\.db$/);
  const files = fs.readdirSync(bdir).filter((f) => /^wemake-\d{8}\.db$/.test(f)).sort();
  assert.equal(files.length, 7);
  assert.equal(files[files.length - 1], path.basename(out));
  assert.ok(fs.existsSync(path.join(bdir, 'unrelated.txt')));
  const copy = new Db(out);
  assert.equal(new Accounts(copy).listUsers().length, 1);
  copy.close();
  // running twice on the same day overwrites rather than failing
  db.backup(bdir);
  db.close();
});

test('Limiter blocks after max fails and clears', () => {
  const l = new Limiter(3, 60_000);
  assert.equal(l.blocked('k'), false);
  l.fail('k');
  l.fail('k');
  assert.equal(l.blocked('k'), false);
  l.fail('k');
  assert.equal(l.blocked('k'), true);
  assert.equal(l.blocked('other'), false);
  l.clear('k');
  assert.equal(l.blocked('k'), false);
});
