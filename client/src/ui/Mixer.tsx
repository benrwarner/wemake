import * as M from '../../../shared/model';
import { Knob, Meter } from './controls';
import { fmtDb, useStudio } from './hooks';

const PAN = { id: 'pan', name: 'Pan', min: -1, max: 1, default: 0, step: 0.01 };

export function Mixer() {
  const s = useStudio();
  const { order, tracks, project } = s.snap;
  return (
    <div className="mixer">
      {order.map((id) => {
        const t = tracks[id];
        return (
          <div key={id} className={`strip ${s.selectedTrack === id ? 'selected' : ''}`} style={{ ['--tc' as string]: t.color }} onPointerDown={() => s.selectTrack(id)}>
            <div className="strip-name" title={t.name}>{t.name}</div>
            <div className="strip-fx">{t.fx.filter((f) => !f.bypass).length ? `${t.fx.filter((f) => !f.bypass).length} effect${t.fx.filter((f) => !f.bypass).length > 1 ? 's' : ''}` : 'No effects'}</div>
            <Knob p={PAN} value={t.pan} size={36} color={t.color} onChange={(v) => s.edit((d) => M.setTrack(d, id, { pan: Math.abs(v) < 0.03 ? 0 : v }))} />
            <div className="strip-fader">
              <Meter vertical read={() => s.meter(id)} />
              <input type="range" className="vfader" min={-60} max={6} step={0.5} value={t.volume} aria-label={`${t.name} volume`}
                onChange={(e) => s.edit((d) => M.setTrack(d, id, { volume: Number(e.target.value) }))}
                onDoubleClick={() => s.edit((d) => M.setTrack(d, id, { volume: 0 }))} />
            </div>
            <div className="strip-db">{fmtDb(t.volume)}</div>
            <div className="strip-btns">
              <button className={`msr m ${t.mute ? 'on' : ''}`} aria-pressed={t.mute} aria-label={`Mute ${t.name}`} title="Mute" onClick={() => s.edit((d) => M.setTrack(d, id, { mute: !t.mute }))}>M</button>
              <button className={`msr s ${t.solo ? 'on' : ''}`} aria-pressed={t.solo} aria-label={`Solo ${t.name}`} title="Solo" onClick={() => s.edit((d) => M.setTrack(d, id, { solo: !t.solo }))}>S</button>
            </div>
          </div>
        );
      })}
      {s.peerList().length > 0 && <div className="strip-sep" title="These levels only change what you hear">Friends live</div>}
      {s.peerList().map((p) => {
        const db = s.peerVolume.get(p.id) ?? 0;
        return (
          <div key={p.id} className="strip peer" style={{ ['--tc' as string]: p.color }}>
            <div className="strip-name">{p.name}</div>
            <div className="strip-fx">{p.state.live === false ? 'muted' : 'live'}</div>
            <div className="strip-fader">
              <Meter vertical read={() => s.meter(`peer:${p.id}`)} />
              <input type="range" className="vfader" min={-60} max={6} step={0.5} value={db} aria-label={`${p.name} volume`}
                onChange={(e) => s.setPeerVolume(p.id, Number(e.target.value))} onDoubleClick={() => s.setPeerVolume(p.id, 0)} />
            </div>
            <div className="strip-db">{fmtDb(db)}</div>
          </div>
        );
      })}
      <div className="strip master">
        <div className="strip-name">Master</div>
        <div className="strip-fx">limiter</div>
        <div className="strip-fader">
          <Meter vertical read={() => s.meter('master')} />
          <input type="range" className="vfader" min={-60} max={6} step={0.5} value={project.master} aria-label="Master volume"
            onChange={(e) => s.edit((d) => M.setProject(d, { master: Number(e.target.value) }))} onDoubleClick={() => s.edit((d) => M.setProject(d, { master: 0 }))} />
        </div>
        <div className="strip-db">{fmtDb(project.master)}</div>
      </div>
    </div>
  );
}
