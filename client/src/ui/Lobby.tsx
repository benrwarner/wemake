import { useState } from 'react';
import { TRACK_COLORS } from '../../../shared/model';

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
  return (
    <div className="lobby">
      <div className="lobby-glow" />
      <form className="lobby-card" onSubmit={join}>
        <div className="brand big"><span className="brand-mark" />WeMake</div>
        {insecure && (
          <div className="lobby-error lobby-insecure" role="alert">
            <b>WeMake needs HTTPS for audio and recording.</b> Open this page over https:// (or via localhost).
          </div>
        )}
        <p className="lobby-tag">Make music with your friends in real time. Everyone hears the same song, plays live and records takes into one shared session.</p>
        <label>Your name
          <input autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" />
        </label>
        <label>Session
          <div className="row">
            <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="session-name" />
            <button type="button" className="ghost" onClick={() => setRoom(randomRoom())} title="New random session">↻</button>
          </div>
        </label>
        <label>Password <span className="muted small">{fromUrl ? '(if the session has one)' : '(optional, locks your new session)'}</span>
          <input type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} placeholder={fromUrl ? 'Session password' : 'Leave empty for an open session'} />
        </label>
        {error && <div className="lobby-error" role="alert">{error}</div>}
        <div className="swatches" role="radiogroup" aria-label="Your colour">
          {TRACK_COLORS.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={c === color} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <button className="primary big" disabled={!ok}>{fromUrl ? 'Join session' : 'Start session'}</button>
        <ul className="lobby-tips">
          <li><b>Wear headphones.</b> Speakers feed your friends back into your mic.</li>
          <li>Send your friends the link once you're in, and the password separately.</li>
          <li>Chrome or Edge gives the lowest live latency.</li>
        </ul>
      </form>
    </div>
  );
}
