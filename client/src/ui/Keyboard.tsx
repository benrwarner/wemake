import { useEffect, useRef, useState } from 'react';
import { useStudio } from './hooks';
import { Icon } from './Icon';
import { CollapseButton } from './Collapse';

// Computer keyboard layout (like GarageBand's Musical Typing)
const KEYMAP: Record<string, number> = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };

// semitone above the current octave's C → the computer key that plays it
const KEY_LABEL: Record<number, string> = Object.fromEntries(Object.entries(KEYMAP).map(([k, n]) => [n, k.toUpperCase()]));

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
const SPAN = 25; // notes on the on-screen keyboard
const LOW = 21; // A0
const HIGH = 108; // C8
const isWhite = (n: number) => WHITE.includes(((n % 12) + 12) % 12);
/** Left edge of note n, in white-key widths from A0 (black keys sit on the boundary). */
function keyX(n: number): number {
  let x = 0;
  for (let m = LOW; m < n; m++) if (isWhite(m)) x++;
  for (let m = n; m < LOW; m++) if (isWhite(m)) x--;
  return isWhite(n) ? x : x - 0.3;
}
const WIDTH = keyX(HIGH) + 1;

/** Thin whole-piano strip with a draggable window marking which notes the keyboard below shows. */
function PianoMap() {
  const s = useStudio();
  const ref = useRef<SVGSVGElement>(null);
  const grab = useRef<number | null>(null); // where in the window (white keys) the drag started
  const [dragging, setDragging] = useState(false);
  const base = (s.octave + 1) * 12;
  const x0 = keyX(base);
  const x1 = keyX(base + SPAN - 1) + 1;
  const setOctave = (o: number) => {
    const next = Math.max(0, Math.min(8, o));
    if (next !== s.octave) { s.octave = next; s.bump(); }
  };
  const toX = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * WIDTH;
  };
  // the C whose window-left lands nearest x
  const octaveAt = (x: number) => {
    let best = s.octave, dist = Infinity;
    for (let o = 0; o <= 8; o++) { const d = Math.abs(keyX((o + 1) * 12) - x); if (d < dist) { dist = d; best = o; } }
    return best;
  };
  const whites: number[] = [], blacks: number[] = [];
  const out = (n: number) => n < base || n >= base + SPAN; // not on the keyboard below
  for (let n = LOW; n <= HIGH; n++) (isWhite(n) ? whites : blacks).push(n);
  return (
    <svg ref={ref} className={`kb-map${dragging ? ' dragging' : ''}`} viewBox={`0 0 ${WIDTH} 6`} preserveAspectRatio="none"
      role="slider" tabIndex={0} aria-label="Keyboard range" aria-valuemin={0} aria-valuemax={8} aria-valuenow={s.octave}
      aria-valuetext={`C${s.octave} to C${s.octave + 2}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setOctave(s.octave - 1); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setOctave(s.octave + 1); }
      }}
      onPointerDown={(e) => {
        const x = toX(e.clientX);
        // grabbing the window keeps its offset; clicking elsewhere centres it on the click
        grab.current = x >= x0 && x <= x1 ? x - x0 : (x1 - x0) / 2;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        setOctave(octaveAt(x - grab.current));
      }}
      onPointerMove={(e) => { if (grab.current != null) setOctave(octaveAt(toX(e.clientX) - grab.current)); }}
      onPointerUp={() => { grab.current = null; setDragging(false); }}
      onPointerCancel={() => { grab.current = null; setDragging(false); }}>
      <title>{`Showing C${s.octave}–C${s.octave + 2}. Drag to move (or Z / X).`}</title>
      {whites.map((n) => <rect key={n} className={`w${out(n) ? ' out' : ''}`} x={keyX(n) + 0.06} y={0} width={0.88} height={6} />)}
      {blacks.map((n) => <rect key={n} className={`b${out(n) ? ' out' : ''}`} x={keyX(n)} y={0} width={0.6} height={3.6} />)}
      <rect className="win" x={Math.max(0, x0)} y={0} width={Math.min(WIDTH, x1) - Math.max(0, x0)} height={6} />
    </svg>
  );
}
export function Keyboard({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const s = useStudio();
  const trackId = s.playTrack;
  const track = trackId ? s.snap.tracks[trackId] : undefined;
  const base = (s.octave + 1) * 12;
  const notes = Array.from({ length: SPAN }, (_, i) => base + i);
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
      <div className="kb-col">
      <PianoMap />
      <div className="kb" onPointerLeave={() => [...down.current].forEach(off)}>
        {whites.map((n, i) => (
          <div key={n} className="kb-white" style={{ left: `${(i / whites.length) * 100}%`, width: `${100 / whites.length}%` }}
            onPointerDown={(e) => { (e.target as Element).releasePointerCapture?.(e.pointerId); on(n); }}
            onPointerUp={() => off(n)} onPointerEnter={(e) => e.buttons && on(n)} onPointerLeave={() => off(n)}>
            {KEY_LABEL[n - base] && <kbd className="kb-key" aria-hidden>{KEY_LABEL[n - base]}</kbd>}
            {n % 12 === 0 && <span>C{Math.floor(n / 12) - 1}</span>}
          </div>
        ))}
        {notes.filter((n) => !WHITE.includes(n % 12)).map((n) => {
          const wi = whites.filter((w) => w < n).length;
          return (
            <div key={n} className="kb-black" style={{ left: `calc(${(wi / whites.length) * 100}% - ${50 / whites.length * 0.6}%)`, width: `${(100 / whites.length) * 0.6}%` }}
              onPointerDown={(e) => { (e.target as Element).releasePointerCapture?.(e.pointerId); on(n); }}
              onPointerUp={() => off(n)} onPointerEnter={(e) => e.buttons && on(n)} onPointerLeave={() => off(n)}>
              {KEY_LABEL[n - base] && <kbd className="kb-key" aria-hidden>{KEY_LABEL[n - base]}</kbd>}
            </div>
          );
        })}
      </div>
      </div>
      <div className="kb-side">
        <button className="ghost small panic" onClick={() => s.panic()} title="Stop all stuck notes (Esc)"><Icon name="stop" size={11} />Panic</button>
        {onToggle && <CollapseButton collapsed={false} edge="bottom" label="keyboard" onClick={onToggle} />}
      </div>
    </footer>
  );
}
