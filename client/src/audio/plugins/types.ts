// WeMake plugin API.
//
// A plugin is a plain object describing parameters plus a factory that builds
// Web Audio nodes. The same definition runs in the realtime AudioContext and in
// the OfflineAudioContext used for bouncing, so factories must only use the
// BaseAudioContext passed in `host.ctx`.
//
// Third-party plugins: publish an ES module whose default export is a
// PluginDef (or `(api) => PluginDef`), then add it in the FX rack with
// "Load plugin from URL". WAM 2.0 plugins (webaudiomodules.com) are also
// supported via the `wam:` prefix.

export interface ParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  unit?: string;
  scale?: 'lin' | 'log';
  options?: string[]; // discrete choice; value is the index
}

export interface PluginHost {
  ctx: BaseAudioContext;
  bpm: () => number;
  /** Lazily initialised WAM host group (realtime context only). */
  wamGroupId?: () => Promise<string>;
}

export interface PluginInstance {
  /** Audio input (null for instruments). */
  input: AudioNode | null;
  output: AudioNode;
  /** Parameters discovered at runtime (e.g. WAM plugins); overrides def.params. */
  params?: ParamDef[];
  setParam(id: string, value: number): void;
  noteOn?(note: number, velocity: number, time: number): void;
  noteOff?(note: number, time: number): void;
  /** Schedule a complete note (used by the sequencer and the offline bounce). */
  playNote?(note: number, velocity: number, time: number, duration: number): void;
  allNotesOff?(time?: number): void;
  /** Optional custom editor (WAM plugins ship their own GUI). */
  createGui?(): Promise<HTMLElement>;
  /** Current parameter values as the plugin sees them (WAM GUIs can change them directly). */
  getParamValues?(): Promise<Record<string, number>>;
  dispose(): void;
}

export interface PluginDef {
  type: string;
  name: string;
  kind: 'fx' | 'instrument';
  category?: string;
  description?: string;
  params: ParamDef[];
  presets?: { name: string; params: Record<string, number> }[];
  create(host: PluginHost, values: Record<string, number>): PluginInstance | Promise<PluginInstance>;
}

/** Resolve the effective value of every parameter: explicit > preset > default. */
export function resolveParams(def: Pick<PluginDef, 'params' | 'presets'>, values: Record<string, number>, params = def.params) {
  const preset = def.presets?.[values.preset ?? 0]?.params ?? {};
  const out: Record<string, number> = {};
  for (const p of params) out[p.id] = values[p.id] ?? preset[p.id] ?? p.default;
  return out;
}

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0.000001 ? -Infinity : 20 * Math.log10(g));

/** Smoothly move an AudioParam to avoid zipper noise. */
export function ramp(param: AudioParam, value: number, ctx: BaseAudioContext, tc = 0.015) {
  if (!Number.isFinite(value)) return;
  const t = ctx.currentTime;
  try {
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, tc);
  } catch {
    param.value = value;
  }
}
