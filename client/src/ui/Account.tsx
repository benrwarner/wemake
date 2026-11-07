import { useEffect, useState } from 'react';
import * as account from '../net/account';
import { useUser, type Song } from '../net/account';
import { Icon } from './Icon';

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
          <span className="avatar" aria-hidden>{user.username[0]?.toUpperCase()}</span>{user.username}<Icon name="chevron" size={14} />
        </button>
        {menu && (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => void account.logout().catch(() => {})}><Icon name="logout" />Sign out</button>
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
      <div className="row tight">
        <button className={mode === 'login' ? 'on' : 'ghost'} onClick={() => { setMode(mode === 'login' ? null : 'login'); setError(''); }}>Sign in</button>
        <button className={mode === 'signup' ? 'on' : 'ghost'} onClick={() => { setMode(mode === 'signup' ? null : 'signup'); setError(''); }}>Create account</button>
      </div>
      {mode && (
        <form className="account-form popover" onSubmit={submit}>
          <h3>{mode === 'signup' ? 'Create an account' : 'Welcome back'}</h3>
          <p className="muted small">{mode === 'signup' ? 'Keep a list of your songs and save sounds to reuse.' : 'Sign in to see your songs and saved sounds.'}</p>
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

const gb = (b: number) => (b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1).replace(/\.0+$/, '');

/** The signed-in user's songs, newest first. */
export function MySongs({ onOpen }: { onOpen: (room: string) => void }) {
  const [user] = useUser();
  const [list, setList] = useState<Song[] | null>(null);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<{ used: number; limit: number | null } | null>(null);
  useEffect(() => {
    if (!user) { setList(null); setUsage(null); return; }
    let live = true;
    account.songs().then((s) => { if (live) setList(s); }, (e) => { if (live) setError(String(e.message ?? e)); });
    account.storage().then((u) => { if (live) setUsage(u); }, () => {});
    return () => { live = false; };
  }, [user]);
  if (!user) return null;
  const remove = async (room: string) => {
    setList((l) => l?.filter((s) => s.room !== room) ?? null);
    try { await account.removeSong(room); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="my-songs lobby-card" aria-label="My songs">
      <h3>My songs {list && list.length > 0 && <span className="count">{list.length}</span>}</h3>
      {error && <div className="lobby-error">{error}</div>}
      {list && list.length === 0 && <p className="muted">Songs you start or join while signed in show up here.</p>}
      {list === null && !error && <p className="muted">Loading…</p>}
      <ul>
        {list?.map((s) => (
          <li key={s.room}>
            <button className="ghost song-open" onClick={() => onOpen(s.room)} title={`Open ${s.room}`}>
              <span className="song-icon" aria-hidden><Icon name="music" size={15} /></span>
              <span className="song-title">{s.title || s.room}</span>
              <span className="song-meta muted small">{s.role === 'owner' ? 'Started by you' : 'Joined'}, {ago(s.last_opened_at)}</span>
            </button>
            <button className="icon-btn subtle" onClick={() => void remove(s.room)} title="Remove from my list (the song itself stays)" aria-label={`Remove ${s.title || s.room} from my list`}><Icon name="x" size={14} /></button>
          </li>
        ))}
      </ul>
      {usage?.limit && (
        <p className="muted small storage-use" title="Recorded takes in songs you started count toward this.">
          {gb(usage.used)} of {gb(usage.limit)} GB used{usage.used >= usage.limit ? ' — full, new takes in your songs won’t save' : ''}
        </p>
      )}
    </section>
  );
}

/** Small "signed in as" chip for the studio top bar. */
export function AccountChip() {
  const [user] = useUser();
  return (
    <span className="account-chip" title={user ? `Signed in as ${user.username}` : 'Not signed in. Sign in from the start page to keep a list of your songs and sounds.'}>
      <span className="avatar" aria-hidden>{user ? user.username[0]?.toUpperCase() : '?'}</span>
      <span className="chip-name">{user ? user.username : 'Guest'}</span>
    </span>
  );
}
