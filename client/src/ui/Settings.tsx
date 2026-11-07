import { useEffect, useState } from 'react';
import { Meter } from './controls';
import { useStudio } from './hooks';
import { Icon } from './Icon';

export function Settings({ onClose }: { onClose: () => void }) {
  const s = useStudio();
  const e = s.engine;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === 'audioinput')));
  }, [e.hasInput]);
  useEffect(() => {
    const k = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const lat = e.latency;
  const hint = e.settings.latencyHint;
  return (
    <div className="modal-back" onPointerDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Audio settings">
        <header>
          <div className="modal-title"><h2>Settings</h2><span className="muted small">Audio, latency and session access</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" autoFocus><Icon name="x" /></button>
        </header>

        <PasswordSection />

        <section>
          <h4><Icon name="mic" />Input</h4>
          <div className="row">
            <select value={s.inputDevice} onChange={async (ev) => {
              s.inputDevice = ev.target.value; s.saveSettings();
              if (e.hasInput) { try { await e.openInput(s.inputDevice || undefined); } catch (err) { s.toast((err as Error).message, 'error'); } }
              s.bump();
            }}>
              <option value="">Default input</option>
              {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${d.deviceId.slice(0, 6)}`}</option>)}
            </select>
            {!e.hasInput
              ? <button onClick={async () => { try { await e.openInput(s.inputDevice || undefined); s.bump(); } catch (err) { s.toast((err as Error).message, 'error'); } }}>Open input</button>
              : <span className="muted small">{e.inputChannels === 2 ? 'stereo' : 'mono'} · voice processing off</span>}
          </div>
          {e.hasInput && <Meter read={() => s.meter('input')} />}
          <label className="row">Input gain
            <input type="range" min={0} max={4} step={0.05} defaultValue={e.inputGain.gain.value} onChange={(ev) => e.inputGain.gain.setTargetAtTime(Number(ev.target.value), e.ctx.currentTime, 0.01)} />
          </label>
          <label className="check"><input type="checkbox" checked={e.settings.monitor} onChange={(ev) => { e.setMonitor(ev.target.checked); s.saveSettings(); }} /> Software monitoring (turn off if your audio interface has direct monitoring)</label>
        </section>

        <section>
          <h4><Icon name="countin" />Your latency</h4>
          <dl className="stats">
            <dt>Output</dt><dd>{(lat.output * 1000).toFixed(1)} ms</dd>
            <dt>Record round trip</dt><dd>{(lat.roundTrip * 1000).toFixed(1)} ms {e.settings.roundTripMs == null ? <span className="muted">(estimated)</span> : <span className="ok">(measured)</span>}</dd>
            <dt>Sample rate</dt><dd>{e.ctx.sampleRate} Hz</dd>
          </dl>
          <p className="muted small">Calibrate so recorded takes line up exactly with the beat. Turn your speakers up (or loop an output cable into your input) and hold still. Five clicks will play.</p>
          <div className="row">
            <button disabled={busy || !e.hasInput} onClick={async () => {
              setBusy(true); setMsg('Listening…');
              try { const ms = await e.calibrate(); s.saveSettings(); setMsg(`Measured ${ms} ms round trip. Takes are now compensated.`); }
              catch (err) { setMsg((err as Error).message); }
              setBusy(false); s.bump();
            }}>{busy ? 'Calibrating…' : 'Calibrate recording latency'}</button>
            {e.settings.roundTripMs != null && <button className="ghost" onClick={() => { e.settings.roundTripMs = null; s.saveSettings(); s.bump(); }}>Reset</button>}
          </div>
          {!e.hasInput && <p className="muted small">Open an input first.</p>}
          {msg && <p className="small">{msg}</p>}
          <label className="row">Manual offset (ms)
            <input type="number" step={0.5} value={e.settings.roundTripMs ?? ''} placeholder={(lat.roundTrip * 1000).toFixed(1)}
              onChange={(ev) => { e.settings.roundTripMs = ev.target.value === '' ? null : Number(ev.target.value); s.saveSettings(); s.bump(); }} />
          </label>
          <label className="row">Audio buffer
            <select value={String(hint)} onChange={(ev) => {
              const v = ev.target.value;
              e.settings.latencyHint = /^\d/.test(v) ? Number(v) : (v as AudioContextLatencyCategory);
              s.saveSettings();
              s.toast('Rejoin the session to apply the new buffer size.');
              s.bump();
            }}>
              <option value="0">Smallest (lowest latency, may crackle)</option>
              <option value="interactive">Interactive (recommended)</option>
              <option value="balanced">Balanced (slow computers)</option>
              <option value="playback">Large (most stable)</option>
            </select>
          </label>
        </section>

        <section>
          <h4><Icon name="people" />Network jam</h4>
          <p className="muted small">Friends' live audio goes peer-to-peer (Opus, 256 kbps, 10 ms packets). Instruments are sent as MIDI and played on your computer, so they arrive at full quality as fast as the network allows. A smaller jitter buffer means lower delay but more dropouts.</p>
          <label className="row">Jitter buffer target
            <input type="range" min={0} max={150} step={5} value={s.jitterTarget} onChange={(ev) => s.setJitterTarget(Number(ev.target.value))} />
            <span className="mono">{s.jitterTarget === 0 ? 'auto-min' : `${s.jitterTarget} ms`}</span>
          </label>
          <label className="check"><input type="checkbox" checked={e.live} onChange={(ev) => s.setLive(ev.target.checked)} /> Send my live input to the room</label>
          <p className="muted small">Clock sync with server: ±{(s.session.rtt / 2).toFixed(1)} ms</p>
        </section>
      </div>
    </div>
  );
}

function PasswordSection() {
  const s = useStudio();
  const [pw, setPw] = useState('');
  const locked = s.session.locked;
  return (
    <section>
      <h4><Icon name="lock" />Session password {locked ? <span className="status-chip ok">Locked</span> : <span className="status-chip">Open to anyone with the link</span>}</h4>
      <p className="muted small">People already in the session stay connected. New people need the password. Share it separately from the link.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (pw.length >= 4) { s.session.setPassword(pw); setPw(''); } }}>
        <input type="password" autoComplete="new-password" value={pw} minLength={4} onChange={(e) => setPw(e.target.value)} placeholder={locked ? 'New password' : 'Set a password (4+ characters)'} />
        <button type="submit" disabled={pw.length < 4}>{locked ? 'Change' : 'Lock session'}</button>
        {locked && <button type="button" className="ghost" onClick={() => s.session.setPassword(null)}>Remove</button>}
      </form>
    </section>
  );
}
