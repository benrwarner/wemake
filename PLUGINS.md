# Writing WeMake plugins

WeMake loads two kinds of external plugin by URL, from the **Effects → ＋ Add effect → External** menu or from the instrument picker:

| Kind | Prefix stored in the session | What it is |
|------|------------------------------|-----------|
| **WAM 2.0** | `wam:` | Any [Web Audio Modules 2.0](https://www.webaudiomodules.com) plugin. Point at its `index.js`. It gets its own GUI ("Open plugin window"), its parameters are discovered automatically, and MIDI is sent to instruments. |
| **WeMake plugin** | `ext:` | A plain ES module that you write (format below). It's the easiest option and runs in offline bounces too. |

The plugin URL is stored in the shared session, so every participant loads the same plugin. **External code runs in each person's browser**, so each person sees a "Trust & load" prompt the first time. Whoever adds a plugin trusts it automatically. Trust is remembered per browser (`localStorage`). URLs must be `https` (or `localhost`) and serve JS with CORS enabled.

## WeMake plugin format

Default-export a `PluginDef`, or a function `(api) => PluginDef`:

```js
// bitcrusher.js: host it anywhere that serves JS with CORS
export default ({ ramp, dbToGain }) => ({
  type: 'bitcrusher',            // replaced by the URL when loaded
  name: 'Bitcrusher',
  kind: 'fx',                    // 'fx' | 'instrument'
  category: 'Distortion',
  params: [
    { id: 'bits', name: 'Bits', min: 1, max: 16, default: 6, step: 1 },
    { id: 'mix',  name: 'Mix',  min: 0, max: 1,  default: 1 },
    { id: 'mode', name: 'Mode', min: 0, max: 1,  default: 0, options: ['Hard', 'Soft'] }, // options => dropdown
  ],
  // host.ctx is a BaseAudioContext (realtime OR OfflineAudioContext for bounces): only use it.
  create(host, values) {
    const { ctx } = host;
    const input = ctx.createGain(), output = ctx.createGain();
    const shaper = ctx.createWaveShaper(), wet = ctx.createGain(), dry = ctx.createGain();
    input.connect(shaper).connect(wet).connect(output);
    input.connect(dry).connect(output);
    const curve = (bits) => {
      const n = 4096, c = new Float32Array(n), q = 2 ** bits;
      for (let i = 0; i < n; i++) c[i] = Math.round((i / (n - 1) * 2 - 1) * q) / q;
      return c;
    };
    return {
      input, output,
      setParam(id, v) {                       // called once per param at start, then on every change
        if (id === 'bits') shaper.curve = curve(v);
        if (id === 'mix') { ramp(wet.gain, v, ctx); ramp(dry.gain, 1 - v, ctx); }
      },
      dispose() { [input, output, shaper, wet, dry].forEach((n) => n.disconnect()); },
    };
  },
});
```

### Instruments

Set `kind: 'instrument'`, return `input: null`, and implement:

- `noteOn(note, velocity0to1, time)` / `noteOff(note, time)`: live playing (local keyboard, MIDI controller, or a friend's notes arriving over the network).
- `playNote(note, velocity, time, durationSeconds)`: used by the sequencer and the offline bounce. Times are in `ctx` seconds and may be in the future. Schedule them, don't play them immediately.
- `allNotesOff(time?)`: transport stop / panic.

### Rules for good behaviour

- **Zero added latency.** Build from native nodes or an AudioWorklet that processes in place. Don't add lookahead buffers, or live monitoring gets worse for everyone.
- **Deterministic.** Every participant renders the song locally, so the same parameters must produce the same sound. Seed any randomness.
- **Optional extras:** `presets: [{ name, params }]` adds preset buttons. `host.bpm()` gives the session tempo for tempo-synced effects. `createGui(): Promise<HTMLElement>` adds an "Open plugin window" button.
- The `api` object passed to factory-style modules includes `ramp(param, value, ctx)` (click-free parameter changes), `dbToGain`, `resolveParams` and `version`.

Built-in plugins in `client/src/audio/plugins/fx.ts` and `instruments.ts` use exactly this API and are good references.
