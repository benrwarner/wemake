// Accounts, "My songs" and saved sounds (talks to /api/auth/* and /api/me*).
import { useEffect, useState } from 'react';

export type User = { id: number; username: string };
export type Song = { room: string; role: 'owner' | 'member'; title: string | null; last_opened_at: number };
export type SavedSound = {
  id: string;
  name: string;
  kind: 'fx' | 'instrument';
  plugin_type: string;
  params: Record<string, number>;
  created_at: number;
};

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

// ---- signed-in user store ----
let current: User | null = null;
let loaded = false;
const listeners = new Set<(u: User | null) => void>();
function setUser(u: User | null) {
  current = u;
  loaded = true;
  for (const l of listeners) l(u);
}

export async function me(): Promise<User | null> {
  try {
    const r = await call<{ user: User | null }>('GET', '/api/me');
    setUser(r.user);
  } catch {
    setUser(null);
  }
  return current;
}

/** [user, setUser]; fetches /api/me once per page load. */
export function useUser(): [User | null, (u: User | null) => void] {
  const [u, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    if (!loaded) { loaded = true; void me(); }
    return () => { listeners.delete(set); };
  }, []);
  return [u, setUser];
}

export async function signup(username: string, password: string, code: string): Promise<User> {
  const r = await call<{ user: User }>('POST', '/api/auth/signup', { username, password, code });
  setUser(r.user);
  return r.user;
}

export async function login(username: string, password: string): Promise<User> {
  const r = await call<{ user: User }>('POST', '/api/auth/login', { username, password });
  setUser(r.user);
  return r.user;
}

export async function logout(): Promise<void> {
  await call('POST', '/api/auth/logout', {});
  setUser(null);
}

export const songs = async () => (await call<{ songs: Song[] }>('GET', '/api/me/songs')).songs;
export const storage = () => call<{ used: number; limit: number | null }>('GET', '/api/me/storage');
export const removeSong = (room: string) => call<void>('DELETE', `/api/me/songs/${encodeURIComponent(room)}`);

export const sounds = async () => (await call<{ sounds: SavedSound[] }>('GET', '/api/me/sounds')).sounds;
export const saveSound = async (s: Pick<SavedSound, 'name' | 'kind' | 'plugin_type' | 'params'>) =>
  (await call<{ sound: SavedSound }>('POST', '/api/me/sounds', s)).sound;
export const renameSound = (id: string, name: string) => call<void>('PATCH', `/api/me/sounds/${encodeURIComponent(id)}`, { name });
export const deleteSound = (id: string) => call<void>('DELETE', `/api/me/sounds/${encodeURIComponent(id)}`);
