import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import type { Clip, Track } from '../../../shared/model';
import type { Studio } from '../state/studio';
import { builtinInstruments } from '../audio/plugins/registry';
import { Meter } from './controls';
import { RemoteCursors } from './Cursors';
import { fmtDb, startDrag, useFrame, useStudio } from './hooks';

const HEADER = 236;
const ROW = 72;
const RULER = 38;

interface DragState { id: string; start: number; length: number; offset: number; trackId: string; notesShift: number; copy: boolean }

export function Arrange() {
  const s = useStudio();
  const { project, order, tracks, clips } = s.snap;
  const ppb = s.ppb;
  const scroll = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const songEnd = Math.max(0, ...Object.values(clips).map((c) => c.start + c.length), project.loopEnd);
  const totalBeats = Math.ceil((songEnd + project.sig * 16) / project.sig) * project.sig;
  const width = totalBeats * ppb;

  useFrame(() => {
    const beat = s.engine.position();
    const x = HEADER + beat * ppb;
    if (playhead.current) playhead.current.style.transform = `translateX(${x}px)`;
    const sc = scroll.current;
    if (sc && s.playing && !draggingRef.current) {
      const view = sc.scrollLeft + sc.clientWidth;
      if (x > view - 40 || x < sc.scrollLeft + HEADER) sc.scrollLeft = Math.max(0, x - HEADER - 80);
    }
  });
  const draggingRef = useRef(false);
  draggingRef.current = !!drag;

  // ctrl/cmd + wheel zooms around the pointer
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - HEADER + el.scrollLeft;
      const beat = px / s.ppb;
      const next = Math.max(4, Math.min(240, s.ppb * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      s.setZoom(next);
      requestAnimationFrame(() => { el.scrollLeft = beat * next - (e.clientX - rect.left - HEADER); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [s]);

  const snapBeat = (b: number, alt = false) => (s.snapDiv && !alt ? Math.round(b / s.snapDiv) * s.snapDiv : b);
  const beatFromClient = (clientX: number) => {
    const el = scroll.current!;
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER) / ppb;
  };

  const grid = {
    backgroundImage: `linear-gradient(90deg, var(--grid-bar) 1px, transparent 1px), linear-gradient(90deg, var(--grid-beat) 1px, transparent 1px)`,
    backgroundSize: `${project.sig * ppb}px 100%, ${ppb}px 100%`,
  };

  return (
    <section className="arrange">
      <div className="arrange-toolbar">
        <span className="label">Add track</span>
        <button onClick={() => s.addTrack('audio')} title="Record a mic, guitar or any audio input">🎙 Audio</button>
        {builtinInstruments().map((d) => (
          <button key={d.type} onClick={() => s.addTrack('instrument', d.type)}>{d.type === 'drums' ? '🥁' : d.type === 'epiano' ? '🎹' : '🎛'} {d.name}</button>
        ))}
        <span className="spacer" />
        <label className="label">Snap
          <select value={s.snapDiv} onChange={(e) => { s.snapDiv = Number(e.target.value); s.bump(); }}>
            <option value={project.sig}>Bar</option>
            <option value={1}>1/4</option>
            <option value={0.5}>1/8</option>
            <option value={0.25}>1/16</option>
            <option value={0}>Off</option>
          </select>
        </label>
        <label className="label">Zoom
          <input type="range" min={4} max={240} value={ppb} onChange={(e) => s.setZoom(Number(e.target.value))} />
        </label>
      </div>
      <div className="arrange-scroll" ref={scroll}>
        <div className="arrange-grid" style={{ width: HEADER + width }}
          onPointerMove={(e) => {
            const grid = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - grid.left - HEADER, y = e.clientY - grid.top - RULER;
            const row = Math.floor(y / ROW);
            if (x < 0 || y < 0 || row >= order.length) return s.session.sendCursor(null);
            s.session.sendCursor({ v: 'a', b: x / ppb, t: order[row], y: (y - row * ROW) / ROW });
          }}
          onPointerLeave={() => s.session.sendCursor(null)}
        >
          <div className="ruler-row">
            <div className="corner" />
            <Ruler s={s} width={width} beatFromClient={beatFromClient} snapBeat={snapBeat} />
          </div>
          {order.map((id) => {
            const t = tracks[id];
            const laneClips = Object.values(clips).filter((c) => (drag && drag.id === c.id && !drag.copy ? drag.trackId : c.trackId) === id);
            if (drag?.copy && drag.trackId === id) laneClips.push({ ...clips[drag.id], id: '__copy' });
            return (
              <div key={id} className={`track-row ${s.selectedTrack === id ? 'selected' : ''}`} style={{ height: ROW }}>
                <TrackHeader s={s} t={t} />
                <div
                  className="lane" data-track={id} data-kind={t.kind} style={{ width, ...grid }}
                  onPointerDown={(e) => { if (e.target === e.currentTarget) { s.selectTrack(id); s.selectClip(null); } }}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget || t.kind !== 'instrument') return;
                    const start = Math.floor(beatFromClient(e.clientX) / project.sig) * project.sig;
                    let cid = '';
                    s.edit((d) => { cid = M.addClip(d, { trackId: id, kind: 'midi', name: `${t.name} ${start / project.sig + 1}`, start, length: project.sig, notes: [], by: s.name }); });
                    s.openEditor(cid);
                  }}
                  onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const beat = snapBeat(beatFromClient(e.clientX));
                    for (const f of e.dataTransfer.files) if (f.type.startsWith('audio') || /\.(wav|mp3|m4a|aac|ogg|flac|aiff?)$/i.test(f.name)) s.importFile(f, t.kind === 'audio' ? id : null, beat);
                  }}
                >
                  {project.loopOn && (
                    <div className="loop-shade" style={{ left: project.loopStart * ppb, width: (project.loopEnd - project.loopStart) * ppb }} />
                  )}
                  {laneClips.map((c) => {
                    const view = drag && (drag.id === c.id || c.id === '__copy') && (c.id === '__copy' || !drag.copy)
                      ? { ...c, start: drag.start, length: drag.length, offset: drag.offset } : c;
                    return (
                      <ClipView
                        key={c.id} s={s} c={view} t={t} ppb={ppb} notesShift={drag?.id === c.id ? drag.notesShift : 0}
                        onDragStart={(e, mode) => {
                          const orig = clips[c.id];
                          if (!orig) return;
                          s.selectClip(c.id);
                          const spb = 60 / project.bpm;
                          const buf = orig.audioId ? s.engine.buffers.get(orig.audioId) : undefined;
                          const maxLen = buf ? (buf.duration - orig.offset) / spb : Infinity;
                          let st: DragState = { id: c.id, start: orig.start, length: orig.length, offset: orig.offset, trackId: orig.trackId, notesShift: 0, copy: e.altKey && mode === 'move' };
                          setDrag(st);
                          startDrag(e, (dx, _dy, ev) => {
                            const db = dx / ppb;
                            if (mode === 'move') {
                              const lane = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => (n as HTMLElement).dataset?.track) as HTMLElement | undefined;
                              const trackId = lane && lane.dataset.kind === t.kind ? lane.dataset.track! : st.trackId;
                              st = { ...st, start: Math.max(0, snapBeat(orig.start + db, ev.altKey && !st.copy)), trackId };
                            } else if (mode === 'end') {
                              const len = Math.max(s.snapDiv || 0.0625, snapBeat(orig.start + orig.length + db, ev.altKey) - orig.start);
                              st = { ...st, length: Math.min(len, maxLen) };
                            } else {
                              // trim the start; content stays put on the timeline
                              let ns = Math.max(0, snapBeat(orig.start + db, ev.altKey));
                              ns = Math.min(ns, orig.start + orig.length - 0.0625);
                              if (orig.kind === 'audio') ns = Math.max(ns, orig.start - orig.offset / spb);
                              const delta = ns - orig.start;
                              st = { ...st, start: ns, length: orig.length - delta, offset: orig.kind === 'audio' ? orig.offset + delta * spb : 0, notesShift: delta };
                            }
                            setDrag(st);
                          }, (_ev, moved) => {
                            setDrag(null);
                            if (!moved) return;
                            s.edit((d) => {
                              if (st.copy) {
                                const id2 = M.addClip(d, { ...orig, id: undefined, start: st.start, trackId: st.trackId });
                                setTimeout(() => s.selectClip(id2));
                                return;
                              }
                              const patch: Partial<Clip> = { start: st.start, length: st.length, trackId: st.trackId };
                              if (orig.kind === 'audio') patch.offset = st.offset;
                              if (orig.kind === 'midi' && st.notesShift) patch.notes = (orig.notes ?? []).map((n) => ({ ...n, s: n.s - st.notesShift })).filter((n) => n.s + n.d > 0);
                              M.setClip(d, c.id, patch);
                            });
                          });
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="add-row" style={{ width: HEADER + width }}>
            <div className="add-hint">Double-click an instrument lane to draw a clip · drop audio files onto audio lanes · Alt-drag duplicates · ⌘D repeats the selected clip</div>
          </div>
          <div className="playhead" ref={playhead} />
          <RemoteCursors s={s} place={(c) => {
            if (c.v !== 'a') return null;
            const row = s.snap.order.indexOf(c.t);
            return row < 0 ? null : { x: HEADER + c.b * s.ppb, y: RULER + (row + c.y) * ROW };
          }} />
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ ruler
function Ruler({ s, width, beatFromClient, snapBeat }: { s: Studio; width: number; beatFromClient: (x: number) => number; snapBeat: (b: number, alt?: boolean) => number }) {
  const { project } = s.snap;
  const ppb = s.ppb;
  const barPx = project.sig * ppb;
  const every = Math.max(1, Math.ceil(44 / barPx));
  const bars = Math.ceil(width / barPx);
  const [loop, setLoop] = useState<{ a: number; b: number } | null>(null);
  const la = loop?.a ?? project.loopStart, lb = loop?.b ?? project.loopEnd;
  const commitLoop = (a: number, b: number) => {
    if (b - a < 0.25) return;
    s.edit((d) => M.setProject(d, { loopStart: a, loopEnd: b, loopOn: true }));
  };
  const loopSnap = (b: number, alt: boolean) => Math.max(0, alt ? b : Math.round(b / (s.snapDiv || 1)) * (s.snapDiv || 1));

  return (
    <div className="ruler" style={{ width }}>
      <div
        className="loop-strip" title="Drag to set the cycle region"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const a0 = loopSnap(beatFromClient(e.clientX), e.altKey);
          let r = { a: a0, b: a0 };
          startDrag(e, (_dx, _dy, ev) => {
            const b = loopSnap(beatFromClient(ev.clientX), ev.altKey);
            r = { a: Math.min(a0, b), b: Math.max(a0, b) };
            setLoop(r);
          }, () => { setLoop(null); commitLoop(r.a, r.b); });
        }}
      >
        <div className={`loop-band ${project.loopOn ? 'on' : ''}`} style={{ left: la * ppb, width: Math.max(0, lb - la) * ppb }}
          onPointerDown={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const edge = e.clientX - rect.left < 8 ? 'a' : rect.right - e.clientX < 8 ? 'b' : 'move';
            const a0 = project.loopStart, b0 = project.loopEnd;
            let r = { a: a0, b: b0 };
            startDrag(e, (dx, _dy, ev) => {
              const d = dx / ppb;
              if (edge === 'move') { const a = loopSnap(a0 + d, ev.altKey); r = { a, b: a + (b0 - a0) }; }
              else if (edge === 'a') r = { a: Math.min(loopSnap(a0 + d, ev.altKey), b0 - 0.25), b: b0 };
              else r = { a: a0, b: Math.max(loopSnap(b0 + d, ev.altKey), a0 + 0.25) };
              setLoop(r);
            }, (_ev, moved) => {
              setLoop(null);
              if (moved) commitLoop(r.a, r.b);
              else s.edit((d) => M.setProject(d, { loopOn: !project.loopOn }));
            });
          }}
        />
      </div>
      <div className="bar-strip" onPointerDown={(e) => s.seek(snapBeat(beatFromClient(e.clientX), e.altKey))} title="Click to move the playhead">
        {Array.from({ length: Math.ceil(bars / every) }, (_, i) => i * every).map((bar) => (
          <span key={bar} className="bar-num" style={{ left: bar * barPx }}>{bar + 1}</span>
        ))}
        {[...s.session.peers.values()].filter((p) => p.state.cursor != null && !s.playing).map((p) => (
          <span key={p.id} className="peer-cursor" style={{ left: (p.state.cursor ?? 0) * ppb, background: p.color }} title={`${p.name}'s cursor`} />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ track header
function TrackHeader({ s, t }: { s: Studio; t: Track }) {
  const [rename, setRename] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const e = s.engine;
  const armed = e.armedAudio === t.id || e.armedInstrument === t.id;
  const players = [...s.session.peers.values()].filter((p) => p.state.track === t.id);
  const inst = t.instrument && builtinInstruments().find((d) => d.type === t.instrument!.type);
  const strip = e.strip(t.id);
  const err = strip?.instrument?.error;
  return (
    <div className="track-header" style={{ ['--tc' as string]: t.color }} onPointerDown={() => s.selectTrack(t.id)}>
      <div className="th-top">
        <span className="th-icon" aria-hidden>{t.kind === 'audio' ? '🎙' : t.instrument?.type === 'drums' ? '🥁' : t.instrument?.type === 'epiano' ? '🎹' : '🎛'}</span>
        {rename ? (
          <input autoFocus className="th-name-input" defaultValue={t.name} maxLength={40}
            onBlur={(ev) => { s.edit((d) => M.setTrack(d, t.id, { name: ev.target.value || t.name })); setRename(false); }}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') (ev.target as HTMLInputElement).blur(); }} />
        ) : (
          <span className="th-name" onDoubleClick={() => setRename(true)} title="Double-click to rename">{t.name}</span>
        )}
        <span className="th-people">
          {players.map((p) => <span key={p.id} className={`avatar ${p.state.recording ? 'rec' : ''}`} style={{ background: p.color }} title={`${p.name}${p.state.recording ? ' is recording' : ' is playing this'}`}>{p.name[0]?.toUpperCase()}</span>)}
        </span>
        {confirmDel ? (
          <button className="th-del on" onClick={() => s.edit((d) => M.deleteTrack(d, t.id))} onBlur={() => setConfirmDel(false)} autoFocus>Delete?</button>
        ) : (
          <button className="th-del" onClick={() => setConfirmDel(true)} title="Delete track" aria-label="Delete track">×</button>
        )}
      </div>
      <div className="th-sub">{t.kind === 'audio' ? 'Audio input' : err ? `⚠ ${err}` : inst?.name ?? t.instrument?.type}</div>
      <div className="th-controls">
        <button className={`msr m ${t.mute ? 'on' : ''}`} onClick={() => s.edit((d) => M.setTrack(d, t.id, { mute: !t.mute }))} title="Mute (for everyone)">M</button>
        <button className={`msr s ${t.solo ? 'on' : ''}`} onClick={() => s.edit((d) => M.setTrack(d, t.id, { solo: !t.solo }))} title="Solo (for everyone)">S</button>
        <button className={`msr r ${armed ? 'on' : ''}`} onClick={() => s.arm(t.id)}
          title={t.kind === 'audio' ? 'Arm: your input plays live through this track and records here' : 'Arm: your keyboard / MIDI controller plays this instrument'}>R</button>
        <input className="th-vol" type="range" min={-60} max={6} step={0.5} value={t.volume} aria-label={`${t.name} volume`}
          title={`${fmtDb(t.volume)} dB`}
          onChange={(ev) => s.edit((d) => M.setTrack(d, t.id, { volume: Number(ev.target.value) }))}
          onDoubleClick={() => s.edit((d) => M.setTrack(d, t.id, { volume: 0 }))} />
      </div>
      <Meter read={() => s.meter(t.id)} />
    </div>
  );
}

// ------------------------------------------------------------ clip
const ClipView = memo(function ClipView({ s, c, t, ppb, notesShift, onDragStart }: {
  s: Studio; c: Clip; t: Track; ppb: number; notesShift: number;
  onDragStart: (e: React.PointerEvent, mode: 'move' | 'start' | 'end') => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = Math.max(4, c.length * ppb);
  const editors = [...s.session.peers.values()].filter((p) => p.state.editing === c.id);
  const peaks = c.audioId ? s.engine.peaks.get(c.audioId) : undefined;
  const bpm = s.snap.project.bpm;
  const pending = c.audioId && !peaks;

  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const H = ROW - 22;
    const W = Math.min(w, 16000);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = t.color;
    if (c.kind === 'audio' && peaks) {
      const spb = 60 / bpm;
      const mid = H / 2;
      const perPx = (spb / ppb) * peaks.sampleRate / peaks.samplesPerPeak;
      const start = (c.offset * peaks.sampleRate) / peaks.samplesPerPeak;
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor(start + x * perPx), i1 = Math.max(i0 + 1, Math.floor(start + (x + 1) * perPx));
        let lo = 0, hi = 0;
        for (let i = i0; i < i1 && i * 2 + 1 < peaks.peaks.length; i++) { lo = Math.min(lo, peaks.peaks[i * 2]); hi = Math.max(hi, peaks.peaks[i * 2 + 1]); }
        if (hi - lo < 0.002) continue;
        g.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
    } else if (c.kind === 'midi' && c.notes?.length) {
      const notes = c.notes.map((n) => ({ ...n, s: n.s - notesShift }));
      const lo = Math.min(...notes.map((n) => n.p)), hi = Math.max(...notes.map((n) => n.p));
      const range = Math.max(12, hi - lo + 1);
      const nh = Math.max(2, Math.min(6, (H - 6) / range));
      for (const n of notes) {
        if (n.s >= c.length || n.s + n.d <= 0) continue;
        const y = H - 3 - (n.p - lo + 1) * ((H - 6) / range);
        g.globalAlpha = 0.45 + n.v * 0.55;
        g.fillRect(Math.max(0, n.s * ppb), y, Math.max(2, Math.min(n.d, c.length - n.s) * ppb - 1), nh);
      }
    }
  }, [c, ppb, peaks, t.color, w, bpm, notesShift]);

  return (
    <div
      className={`clip ${c.kind} ${s.selectedClip === c.id ? 'selected' : ''} ${c.id === '__copy' ? 'ghost-copy' : ''}`}
      style={{ left: c.start * ppb, width: w, ['--tc' as string]: t.color, ...(editors[0] ? { boxShadow: `0 0 0 2px ${editors[0].color}` } : {}) }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        onDragStart(e, x < 7 ? 'start' : rect.width - x < 7 ? 'end' : 'move');
      }}
      onDoubleClick={() => { if (c.kind === 'midi') s.openEditor(c.id); }}
      title={`${c.name}${c.by ? ` · by ${c.by}` : ''}${c.kind === 'midi' ? ' · double-click to edit' : ''}`}
    >
      <div className="clip-head">
        <span>{c.name}</span>
        {editors.map((p) => <span key={p.id} className="avatar tiny" style={{ background: p.color }}>{p.name[0]?.toUpperCase()}</span>)}
      </div>
      {pending ? <div className="clip-loading">loading audio…</div> : <canvas ref={canvas} />}
      <div className="clip-edge l" /><div className="clip-edge r" />
    </div>
  );
});
