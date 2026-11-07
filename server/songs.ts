// "My songs": which sessions each signed-in user has started or joined.
import type { Db } from './db.ts';

export interface SongRow {
  room: string;
  role: 'owner' | 'member';
  title: string | null;
  last_opened_at: number;
}

export class Songs {
  constructor(private db: Db) {}

  /** Records a visit. An owner is never downgraded to member. */
  touch(userId: number, room: string, role: 'owner' | 'member'): void {
    this.db.sql
      .prepare(
        `INSERT INTO user_rooms (user_id, room, role, title, last_opened_at)
         VALUES (?, ?, ?, (SELECT title FROM user_rooms WHERE room = ? AND title IS NOT NULL LIMIT 1), ?)
         ON CONFLICT (user_id, room) DO UPDATE SET
           last_opened_at = excluded.last_opened_at,
           role = CASE WHEN user_rooms.role = 'owner' THEN 'owner' ELSE excluded.role END`,
      )
      .run(userId, room, role, room, Date.now());
  }

  /** Records who started a song (first one wins). */
  setOwner(room: string, userId: number): void {
    this.db.sql.prepare('INSERT OR IGNORE INTO room_owners (room, user_id, created_at) VALUES (?, ?, ?)').run(room, userId, Date.now());
  }

  /** The account a song's storage counts against, if it was started by a signed-in user. */
  ownerOf(room: string): number | null {
    const r = this.db.sql.prepare('SELECT user_id FROM room_owners WHERE room = ?').get(room) as { user_id: number | null } | undefined;
    return r?.user_id ?? null;
  }

  ownedRooms(userId: number): string[] {
    return (this.db.sql.prepare('SELECT room FROM room_owners WHERE user_id = ?').all(userId) as { room: string }[]).map((r) => r.room);
  }

  setTitle(room: string, title: string): void {
    this.db.sql.prepare('UPDATE user_rooms SET title = ? WHERE room = ? AND title IS NOT ?').run(title.slice(0, 120), room, title.slice(0, 120));
  }

  list(userId: number): SongRow[] {
    return this.db.sql
      .prepare('SELECT room, role, title, last_opened_at FROM user_rooms WHERE user_id = ? ORDER BY last_opened_at DESC LIMIT 500')
      .all(userId) as unknown as SongRow[];
  }

  isOwner(userId: number, room: string): boolean {
    return !!this.db.sql.prepare("SELECT 1 FROM user_rooms WHERE user_id = ? AND room = ? AND role = 'owner'").get(userId, room);
  }

  /** After a password change: forget the song for members who aren't in the room right now. */
  dropAbsentMembers(room: string, presentUserIds: number[]): void {
    const keep = presentUserIds.filter(Number.isInteger);
    const notPresent = keep.length ? ` AND user_id NOT IN (${keep.map(() => '?').join(',')})` : '';
    this.db.sql.prepare(`DELETE FROM user_rooms WHERE room = ? AND role = 'member'${notPresent}`).run(room, ...keep);
  }

  remove(userId: number, room: string): void {
    this.db.sql.prepare('DELETE FROM user_rooms WHERE user_id = ? AND room = ?').run(userId, room);
  }
}
