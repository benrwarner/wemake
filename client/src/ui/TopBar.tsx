import { useEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import { fmtPos, useFrame, useStudio } from './hooks';
import { AccountChip } from './Account';
import { Icon } from './Icon';

interface Props {
  onSettings: () => void;
  onToggleSide: () => void;
  onAppearance: () => void;
  onLayout: () => void;
  onShortcuts: () => void;
  sideOpen: boolean;
}

export function TopBar({ onSettings, onToggleSide, onAppearance, onLayout, onShortcuts, sideOpen }: Props) {
  const s = useStudio();
  const p = s.snap.project;
  const pos = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const beat = s.engine.position();
    if (pos.current) pos.current.textContent = fmtPos(beat, p.sig);
  });
  const e = s.engine;
  const lat = e.latency;
  const invite = () => {
    const url = `${location.origin}${location.pathname}?room=${s.room}`;
    navigator.clipboard?.writeText(url).then(() => s.toast('Invite link copied. Send it to your friends.'), () => s.toast(url));
  };
  const online = !!s.session.myId;
  return (
    <header className="topbar">
      <div className="tb-left">
        <input
          className="project-name" value={p.name} aria-label="Song name" placeholder="Untitled song"
          onChange={(ev) => s.edit((d) => M.setProject(d, { name: ev.target.value.slice(0, 60) }))}
        />
        <button className="session-pill" onClick={invite} title={`${online ? 'Connected' : 'Connecting…'} · click to copy the invite link`}>
          <span className={`dot ${online ? 'online' : 'connecting'}`} />
          {s.session.locked && <Icon name="lock" size={13} title="Password protected" />}
          <span className="room mono">{s.room}</span>
          <Icon name="link" size={14} />
          <span className="pill-label">Invite</span>
        </button>
      </div>

      <div className="transport" role="toolbar" aria-label="Transport">
        <button className="tbtn" onClick={() => s.seek(0)} title="Go to start" aria-label="Go to start"><Icon name="start" /></button>
        <button className={`tbtn play ${s.playing ? 'on' : ''}`} onClick={() => s.play()} title="Play / Stop (Space)" aria-label={s.playing ? 'Stop' : 'Play'}>
          <Icon name={s.playing ? 'stop' : 'play'} size={18} />
        </button>
        <button className={`tbtn rec ${e.recording ? 'on' : ''}`} onClick={() => s.record()} title="Record (Shift+R)" aria-label="Record"><Icon name="record" size={18} /></button>
        <div className="lcd">
          <span ref={pos} className="lcd-pos" title="Bar . Beat . Sixteenth">1.1.1</span>
          <span className="lcd-sep" />
          <label className="lcd-field" title="Tempo">
            <input
              type="number" min={40} max={240} value={p.bpm} aria-label="Tempo"
              onChange={(ev) => { const v = Number(ev.target.value); if (v >= 40 && v <= 240) s.edit((d) => M.setProject(d, { bpm: v })); }}
            /><span>bpm</span>
          </label>
          <span className="lcd-sep" />
          <label className="lcd-field" title="Time signature">
            <select value={p.sig} aria-label="Beats per bar" onChange={(ev) => s.edit((d) => M.setProject(d, { sig: Number(ev.target.value) }))}>
              {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}/4</option>)}
            </select>
          </label>
        </div>
        <div className="tgroup">
          <button className={`tbtn toggle ${p.loopOn ? 'on' : ''}`} onClick={() => s.edit((d) => M.setProject(d, { loopOn: !p.loopOn }))} title="Cycle the loop region" aria-label="Cycle" aria-pressed={p.loopOn}><Icon name="loop" /></button>
          <button className={`tbtn toggle ${e.settings.metronome ? 'on' : ''}`} onClick={() => { e.settings.metronome = !e.settings.metronome; s.bump(); }} title="Metronome (only you hear it)" aria-label="Metronome" aria-pressed={!!e.settings.metronome}><Icon name="metronome" /></button>
          <button className={`tbtn toggle ${e.settings.countIn ? 'on' : ''}`} onClick={() => { e.settings.countIn = !e.settings.countIn; s.saveSettings(); s.bump(); }} title="Count in one bar before recording" aria-label="Count-in" aria-pressed={!!e.settings.countIn}><Icon name="countin" /></button>
        </div>
      </div>

      <div className="tb-right">
        <div className="segmented tune" role="group" aria-label="Listening mode">
          <button className={s.tunedIn ? 'on' : ''} aria-pressed={s.tunedIn} onClick={() => s.setTunedIn(true)} title="Shared: hear and control the room's playback together"><Icon name="headphones" size={14} />Shared</button>
          <button className={!s.tunedIn ? 'on solo' : ''} aria-pressed={!s.tunedIn} onClick={() => s.setTunedIn(false)} title="Private: playback only you hear. Your edits still sync live">Private</button>
        </div>
        {s.tunedIn && s.orchestrator && <span className="orch muted small" title="Whoever last pressed play or stop leads the shared playback">led by <b>{s.orchestrator.name}</b></span>}
        <span className="tb-divider" />
        <button className={`ghost capture ${e.jamRecording ? 'rec-on' : ''}`} onClick={() => s.toggleJamRecording()} aria-label={e.jamRecording ? 'Stop capture' : 'Capture jam'} title="Record everything you hear, including friends' live audio, to a WAV file">
          <Icon name={e.jamRecording ? 'stop' : 'capture'} /><span className="btn-label">{e.jamRecording ? 'Stop capture' : 'Capture jam'}</span>
        </button>
        <Menu label="Export and more" icon="download" text="Export">
          <MenuItem icon="download" onClick={() => s.exportMix()} hint="WAV 24-bit">Mixdown</MenuItem>
          <MenuItem icon="mixer" onClick={() => s.exportMix(true)} hint="One WAV per track">Stems</MenuItem>
          <MenuItem icon="piano" onClick={() => s.exportMidi()} hint=".mid">MIDI file</MenuItem>
          <hr />
          <MenuItem icon="undo" onClick={() => s.session.undo.undo()} hint="⌘Z">Undo</MenuItem>
          <MenuItem icon="redo" onClick={() => s.session.undo.redo()} hint="⇧⌘Z">Redo</MenuItem>
          <hr />
          <MenuItem icon="layout" onClick={onLayout}>Customize layout</MenuItem>
          <MenuItem icon="palette" onClick={onAppearance}>Appearance</MenuItem>
          <MenuItem icon="keyboard" onClick={onShortcuts} hint="?">Keyboard shortcuts</MenuItem>
        </Menu>
        <button className="icon-btn" onClick={onLayout} title="Customize layout: arrange and collapse panes" aria-label="Customize layout"><Icon name="layout" size={18} /></button>
        <button className="icon-btn" onClick={onAppearance} title="Appearance: themes, colours, background" aria-label="Appearance"><Icon name="palette" size={18} /></button>
        <button className="icon-btn latency-btn" onClick={onSettings} title={`Audio settings · latency ${(lat.output * 1000).toFixed(0)} ms out, ${(lat.roundTrip * 1000).toFixed(0)} ms round trip${e.settings.roundTripMs == null ? ' (not calibrated)' : ''}`} aria-label="Audio settings">
          <Icon name="settings" size={18} />
          {e.settings.roundTripMs == null && <span className="warn-dot" />}
        </button>
        <button className={`icon-btn ${sideOpen ? 'active' : ''}`} onClick={onToggleSide} title="Show or hide people and chat" aria-label="Toggle people panel" aria-pressed={sideOpen}>
          <Icon name="people" size={18} />
          {s.unread > 0 && <span className="badge">{s.unread}</span>}
        </button>
        <AccountChip />
      </div>
    </header>
  );
}

/** A dropdown that closes on outside click, Escape, or choosing an item. */
export function Menu({ label, icon, text, children, align = 'right' }: { label: string; icon: Parameters<typeof Icon>[0]['name']; text?: string; children: React.ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); wrap.current?.querySelector('button')?.focus(); } };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    wrap.current?.querySelector<HTMLButtonElement>('.menu button')?.focus();
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={wrap}>
      <button className={`ghost ${open ? 'active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label={label}>
        <Icon name={icon} />{text && <span className="btn-label">{text}</span>}<Icon name="chevron" size={13} className="chev" />
      </button>
      {open && (
        <div className={`menu ${align}`} role="menu" onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, hint, onClick, children }: { icon?: Parameters<typeof Icon>[0]['name']; hint?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick}>
      {icon ? <Icon name={icon} /> : <span className="icon" />}
      <span className="mi-label">{children}</span>
      {hint && <span className="mi-hint">{hint}</span>}
    </button>
  );
}
