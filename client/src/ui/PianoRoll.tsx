import { useEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import type { Note } from '../../../shared/model';
import { DRUM_NAMES } from '../audio/plugins/instruments';
import { startDrag, useFrame, useStudio } from './hooks';
import { RemoteCursors } from './Cursors';

const ROW_H = 14;
const KEYS_W = 64;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);
const noteName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

export function PianoRoll() {
  const s = useStudio();
  const clip = s.editorClip ? s.snap.clips[s.editorClip] : undefined;
  const track = clip ? s.snap.tracks[clip.trackId] : undefined;
  const [draft, setDraft] = useState<Note[] | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [ppb, setPpb] = useState(64);
  const [grid, setGrid] = useState(0.25);
  const [len, setLen] = useState(0.25);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const isDrums = track?.instrument?.type === 'drums';
  const [lo, hi] = isDrums ? [35, 59] : [21, 108];
  const rows = hi - lo + 1;

  useEffect(() => { setDraft(null); setSel(new Set()); }, [s.editorClip]);
  // scroll to the notes (or middle C) when opening a clip
  useEffect(() => {
    const el = scroller.current;
    if (!el || !clip) return;
    const ps = clip.notes?.map((n) => n.p) ?? [];
    const center = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : isDrums ? 42 : 60;
    el.scrollTop = (hi - center) * ROW_H - el.clientHeight / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.editorClip]);

  useFrame(() => {
    if (!clip || !playhead.current) return;
    const rel = s.engine.position() - clip.start;
    playhead.current.style.display = s.playing && rel >= 0 && rel <= clip.length ? 'block' : 'none';
    playhead.current.style.transform = `translateX(${KEYS_W + rel * ppb}px)`;
  });

  if (!clip || !track || clip.kind !== 'midi') {
    return <div className="empty">Double-click a MIDI clip (or an empty spot on an instrument lane) to edit notes here. Record notes live by arming an instrument track and pressing ●.</div>;
  }

  const notes = draft ?? clip.notes ?? [];
  const commit = (next: Note[]) => {
    setDraft(null);
    s.edit((d) => M.setClip(d, clip.id, { notes: next }));
  };
  const snap = (b: number, alt: boolean) => (grid && !alt ? Math.round(b / grid) * grid : b);
  const floorSnap = (b: number, alt: boolean) => (grid && !alt ? Math.floor(b / grid) * grid : b);
  const preview = (p: number, v = 0.8) => {
    s.noteInput(p, v, true, track.id);
    setTimeout(() => s.noteInput(p, 0, false, track.id), 180);
  };
  const width = clip.length * ppb;

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const beat = floorSnap((e.clientX - rect.left) / ppb, e.altKey);
    const p = hi - Math.floor((e.clientY - rect.top) / ROW_H);
    if (beat < 0 || beat >= clip.length) return;
    if (e.shiftKey) {
      // rubber-band select
      const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
      startDrag(e, (dx, dy) => {
        const b0 = Math.min(x0, x0 + dx) / ppb, b1 = Math.max(x0, x0 + dx) / ppb;
        const p0 = hi - Math.floor(Math.max(y0, y0 + dy) / ROW_H), p1 = hi - Math.floor(Math.min(y0, y0 + dy) / ROW_H);
        setSel(new Set(notes.map((n, i) => (n.s + n.d > b0 && n.s < b1 && n.p >= p0 && n.p <= p1 ? i : -1)).filter((i) => i >= 0)));
      });
      return;
    }
    const note: Note = { p, s: beat, d: isDrums ? Math.max(grid || 0.25, 0.125) : len, v: s.velocity };
    const next = [...notes, note];
    const idx = next.length - 1;
    setDraft(next);
    setSel(new Set([idx]));
    preview(p, s.velocity);
    // drag right while placing to set length
    let current = next;
    startDrag(e, (dx) => {
      const d = Math.max(grid || 0.0625, snap(note.d + dx / ppb, false));
      current = next.map((n, i) => (i === idx ? { ...n, d: Math.min(d, clip.length - n.s) } : n));
      setDraft(current);
    }, (_ev, moved) => {
      if (moved && !isDrums) setLen(current[idx].d);
      commit(current);
    });
  };

  const onNoteDown = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    if (e.button === 2 || e.altKey && e.detail > 1) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const resize = rect.right - e.clientX < 6;
    const group = sel.has(i) ? sel : new Set([i]);
    if (!sel.has(i)) setSel(group);
    const orig = notes;
    let last = orig;
    if (!resize) preview(orig[i].p, orig[i].v);
    startDrag(e, (dx, dy, ev) => {
      const db = dx / ppb, dp = -Math.round(dy / ROW_H);
      last = orig.map((n, j) => {
        if (!group.has(j)) return n;
        if (resize) return { ...n, d: Math.max(0.0625, Math.min(clip.length - n.s, snap(n.d + db, ev.altKey))) };
        const ns = Math.max(0, Math.min(clip.length - 0.0625, snap(n.s + db, ev.altKey)));
        return { ...n, s: ns, p: Math.max(lo, Math.min(hi, n.p + dp)) };
      });
      setDraft(last);
    }, (_ev, moved) => { if (moved) commit(last); else setDraft(null); });
  };

  const del = (idxs: Set<number>) => { commit(notes.filter((_, j) => !idxs.has(j))); setSel(new Set()); };
  const quantize = () => commit(notes.map((n, i) => (sel.size && !sel.has(i) ? n : { ...n, s: Math.round(n.s / (grid || 0.25)) * (grid || 0.25) })));
  const transpose = (st: number) => commit(notes.map((n, i) => (sel.size && !sel.has(i) ? n : { ...n, p: Math.max(0, Math.min(127, n.p + st)) })));
  const setVel = (v: number) => commit(notes.map((n, i) => (sel.has(i) ? { ...n, v } : n)));

  return (
    <div className="pianoroll"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); e.stopPropagation(); del(sel); }
        if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); setSel(new Set(notes.map((_, i) => i))); }
      }}
    >
      <div className="pr-toolbar">
        <strong style={{ color: track.color }}>{track.name}</strong>
        <input className="pr-name" value={clip.name} onChange={(e) => s.edit((d) => M.setClip(d, clip.id, { name: e.target.value }))} aria-label="Clip name" />
        <label>Length
          <select value={clip.length} onChange={(e) => s.edit((d) => M.setClip(d, clip.id, { length: Number(e.target.value) }))}>
            {[1, 2, 4, 8, 16].map((b) => <option key={b} value={b * s.snap.project.sig}>{b} bar{b > 1 ? 's' : ''}</option>)}
            {![1, 2, 4, 8, 16].some((b) => b * s.snap.project.sig === clip.length) && <option value={clip.length}>{(clip.length / s.snap.project.sig).toFixed(2)} bars</option>}
          </select>
        </label>
        <label>Grid
          <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
            <option value={1}>1/4</option><option value={0.5}>1/8</option><option value={1 / 3}>1/8T</option>
            <option value={0.25}>1/16</option><option value={0.125}>1/32</option><option value={0}>Off</option>
          </select>
        </label>
        <label>Velocity
          <input type="range" min={0.05} max={1} step={0.05} value={s.velocity} onChange={(e) => { s.velocity = Number(e.target.value); if (sel.size) setVel(s.velocity); s.bump(); }} />
        </label>
        <button onClick={quantize} title="Quantize selected (or all) notes to the grid">Quantize</button>
        <button onClick={() => transpose(-12)} title="Octave down">−8va</button>
        <button onClick={() => transpose(12)} title="Octave up">+8va</button>
        <button onClick={() => s.edit((d) => M.setProject(d, { loopOn: true, loopStart: clip.start, loopEnd: clip.start + clip.length }))} title="Cycle this clip">Loop clip</button>
        <span className="spacer" />
        <label>Zoom <input type="range" min={20} max={240} value={ppb} onChange={(e) => setPpb(Number(e.target.value))} /></label>
        <span className="hint">Click: add · drag: move/resize · right-click: delete · ⇧-drag: select</span>
      </div>
      <div className="pr-scroll" ref={scroller}>
        <div className="pr-inner" style={{ width: KEYS_W + width, height: rows * ROW_H }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left - KEYS_W, y = e.clientY - r.top;
            if (x < 0) return s.session.sendCursor(null);
            s.session.sendCursor({ v: 'p', clip: clip.id, b: x / ppb, p: hi - y / ROW_H + 0.5 });
          }}
          onPointerLeave={() => s.session.sendCursor(null)}
        >
          <div className="pr-keys" style={{ width: KEYS_W }}>
            {Array.from({ length: rows }, (_, r) => hi - r).map((p) => (
              <div key={p} className={`pr-key ${isBlack(p) ? 'black' : ''} ${p % 12 === 0 ? 'c' : ''}`} style={{ height: ROW_H }}
                onPointerDown={() => preview(p)}>
                {isDrums ? DRUM_NAMES[p] ?? '' : p % 12 === 0 ? noteName(p) : ''}
              </div>
            ))}
          </div>
          <div className="pr-grid"
            style={{
              left: KEYS_W, width, height: rows * ROW_H,
              backgroundImage: `linear-gradient(90deg, var(--grid-bar) 1px, transparent 1px), linear-gradient(90deg, var(--grid-beat) 1px, transparent 1px)${grid ? `, linear-gradient(90deg, var(--grid-sub) 1px, transparent 1px)` : ''}`,
              backgroundSize: `${s.snap.project.sig * ppb}px 100%, ${ppb}px 100%${grid ? `, ${grid * ppb}px 100%` : ''}`,
            }}
            onPointerDown={onGridDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            {Array.from({ length: rows }, (_, r) => hi - r).filter(isBlack).map((p) => (
              <div key={p} className="pr-row-black" style={{ top: (hi - p) * ROW_H, height: ROW_H }} />
            ))}
            {notes.map((n, i) => (n.p < lo || n.p > hi ? null : (
              <div key={i} className={`pr-note ${sel.has(i) ? 'sel' : ''}`}
                style={{ left: n.s * ppb, top: (hi - n.p) * ROW_H + 1, width: Math.max(4, n.d * ppb - 1), height: ROW_H - 2, background: track.color, opacity: 0.35 + n.v * 0.65 }}
                onPointerDown={(e) => onNoteDown(e, i)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); del(new Set(sel.has(i) ? sel : [i])); }}
                onDoubleClick={(e) => { e.stopPropagation(); del(new Set([i])); }}
                title={`${isDrums ? DRUM_NAMES[n.p] ?? noteName(n.p) : noteName(n.p)} · vel ${Math.round(n.v * 127)}`}
              />
            )))}
          </div>
          <div className="pr-playhead" ref={playhead} />
          <RemoteCursors s={s} place={(c) => (c.v === 'p' && c.clip === clip.id ? { x: KEYS_W + c.b * ppb, y: (hi - c.p + 0.5) * ROW_H } : null)} />
        </div>
      </div>
    </div>
  );
}
