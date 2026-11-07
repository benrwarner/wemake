import { useEffect, useRef, useState } from 'react';
import { Meter } from './controls';
import { useStudio } from './hooks';
import { Icon } from './Icon';
import { CollapseButton } from './Collapse';

export function People({ pos, collapsed, onToggle }: { pos: 'left' | 'right'; collapsed: boolean; onToggle: () => void }) {
  return collapsed ? <PeopleRail pos={pos} onToggle={onToggle} /> : <PeopleFull pos={pos} onToggle={onToggle} />;
}

/** The collapsed people panel: who's here and unread chat, one click to open. */
function PeopleRail({ pos, onToggle }: { pos: 'left' | 'right'; onToggle: () => void }) {
  const s = useStudio();
  const peers = s.peerList();
  return (
    <aside className={`side rail pos-${pos}`} aria-label="People and chat (collapsed)">
      <CollapseButton collapsed edge={pos} label="people and chat" onClick={onToggle} />
      <button className="icon-btn rail-btn" onClick={onToggle} title={`${peers.length + 1} in the room`} aria-label={`${peers.length + 1} in the room. Open people panel`}>
        <Icon name="people" size={17} /><span className="rail-count">{peers.length + 1}</span>
      </button>
      <div className="rail-avatars">
        <span className="avatar" style={{ background: s.color }} title={`${s.name} (you)`}>{s.name[0]?.toUpperCase()}</span>
        {peers.slice(0, 6).map((p) => <span key={p.id} className={`avatar ${p.state.recording ? 'rec' : ''}`} style={{ background: p.color }} title={p.name}>{p.name[0]?.toUpperCase()}</span>)}
      </div>
      <button className="icon-btn rail-btn" onClick={onToggle} title="Chat" aria-label={s.unread ? `Chat, ${s.unread} unread` : 'Chat'}>
        <Icon name="chat" size={17} />{s.unread > 0 && <span className="badge">{s.unread}</span>}
      </button>
    </aside>
  );
}

function PeopleFull({ pos, onToggle }: { pos: 'left' | 'right'; onToggle: () => void }) {
  const s = useStudio();
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const peers = s.peerList();
  const e = s.engine;
  useEffect(() => { if (s.unread) { s.unread = 0; } log.current?.scrollTo({ top: 1e9 }); }, [s.session.chatLog.length, s]);
  const trackName = (id?: string) => (id ? s.snap.tracks[id]?.name : undefined);
  return (
    <aside className={`side pos-${pos}`}>
      <section className="people">
        <h3>In the room <span className="count">{peers.length + 1}</span><span className="spacer" /><CollapseButton collapsed={false} edge={pos} label="people and chat" onClick={onToggle} /></h3>
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
              {e.recording ? <span className="pill rec">Recording</span> : null}
              {trackName(e.armedAudio ?? undefined) && <span className="pill"><Icon name="mic" size={11} />{trackName(e.armedAudio ?? undefined)}</span>}
              {trackName(e.armedInstrument ?? undefined) && <span className="pill"><Icon name="keys" size={11} />{trackName(e.armedInstrument ?? undefined)}</span>}
              {!e.armedAudio && !e.armedInstrument && <span className="muted small">Press R on a track to play</span>}
            </div>
            {e.hasInput && <Meter read={() => s.meter('input')} />}
          </div>
          <button className={`live-toggle ${e.live ? 'on' : ''}`} onClick={() => s.setLive(!e.live)} aria-pressed={e.live} title={e.live ? 'Friends hear your live input. Click to mute it for the room' : 'Your live input is muted for the room. Click to send it'}><Icon name="mic" size={12} />{e.live ? 'Live' : 'Muted'}</button>
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
                  {p.state.recording && <span className="pill rec">Recording</span>}
                  {trackName(p.state.track) && <span className="pill">{trackName(p.state.track)}</span>}
                  {p.state.live === false && <span className="pill muted">mic off</span>}
                  {p.state.tunedIn === false ? <span className="pill muted" title="Listening privately">private</span> : <span className="pill tuned" title="Hearing the shared playback"><Icon name="headphones" size={12} /></span>}
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
          <div className="invite-card">
            <p className="muted small">It's just you so far. Send friends the link to jam together.</p>
            <button className="primary invite" onClick={() => {
              const url = `${location.origin}${location.pathname}?room=${s.room}`;
              navigator.clipboard?.writeText(url).then(() => s.toast('Invite link copied. Send it to your friends.'), () => s.toast(url));
            }}><Icon name="link" />Copy invite link</button>
          </div>
        )}
      </section>
      <section className="chat" aria-label="Chat">
        <h3 className="chat-title"><Icon name="chat" size={14} />Chat</h3>
        <div className="chat-log" ref={log}>
          {s.session.chatLog.length === 0 && <div className="muted small chat-empty">Plan the next take or call out chord changes here.</div>}
          {s.session.chatLog.map((m, i) => {
            const prev = s.session.chatLog[i - 1];
            const cont = prev && prev.from === m.from && m.ts - prev.ts < 120000;
            return (
              <div key={i} className={`msg ${m.from === s.session.myId ? 'mine' : ''} ${cont ? 'cont' : ''}`}>
                {!cont && <span className="msg-name"><span className="tc-dot" style={{ background: m.color }} />{m.name}</span>}
                <span className="msg-text">{m.text}</span>
              </div>
            );
          })}
        </div>
        <form className="chat-form" onSubmit={(ev) => { ev.preventDefault(); if (text.trim()) { s.session.chat(text.trim()); setText(''); } }}>
          <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Message the room" maxLength={500} aria-label="Chat message" />
          <button type="submit" className="icon-btn" disabled={!text.trim()} aria-label="Send message"><Icon name="send" size={15} /></button>
        </form>
      </section>
    </aside>
  );
}
