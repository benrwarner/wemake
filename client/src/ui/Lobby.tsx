import { useEffect, useState } from 'react';
import { useUser } from '../net/account';
import { AccountCorner, MySongs } from './Account';
import { TRACK_COLORS } from '../../../shared/model';
import { Icon } from './Icon';
import { Appearance } from './Appearance';
import { applyTheme, tintTheme, useTheme } from '../theme/theme';
import { WAVE } from '../theme/logo';

const WORDS = ['velvet', 'neon', 'echo', 'groove', 'lunar', 'amber', 'static', 'honey', 'cobalt', 'drift', 'fuzz', 'tidal'];
// Session names double as the access secret, so the random part carries 64 bits of entropy.
function randomRoom() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  const word = (i: number) => WORDS[b[i] % WORDS.length];
  const secret = Array.from(b.slice(2), (x) => x.toString(36).padStart(2, '0')).join('');
  return `${word(0)}-${word(1)}-${secret}`;
}

function load(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* */ } }

export function Lobby({ onJoin, error }: { onJoin: (room: string, name: string, color: string, password: string) => void; error?: string }) {
  const fromUrl = new URLSearchParams(location.search).get('room') ?? '';
  const [room, setRoom] = useState(fromUrl || randomRoom());
  const [name, setName] = useState(load('wemake.name', ''));
  const [password, setPassword] = useState('');
  const [color, setColor] = useState(load('wemake.color', TRACK_COLORS[Math.floor(Math.random() * TRACK_COLORS.length)]));
  const [user] = useUser();
  const [appearance, setAppearance] = useState(false);
  useEffect(() => { if (user) setName((n) => n || user.username); }, [user]);
  // the landing page takes on the chosen colour (accent + background hue); the studio gets the saved theme back
  const { theme } = useTheme();
  useEffect(() => { applyTheme(tintTheme(theme, color)); }, [theme, color]);
  useEffect(() => () => applyTheme(), []);
  const clean = room.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  // audioWorklet and getUserMedia only exist on secure origins (https:// or localhost)
  const insecure = !window.isSecureContext;
  const ok = !insecure && clean.length > 0 && name.trim().length > 0;
  const join = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    save('wemake.name', name.trim()); save('wemake.color', color);
    onJoin(clean, name.trim(), color, password);
  };
  const open = (r: string) => {
    if (insecure) return;
    const who = name.trim() || user?.username || 'Guest';
    save('wemake.name', who); save('wemake.color', color);
    onJoin(r, who, color, '');
  };
  return (
    <div className="lobby">
      <header className="lobby-top">
        <div className="brand" role="img" aria-label="WeMake"><BrandMark /></div>
        <div className="lobby-corner">
          <button className="ghost" onClick={() => setAppearance(true)} aria-expanded={appearance} aria-label="Appearance"><Icon name="palette" /><span className="btn-label">Appearance</span></button>
          <AccountCorner />
        </div>
      </header>
      <main className="lobby-main">
        <section className="lobby-hero" aria-labelledby="lobby-title">
          <h1 id="lobby-title">{fromUrl ? 'You\'re invited to a session.' : 'Make music with friends, in real time.'}</h1>
          <p className="lobby-tag">Everyone hears the same song, plays live and records takes into one shared session, right in the browser.</p>
          <Levels color={color} />
          <ul className="lobby-facts">
            <li><Icon name="headphones" /><span><b>Wear headphones.</b> Speakers feed the room back into your mic.</span></li>
            <li><Icon name="link" /><span><b>Share the link</b> once you're in, and send any password separately.</span></li>
            <li><Icon name="info" /><span><b>Chrome or Edge</b> gives the lowest live latency.</span></li>
          </ul>
        </section>
        <div className="lobby-stack">
          <form className="lobby-card" onSubmit={join} aria-label={fromUrl ? 'Join session' : 'Start a session'}>
            <h2>{fromUrl ? 'Join session' : 'Start a session'}</h2>
            {insecure && (
              <div className="lobby-error lobby-insecure" role="alert">
                <b>WeMake needs HTTPS for audio and recording.</b> Open this page over https:// (or via localhost).
              </div>
            )}
            <label className="field">Your name
              <input autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" />
            </label>
            <div className="field">
              <span id="colour-label">Your colour <span className="muted small">friends see your cursor and name in it</span></span>
              <div className="swatches" role="radiogroup" aria-labelledby="colour-label">
                {TRACK_COLORS.map((c) => (
                  <button type="button" key={c} role="radio" aria-checked={c === color} aria-label={c} className={c === color ? 'on' : ''} style={{ ['--sw' as string]: c }} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>
            <label className="field">Session
              <div className="input-group">
                <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="session-name" spellCheck={false} className="mono" />
                <button type="button" className="icon-btn" onClick={() => setRoom(randomRoom())} title="New random session name" aria-label="New random session name"><Icon name="refresh" /></button>
              </div>
            </label>
            <label className="field">Password <span className="muted small">{fromUrl ? 'if the session has one' : 'optional, locks your new session'}</span>
              <input type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} placeholder={fromUrl ? 'Session password' : 'Leave empty for an open session'} />
            </label>
            {error && <div className="lobby-error" role="alert">{error}</div>}
            <button className="primary big" disabled={!ok}>{fromUrl ? 'Join session' : 'Start session'}</button>
            {!ok && !insecure && <p className="muted small hint-center">{!name.trim() ? 'Add your name to continue.' : 'Add a session name to continue.'}</p>}
          </form>
          <MySongs onOpen={open} />
        </div>
      </main>
      {appearance && <Appearance onClose={() => setAppearance(false)} />}
    </div>
  );
}

/** A bank of level meters in the player's colour: the lobby's one moving element. */
function Levels({ color }: { color: string }) {
  const bars = 36;
  return (
    <div className="levels" aria-hidden style={{ ['--me' as string]: color }}>
      {Array.from({ length: bars }, (_, i) => {
        const h = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21));
        return <span key={i} style={{ ['--i' as string]: i, ['--h' as string]: h.toFixed(2), ['--d' as string]: `${(0.9 + ((i * 37) % 11) / 10).toFixed(2)}s`, ['--o' as string]: `${(-((i * 53) % 17) / 10).toFixed(2)}s` }} />;
      })}
    </div>
  );
}


/** Animated WM waveform in the theme's accent, with a signal pulse running through it. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="10 300 1708 240" aria-hidden>
      <path className="bm-glow" d={WAVE} pathLength={1000} />
      <path className="bm-trace" d={WAVE} pathLength={1000} />
      <path className="bm-pulse" d={WAVE} pathLength={1000} />
      <path className="bm-pulse bm-echo" d={WAVE} pathLength={1000} />
    </svg>
  );
}
