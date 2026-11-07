// Saved sounds: an instrument or effect with its settings, stored per user.
import crypto from 'node:crypto';
import type { Db } from './db.ts';

export interface SavedSound {
  id: string;
  name: string;
  kind: 'fx' | 'instrument';
  plugin_type: string;
  params: Record<string, number>;
  created_at: number;
}

export const MAX_SOUNDS = 500;
const MAX_PARAMS_BYTES = 16384;

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return name.length >= 1 && name.length <= 64 ? name : null;
}

export class Sounds {
  constructor(private db: Db) {}

  list(userId: number): SavedSound[] {
    const rows = this.db.sql
      .prepare('SELECT id, name, kind, plugin_type, params_json, created_at FROM sounds WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(userId) as { id: string; name: string; kind: 'fx' | 'instrument'; plugin_type: string; params_json: string; created_at: number }[];
    return rows.map(({ params_json, ...r }) => ({ ...r, params: JSON.parse(params_json) }));
  }

  add(userId: number, s: { name?: unknown; kind?: unknown; plugin_type?: unknown; params?: unknown }): SavedSound | { error: string } {
    const name = cleanName(s.name);
    if (!name) return { error: 'Names are 1–64 characters' };
    if (s.kind !== 'fx' && s.kind !== 'instrument') return { error: 'Unknown sound kind' };
    if (typeof s.plugin_type !== 'string' || !s.plugin_type || s.plugin_type.length > 2048) return { error: 'Unknown plugin' };
    const p = s.params;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'Settings must be numbers' };
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'Settings must be numbers' };
      params[k] = v;
    }
    const params_json = JSON.stringify(params);
    if (Buffer.byteLength(params_json) > MAX_PARAMS_BYTES) return { error: 'Too many settings to save' };
    const n = (this.db.sql.prepare('SELECT COUNT(*) n FROM sounds WHERE user_id = ?').get(userId) as { n: number }).n;
    if (n >= MAX_SOUNDS) return { error: `You can save up to ${MAX_SOUNDS} sounds` };
    const sound: SavedSound = { id: crypto.randomBytes(9).toString('base64url'), name, kind: s.kind, plugin_type: s.plugin_type, params, created_at: Date.now() };
    this.db.sql
      .prepare('INSERT INTO sounds (id, user_id, name, kind, plugin_type, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sound.id, userId, name, sound.kind, sound.plugin_type, params_json, sound.created_at);
    return sound;
  }

  /** true = renamed, false = no such sound for this user, 'invalid' = bad name. */
  rename(userId: number, id: string, name: unknown): boolean | 'invalid' {
    const clean = cleanName(name);
    if (!clean) return 'invalid';
    return Number(this.db.sql.prepare('UPDATE sounds SET name = ? WHERE id = ? AND user_id = ?').run(clean, id, userId).changes) > 0;
  }

  remove(userId: number, id: string): boolean {
    return Number(this.db.sql.prepare('DELETE FROM sounds WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }
}
