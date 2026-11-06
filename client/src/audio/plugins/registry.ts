// Plugin registry: built-ins, external ES-module plugins and WAM 2.0 plugins.
import { FX } from './fx';
import { INSTRUMENTS } from './instruments';
import { type PluginDef, type PluginHost, type PluginInstance, type ParamDef, dbToGain, ramp, resolveParams } from './types';

const defs = new Map<string, PluginDef>();
for (const d of [...FX, ...INSTRUMENTS]) defs.set(d.type, d);

export const builtinFx = () => FX;
export const builtinInstruments = () => INSTRUMENTS;

// ---------- trust (external code runs in every participant's browser) ----------
const TRUST_KEY = 'wemake.trustedPlugins';
function loadTrusted(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(TRUST_KEY) ?? '[]')); } catch { return new Set(); }
}
const trusted = loadTrusted();
const trustListeners = new Set<() => void>();
export const isExternal = (type: string) => type.startsWith('ext:') || type.startsWith('wam:');
export const externalUrl = (type: string) => type.slice(4);
/** Host of an external plugin URL, or a placeholder if it's malformed (it comes from shared, untrusted data). */
export function safeHost(type: string) { try { return new URL(externalUrl(type)).host; } catch { return 'invalid URL'; } }
export function shortPluginName(type: string) {
  try { return new URL(externalUrl(type)).pathname.split('/').filter(Boolean).slice(-2).join('/') || safeHost(type); } catch { return 'invalid plugin'; }
}
export const isTrusted = (type: string) => !isExternal(type) || trusted.has(externalUrl(type));
export function trustPlugin(type: string) {
  trusted.add(externalUrl(type));
  try { localStorage.setItem(TRUST_KEY, JSON.stringify([...trusted])); } catch { /* storage unavailable */ }
  trustListeners.forEach((f) => f());
}
export const onTrustChange = (f: () => void) => { trustListeners.add(f); return () => trustListeners.delete(f); };

export function validatePluginUrl(url: string) {
  const u = new URL(url, location.href);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('Plugin URLs must use https');
  return u.href;
}

// ---------- external ES-module plugins ----------
const pluginApi = { dbToGain, ramp, resolveParams, version: 1 };
const loading = new Map<string, Promise<PluginDef>>();

async function loadExternal(type: string): Promise<PluginDef> {
  const url = externalUrl(type);
  const mod = await import(/* @vite-ignore */ url);
  let def = mod.default as PluginDef | ((api: typeof pluginApi) => PluginDef);
  if (typeof def === 'function') def = def(pluginApi);
  if (!def || typeof def.create !== 'function' || !Array.isArray(def.params)) throw new Error('Module does not export a WeMake PluginDef');
  return { ...def, type };
}

// ---------- WAM 2.0 ----------
function wamDef(type: string): PluginDef {
  const url = externalUrl(type);
  let name = 'WAM';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter((s) => s && !/\.js$/.test(s)).pop() ?? 'WAM'); } catch { /* keep default */ }
  return {
    type, name, kind: 'fx', category: 'WAM 2.0', params: [],
    async create(host: PluginHost): Promise<PluginInstance> {
      if (!host.wamGroupId) throw new Error('WAM plugins are not available in offline render');
      const groupId = await host.wamGroupId();
      const mod = await import(/* @vite-ignore */ url);
      const inst = await mod.default.createInstance(groupId, host.ctx);
      const node = inst.audioNode;
      const info: Record<string, any> = await node.getParameterInfo();
      const params: ParamDef[] = Object.values(info).map((i) => ({
        id: i.id, name: i.label || i.id, min: i.minValue, max: i.maxValue, default: i.defaultValue,
        step: i.discreteStep || undefined, options: i.type === 'choice' ? i.choices : undefined,
      }));
      const midi = (bytes: number[], time: number) => node.scheduleEvents({ type: 'wam-midi', time, data: { bytes } });
      const isInstrument = !!inst.descriptor?.isInstrument;
      return {
        input: isInstrument ? null : node,
        output: node,
        params,
        setParam: (id, value) => node.setParameterValues({ [id]: { id, value, normalized: false, interpolate: true } }),
        noteOn: (n, v, t) => midi([0x90, n, Math.max(1, Math.round(v * 127))], t),
        noteOff: (n, t) => midi([0x80, n, 0], t),
        playNote(n, v, t, d) { midi([0x90, n, Math.max(1, Math.round(v * 127))], t); midi([0x80, n, 0], t + d); },
        allNotesOff: (t = host.ctx.currentTime) => midi([0xb0, 123, 0], t),
        createGui: () => inst.createGui(),
        dispose() { try { node.disconnect(); node.destroy?.(); } catch { /* already gone */ } },
      };
    },
  };
}

/** Synchronous lookup (built-ins, or externals already loaded). */
export const getDef = (type: string) => defs.get(type);

/** Resolve a definition, loading external modules on demand. */
export async function loadDef(type: string): Promise<PluginDef> {
  const known = defs.get(type);
  if (known) return known;
  if (!isExternal(type)) throw new Error(`Unknown plugin "${type}"`);
  if (!isTrusted(type)) throw new Error('Plugin not trusted on this device');
  try { validatePluginUrl(externalUrl(type)); } catch { throw new Error('Invalid plugin URL'); }
  let p = loading.get(type);
  if (!p) {
    p = type.startsWith('wam:') ? Promise.resolve(wamDef(type)) : loadExternal(type);
    loading.set(type, p);
    p.then((d) => defs.set(type, d), () => loading.delete(type));
  }
  return p;
}

/** Create an instance and apply its initial parameter values. */
export async function instantiate(type: string, host: PluginHost, values: Record<string, number>) {
  const def = await loadDef(type);
  const inst = await def.create(host, resolveParams(def, values));
  const resolved = resolveParams(def, values, inst.params ?? def.params);
  for (const [k, v] of Object.entries(resolved)) inst.setParam(k, v);
  return { def, inst, applied: resolved };
}
