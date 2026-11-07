import { useEffect, useRef } from 'react';
import { useStudio } from './hooks';
import { Icon } from './Icon';
import { CollapseButton } from './Collapse';

// Computer keyboard layout (like GarageBand's Musical Typing)
const KEYMAP: Record<string, number> = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };

export function useComputerKeyboard() {
  const s = useStudio();
  const held = useRef(new Map<string, number>());
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { s.octave = Math.max(0, s.octave - 1); s.bump(); return; }
      if (k === 'x') { s.octave = Math.min(8, s.octave + 1); s.bump(); return; }
      if (k === 'c') { s.velocity = Math.max(0.1, +(s.velocity - 0.1).toFixed(2)); s.bump(); return; }
      if (k === 'v') { s.velocity = Math.min(1, +(s.velocity + 0.1).toFixed(2)); s.bump(); return; }
      if (!(k in KEYMAP) || e.shiftKey) return;
      const note = (s.octave + 1) * 12 + KEYMAP[k];
      held.current.set(k, note);
      s.noteInput(note, s.velocity, true);
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const note = held.current.get(k);
      if (note == null) return;
      held.current.delete(k);
      s.noteInput(note, 0, false);
    };
    const blur = () => { for (const n of held.current.values()) s.noteInput(n, 0, false); held.current.clear(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [s]);
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];
export function Keyboard({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const s = useStudio();
  const trackId = s.playTrack;
  const track = trackId ? s.snap.tracks[trackId] : undefined;
  const base = (s.octave + 1) * 12;
  const notes = Array.from({ length: 25 }, (_, i) => base + i);
  const down = useRef(new Set<number>());
  const on = (n: number) => { down.current.add(n); s.noteInput(n, s.velocity, true); };
  const off = (n: number) => { if (down.current.delete(n)) s.noteInput(n, 0, false); };
  const whites = notes.filter((n) => WHITE.includes(n % 12));
  if (collapsed) {
    return (
      <footer className="keyboard collapsed">
        <button className="ghost small kb-expand" onClick={onToggle} aria-expanded={false} title="Show the keyboard">
          <Icon name="keys" />Keyboard
          {track && <span className="muted"><span className="tc-dot" style={{ background: track.color }} />{track.name}</span>}
          <span className="muted small">Keys A to K still play</span>
        </button>
        <span className="spacer" />
        {onToggle && <CollapseButton collapsed edge="bottom" label="keyboard" onClick={onToggle} />}
      </footer>
    );
  }
  return (
    <footer className="keyboard">
      <div className="kb-info">
        <div className="kb-track">{track ? <><span className="tc-dot" style={{ background: track.color }} /><b>{track.name}</b></> : <span className="muted">Select an instrument track to play</span>}</div>
        <div className="kb-stats">
          <span title="Octave (Z / X)"><span className="muted">Oct</span> {`C${s.octave}`}</span>
          <span title="Velocity (C / V)"><span className="muted">Vel</span> {Math.round(s.velocity * 127)}</span>
          {s.midiInputs.length > 0 && <span title={`MIDI: ${s.midiInputs.join(', ')}`} className="ok">MIDI</span>}
        </div>
      </div>
      <div className="kb" onPointerLeave={() => [...down.current].forEach(off)}>
        {whites.map((n, i) => (
          <div key={n} className="kb-white" style={{ left: `${(i / whites.length) * 100}%`, width: `${100 / whites.length}%` }}
            onPointerDown={(e) => { (e.target as Element).releasePointerCapture?.(e.pointerId); on(n); }}
            onPointerUp={() => off(n)} onPointerEnter={(e) => e.buttons && on(n)} onPointerLeave={() => off(n)}>
            {n % 12 === 0 && <span>C{Math.floor(n / 12) - 1}</span>}
          </div>
        ))}
        {notes.filter((n) => !WHITE.includes(n % 12)).map((n) => {
          const wi = whites.filter((w) => w < n).length;
          return (
            <div key={n} className="kb-black" style={{ left: `calc(${(wi / whites.length) * 100}% - ${50 / whites.length * 0.6}%)`, width: `${(100 / whites.length) * 0.6}%` }}
              onPointerDown={(e) => { (e.target as Element).releasePointerCapture?.(e.pointerId); on(n); }}
              onPointerUp={() => off(n)} onPointerEnter={(e) => e.buttons && on(n)} onPointerLeave={() => off(n)} />
          );
        })}
      </div>
      <div className="kb-side">
        <button className="ghost small panic" onClick={() => s.panic()} title="Stop all stuck notes (Esc)"><Icon name="stop" size={11} />Panic</button>
        {onToggle && <CollapseButton collapsed={false} edge="bottom" label="keyboard" onClick={onToggle} />}
      </div>
    </footer>
  );
}
