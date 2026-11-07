// SQLite store for accounts, "My songs" and saved sounds. One file in DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  // v1
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pass_salt TEXT NOT NULL,
     pass_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE user_rooms (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     room TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
     title TEXT,
     last_opened_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, room)
   );
   CREATE INDEX user_rooms_room ON user_rooms(room);
   CREATE TABLE sounds (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('fx', 'instrument')),
     plugin_type TEXT NOT NULL,
     params_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX sounds_user ON sounds(user_id);`,
  // v2: who started each song; its takes count against that account's storage cap.
  // Kept apart from user_rooms so removing a song from "My songs" doesn't free its storage.
  `CREATE TABLE room_owners (
     room TEXT PRIMARY KEY,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX room_owners_user ON room_owners(user_id);
   INSERT OR IGNORE INTO room_owners (room, user_id, created_at)
     SELECT room, user_id, last_opened_at FROM user_rooms WHERE role = 'owner';`,
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const { user_version: v } = this.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.sql.exec('BEGIN IMMEDIATE');
      try {
        // re-check under the write lock: another process may have migrated meanwhile
        const cur = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (cur <= i) {
          this.sql.exec(MIGRATIONS[i]);
          this.sql.exec(`PRAGMA user_version = ${i + 1}`);
        }
        this.sql.exec('COMMIT');
      } catch (err) {
        this.sql.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** Consistent snapshot to `dir/wemake-YYYYMMDD.db`; keeps the newest `keep`. Returns the path. */
  backup(dir: string, keep = 7): string {
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const out = path.join(dir, `wemake-${stamp}.db`);
    const tmp = `${out}.tmp`;
    fs.rmSync(tmp, { force: true });
    this.sql.prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, out);
    const old = fs
      .readdirSync(dir)
      .filter((f) => /^wemake-\d{8}\.db$/.test(f))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return out;
  }

  close() {
    this.sql.close();
  }
}
