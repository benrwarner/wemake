import { useRef, useState } from 'react';
import * as M from '../../../shared/model';
import { fmtPos, useFrame, useStudio } from './hooks';

export function TopBar({ onSettings, onToggleSide }: { onSettings: () => void; onToggleSide: () => void }) {
  const s = useStudio();
  const p = s.snap.project;
  const pos = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState(false);
  useFrame(() => {
    const beat = s.engine.position();
    if (pos.current) pos.current.textContent = fmtPos(beat, p.sig);
  });
  const e = s.engine;
  const lat = e.latency;
  const invite = () => {
    const url = `${location.origin}${location.pathname}?room=${s.room}`;
    navigator.clipboard?.writeText(url).then(() => s.toast('Invite link copied: send it to your friends'), () => s.toast(url));
  };
  const status = s.session.myId ? 'online' : 'connecting';
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" />WeMake</div>
      <input
        className="project-name" value={p.name} aria-label="Song name"
        onChange={(ev) => s.edit((d) => M.setProject(d, { name: ev.target.value.slice(0, 60) }))}
      />
      <button className="ghost room" onClick={invite} title="Copy invite link">
        <span className={`dot ${status}`} />{s.room}<span className="muted"> · invite</span>
      </button>

      <div className="tune" role="group" aria-label="Listening mode">
        <button className={s.tunedIn ? 'on' : ''} onClick={() => s.setTunedIn(true)} title="Tuned in: hear and control the shared playback with everyone">🎧 Shared</button>
        <button className={!s.tunedIn ? 'on solo' : ''} onClick={() => s.setTunedIn(false)} title="Tuned out: private playback only you hear. Your edits still sync live">Private</button>
        {s.tunedIn && s.orchestrator && <span className="muted small orch" title="Whoever last pressed play/stop drives the shared playback">led by {s.orchestrator.name}</span>}
      </div>

      <div className="transport" role="toolbar" aria-label="Transport">
        <button className="tbtn" onClick={() => s.seek(0)} title="Go to start" aria-label="Go to start">⏮</button>
        <button className={`tbtn play ${s.playing ? 'on' : ''}`} onClick={() => s.play()} title="Play / Stop (Space)" aria-label={s.playing ? 'Stop' : 'Play'}>
          {s.playing ? '■' : '▶'}
        </button>
        <button className={`tbtn rec ${e.recording ? 'on' : ''}`} onClick={() => s.record()} title="Record (Shift+R)" aria-label="Record">●</button>
        <div className="lcd" title="Bar . Beat . Sixteenth">
          <span ref={pos} className="lcd-pos">1.1.1</span>
          <label className="lcd-bpm">
            <input
              type="number" min={40} max={240} value={p.bpm} aria-label="Tempo"
              onChange={(ev) => { const v = Number(ev.target.value); if (v >= 40 && v <= 240) s.edit((d) => M.setProject(d, { bpm: v })); }}
            /><span>bpm</span>
          </label>
          <label className="lcd-sig">
            <select value={p.sig} aria-label="Beats per bar" onChange={(ev) => s.edit((d) => M.setProject(d, { sig: Number(ev.target.value) }))}>
              {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}/4</option>)}
            </select>
          </label>
        </div>
        <button className={`tbtn small ${p.loopOn ? 'on' : ''}`} onClick={() => s.edit((d) => M.setProject(d, { loopOn: !p.loopOn }))} title="Cycle (loop) region">⟳</button>
        <button className={`tbtn small ${e.settings.metronome ? 'on' : ''}`} onClick={() => { e.settings.metronome = !e.settings.metronome; s.bump(); }} title="Metronome (only you hear it)">Click</button>
        <button className={`tbtn small ${e.settings.countIn ? 'on' : ''}`} onClick={() => { e.settings.countIn = !e.settings.countIn; s.saveSettings(); s.bump(); }} title="Count-in one bar before recording">Count-in</button>
      </div>

      <div className="topbar-right">
        <button className="ghost latency" onClick={onSettings} title="Audio latency: output / input+output round trip. Click to calibrate.">
          <span className="muted">lat</span> {(lat.output * 1000).toFixed(0)}<span className="muted">/</span>{(lat.roundTrip * 1000).toFixed(0)}ms
          {e.settings.roundTripMs == null && <span className="warn-dot" title="Not calibrated" />}
        </button>
        <button className={`ghost ${e.jamRecording ? 'rec-on' : ''}`} onClick={() => s.toggleJamRecording()} title="Record everything you hear, including friends' live audio, to a WAV file">
          {e.jamRecording ? '● Stop capture' : '◉ Capture jam'}
        </button>
        <div className="menu-wrap">
          <button className="ghost" onClick={() => setMenu(!menu)} aria-expanded={menu}>Export ▾</button>
          {menu && (
            <div className="menu" onClick={() => setMenu(false)}>
              <button onClick={() => s.exportMix()}>Mixdown (WAV 24-bit)</button>
              <button onClick={() => s.exportMix(true)}>Stems, one WAV per track</button>
              <button onClick={() => s.exportMidi()}>MIDI file (.mid)</button>
              <hr />
              <button onClick={() => s.session.undo.undo()}>Undo (⌘Z)</button>
              <button onClick={() => s.session.undo.redo()}>Redo (⇧⌘Z)</button>
            </div>
          )}
        </div>
        <button className="ghost icon" onClick={onSettings} title="Audio settings" aria-label="Audio settings">⚙</button>
        <button className="ghost icon" onClick={onToggleSide} title="Show or hide people & chat" aria-label="Toggle people panel">
          👥{s.unread > 0 && <span className="badge">{s.unread}</span>}
        </button>
      </div>
    </header>
  );
}
