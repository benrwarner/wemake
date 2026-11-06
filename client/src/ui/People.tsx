import { useEffect, useRef, useState } from 'react';
import { Meter } from './controls';
import { useStudio } from './hooks';

export function People() {
  const s = useStudio();
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const peers = s.peerList();
  const e = s.engine;
  useEffect(() => { if (s.unread) { s.unread = 0; } log.current?.scrollTo({ top: 1e9 }); }, [s.session.chatLog.length, s]);
  const trackName = (id?: string) => (id ? s.snap.tracks[id]?.name : undefined);
  return (
    <aside className="side">
      <section className="people">
        <h3>In the room <span className="count">{peers.length + 1}</span></h3>
        {s.tunedIn && peers.length > 0 && (
          <label className="check small mirror" title="Use the orchestrator's volume for each friend so you hear exactly what they hear">
            <input type="checkbox" checked={s.mirrorMix} onChange={(ev) => s.setMirrorMix(ev.target.checked)} /> Hear the orchestrator's mix
          </label>
        )}
        <div className="person me">
          <span className="avatar" style={{ background: s.color }}>{s.name[0]?.toUpperCase()}</span>
          <div className="person-body">
            <div className="person-name">{s.name} <span className="muted">(you)</span></div>
            <div className="person-status">
              {e.recording ? <span className="pill rec">● recording</span> : null}
              {trackName(e.armedAudio ?? undefined) && <span className="pill">🎙 {trackName(e.armedAudio ?? undefined)}</span>}
              {trackName(e.armedInstrument ?? undefined) && <span className="pill">🎹 {trackName(e.armedInstrument ?? undefined)}</span>}
              {!e.armedAudio && !e.armedInstrument && <span className="muted small">press R on a track to play</span>}
            </div>
            {e.hasInput && <Meter read={() => s.meter('input')} />}
          </div>
          <button className={`live-toggle ${e.live ? 'on' : ''}`} onClick={() => s.setLive(!e.live)} title="Send your live input to the room">{e.live ? 'LIVE' : 'muted'}</button>
        </div>
        {peers.map((p) => {
          const st = s.peerStats.get(p.id);
          const quality = !st ? 'unknown' : st.oneWay < 40 ? 'good' : st.oneWay < 80 ? 'ok' : 'bad';
          return (
            <div key={p.id} className="person">
              <span className="avatar" style={{ background: p.color }}>{p.name[0]?.toUpperCase()}</span>
              <div className="person-body">
                <div className="person-name">{p.name}</div>
                <div className="person-status">
                  {p.state.recording && <span className="pill rec">● recording</span>}
                  {trackName(p.state.track) && <span className="pill">{trackName(p.state.track)}</span>}
                  {p.state.live === false && <span className="pill muted">mic off</span>}
                  {p.state.tunedIn === false ? <span className="pill muted" title="Listening privately">private</span> : <span className="pill tuned" title="Hearing the shared playback">🎧</span>}
                  {s.orchestrator?.id === p.id && <span className="pill lead">leading</span>}
                  <span className={`lat ${quality}`} title={st ? `round trip ${st.rtt.toFixed(0)} ms · jitter buffer ${st.jitterBuffer.toFixed(0)} ms · loss ${(st.loss * 100).toFixed(1)}% · ${(st.bitrate / 1000).toFixed(0)} kbps` : 'connecting…'}>
                    {st ? `~${st.oneWay.toFixed(0)} ms` : '…'}
                  </span>
                </div>
                <Meter read={() => s.meter(`peer:${p.id}`)} />
              </div>
            </div>
          );
        })}
        {peers.length === 0 && (
          <button className="invite" onClick={() => {
            const url = `${location.origin}${location.pathname}?room=${s.room}`;
            navigator.clipboard?.writeText(url).then(() => s.toast('Invite link copied'), () => s.toast(url));
          }}>Invite friends: copy link</button>
        )}
      </section>
      <section className="chat">
        <div className="chat-log" ref={log}>
          {s.session.chatLog.length === 0 && <div className="muted small">Chat with the room. Plan the next take, call out chord changes…</div>}
          {s.session.chatLog.map((m, i) => (
            <div key={i} className="msg"><b style={{ color: m.color }}>{m.name}</b> {m.text}</div>
          ))}
        </div>
        <form onSubmit={(ev) => { ev.preventDefault(); if (text.trim()) { s.session.chat(text.trim()); setText(''); } }}>
          <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Message the room" maxLength={500} aria-label="Chat message" />
        </form>
      </section>
    </aside>
  );
}
