# WeMake

A collaborative studio in the browser. Friends join one session link, hear the same song, jam live, record takes, and mix together, with GarageBand-style monitoring and a plugin rack.

```bash
npm install
npm run dev          # http://localhost:5173  (server on :8787 + Vite)
npm test             # model + server integration tests
npm run build && npm start   # production: one process serves app + API on $PORT
```

**Wear headphones.** Voice processing is disabled for music quality, so speakers will feed back into your mic.

## How it works

| Need | Approach |
|------|----------|
| Everyone hears the same song | Each browser renders the arrangement **locally** (sample-accurate, full quality) on a shared clock. The server runs NTP-style ping/pong sync, and `AudioContext.getOutputTimestamp()` converts that to *speaker* time, so playback lines up across machines (measured ≈1 ms apart in two local browsers). Late joiners come in at the right beat. |
| Shared editing | Tracks, clips, notes, plugin chains and every knob live in one **Yjs CRDT** document. Concurrent edits merge, and undo/redo only affects your own changes. Rooms persist to `data/`. |
| Live jamming | Mic/guitar goes **peer-to-peer over WebRTC** with Opus tuned for music: stereo, 256 kbps, FEC, 10 ms packets, DTX off, browser AEC/NS/AGC off, minimum jitter buffer (adjustable). **Instruments send MIDI** over a data channel, and every listener plays the notes on their own synth, so there's no codec or jitter buffer and quality is full. |
| Live monitoring | Arm an audio track (R) to route your input → that track's effects → your ears, with the smallest available buffer setting. The live chain is a separate set of plugin instances, so friends receive only your performance, not a second copy of the song. |
| Recording | A capture AudioWorklet stamps the exact start frame. Takes are shifted by your **measured round-trip latency** (Settings → Calibrate) so they land on the beat. Count-in, punch-in during a loop, and MIDI recording from the computer keyboard (A–K) or any Web MIDI controller. Takes upload as 24-bit WAV and appear for everyone. |
| Shared vs private listening | **🎧 Shared** (default): you follow the room's playback, driven by whoever last pressed play/stop (the *orchestrator*, shown as "led by…"). Optionally mirror their volumes for each friend so you hear exactly their mix. **Private**: your own transport. Play, scrub and record alone while friends' live audio is muted. Your edits still sync. |
| Presence | Live cursors (in the arrangement and the piano roll, positioned musically so they're correct at any zoom), who's playing which track, who's recording, who's editing which clip, playhead positions, per-friend latency, and chat. |
| Plugins | 10 built-in effects and 3 instruments. Load **WAM 2.0** plugins or simple **WeMake plugin modules** by URL, with a per-user trust prompt. See [PLUGINS.md](PLUGINS.md). |
| Export | Mixdown, per-track stems (offline render, 24-bit WAV), and a Standard MIDI File. These open in SoundCraft, GarageBand, Logic, Ableton and others. "Capture jam" records everything you hear, including friends. |

### Privacy
Sessions can be **password protected**: set one in the lobby when creating a session, or from ⚙ Settings → Session password while inside (anyone already in can change or remove it). The server stores only a salted scrypt hash (`data/rooms/<session>.auth.json`, never in the shared document). It sends nothing about a locked session (song, people, takes, media negotiation) until the password checks out, and it limits wrong guesses to 8 per address per 10 minutes. Recorded audio is only served to participants holding a session token. Open sessions get a 64-bit random name, so the link itself is hard to guess. Share passwords separately from links.

### Deploying for friends on other networks
The server is one Node process (`npm start`). Put it behind HTTPS (required for microphone access). Peer-to-peer audio uses public STUN by default. For friends behind strict NATs, add a TURN server with `TURN_URL`, `TURN_USER` and `TURN_PASS` (or `ICE_SERVERS` as JSON). `DATA_DIR` sets where sessions and takes are stored.

### Limits worth knowing
- The mesh is peer-to-peer, so it's great for about 2–6 players. Bigger rooms would need an SFU.
- Network latency between distant players is physics. Same-city is typically 15–40 ms, which is jammable. Cross-continent isn't, which is why the shared timeline (everyone records against the same click) matters more than live jamming.
- Audio clips don't time-stretch when you change tempo.
