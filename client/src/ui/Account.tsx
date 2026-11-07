import { useEffect, useState } from 'react';
import * as account from '../net/account';
import { useUser, type Song } from '../net/account';

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/** Sign in / create account, or the signed-in user's menu. Lives in the lobby's top-right corner. */
export function AccountCorner() {
  const [user] = useUser();
  const [mode, setMode] = useState<null | 'login' | 'signup'>(null);
  const [menu, setMenu] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) {
    return (
      <div className="account-corner menu-wrap">
        <button className="ghost account-me" onClick={() => setMenu(!menu)} aria-expanded={menu}>
          <span className="avatar" aria-hidden>{user.username[0]?.toUpperCase()}</span>{user.username} ▾
        </button>
        {menu && (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => void account.logout().catch(() => {})}>Sign out</button>
          </div>
        )}
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') await account.signup(username.trim(), password, code.trim());
      else await account.login(username.trim(), password);
      setMode(null);
      setPassword('');
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-corner">
      <div className="row">
        <button className={mode === 'login' ? 'on' : 'ghost'} onClick={() => { setMode(mode === 'login' ? null : 'login'); setError(''); }}>Sign in</button>
        <button className={mode === 'signup' ? 'on' : 'ghost'} onClick={() => { setMode(mode === 'signup' ? null : 'signup'); setError(''); }}>Create account</button>
      </div>
      {mode && (
        <form className="account-form" onSubmit={submit}>
          <label>Username
            <input autoFocus value={username} autoComplete="username" maxLength={32} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>Password
            <input type="password" value={password} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} maxLength={128} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {mode === 'signup' && (
            <label>Invite code
              <input value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} />
            </label>
          )}
          {mode === 'signup' && <p className="muted small">3–32 letters, numbers, _ or - · password 8+ characters. Ask Ben for the invite code.</p>}
          {error && <div className="lobby-error" role="alert">{error}</div>}
          <button className="primary" disabled={busy || !username.trim() || !password}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
        </form>
      )}
    </div>
  );
}

/** The signed-in user's songs, newest first. */
export function MySongs({ onOpen }: { onOpen: (room: string) => void }) {
  const [user] = useUser();
  const [list, setList] = useState<Song[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!user) { setList(null); return; }
    let live = true;
    account.songs().then((s) => { if (live) setList(s); }, (e) => { if (live) setError(String(e.message ?? e)); });
    return () => { live = false; };
  }, [user]);
  if (!user) return null;
  const remove = async (room: string) => {
    setList((l) => l?.filter((s) => s.room !== room) ?? null);
    try { await account.removeSong(room); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="my-songs lobby-card" aria-label="My songs">
      <h3>My songs</h3>
      {error && <div className="lobby-error">{error}</div>}
      {list && list.length === 0 && <p className="muted">Songs you start or join while signed in show up here.</p>}
      {list === null && !error && <p className="muted">Loading…</p>}
      <ul>
        {list?.map((s) => (
          <li key={s.room}>
            <button className="ghost song-open" onClick={() => onOpen(s.room)} title={`Open ${s.room}`}>
              <span className="song-title">{s.title || s.room}</span>
              <span className="muted small">{s.role === 'owner' ? 'yours' : 'joined'} · {ago(s.last_opened_at)}</span>
            </button>
            <button className="ghost small" onClick={() => void remove(s.room)} title="Remove from my list (the song itself stays)" aria-label={`Remove ${s.title || s.room} from my list`}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Small "signed in as" chip for the studio top bar. */
export function AccountChip() {
  const [user] = useUser();
  return (
    <span className="account-chip" title={user ? `Signed in as ${user.username}` : 'Not signed in. Sign in from the start page to keep a list of your songs and sounds.'}>
      <span className="avatar" aria-hidden>{user ? user.username[0]?.toUpperCase() : '?'}</span>
      {user ? user.username : 'Guest'}
    </span>
  );
}
