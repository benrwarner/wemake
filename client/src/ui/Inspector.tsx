import { useEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import type { FxSlot, Track } from '../../../shared/model';
import type { Studio } from '../state/studio';
import { builtinFx, builtinInstruments, externalUrl, getDef, isExternal, isTrusted, trustPlugin, validatePluginUrl } from '../audio/plugins/registry';
import { type ParamDef, resolveParams } from '../audio/plugins/types';
import { ParamControl } from './controls';
import { useStudio } from './hooks';

export function Inspector() {
  const s = useStudio();
  const t = s.selectedTrack ? s.snap.tracks[s.selectedTrack] : undefined;
  if (!t) return <div className="empty">Select a track to see its instrument and effects.</div>;
  return (
    <div className="inspector">
      {t.kind === 'instrument' && <InstrumentPanel s={s} t={t} />}
      {t.kind === 'audio' && <InputPanel s={s} t={t} />}
      <FxRack s={s} t={t} />
    </div>
  );
}

function InputPanel({ s, t }: { s: Studio; t: Track }) {
  const e = s.engine;
  const armed = e.armedAudio === t.id;
  return (
    <section className="panel input-panel" style={{ ['--tc' as string]: t.color }}>
      <h3>{t.name} <span className="muted">· audio</span></h3>
      <p className="muted small">Arm this track to play your mic or instrument through its effects live, so friends hear it in the jam, and record takes.</p>
      <button className={`arm-big ${armed ? 'on' : ''}`} onClick={() => s.arm(t.id)}>{armed ? '● Armed: your input is live here' : 'Arm track (R)'}</button>
      <label className="check"><input type="checkbox" checked={e.settings.monitor} onChange={(ev) => { e.setMonitor(ev.target.checked); s.saveSettings(); }} /> Monitor: hear yourself through the FX</label>
      <label className="check"><input type="checkbox" checked={e.live} onChange={(ev) => s.setLive(ev.target.checked)} /> Live to room: friends hear you</label>
      {e.hasInput && <div className="row"><span className="muted small">Input</span><MeterInline s={s} /></div>}
    </section>
  );
}

function MeterInline({ s }: { s: Studio }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const v = s.meter('input') ?? 0;
      const db = 20 * Math.log10(v || 1e-6);
      if (ref.current) ref.current.style.width = `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%`;
      id = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(id);
  }, [s]);
  return <div className="meter h grow"><div ref={ref} className="meter-fill" /></div>;
}

function InstrumentPanel({ s, t }: { s: Studio; t: Track }) {
  const spec = t.instrument!;
  const def = getDef(spec.type);
  const strip = s.engine.strip(t.id);
  const inst = strip?.instrument?.inst;
  const params: ParamDef[] = inst?.params ?? def?.params ?? [];
  const values = def ? resolveParams(def, spec.params, params) : spec.params;
  const armed = s.engine.armedInstrument === t.id;
  const [wamUrl, setWamUrl] = useState(false);
  return (
    <section className="panel instrument" style={{ ['--tc' as string]: t.color }}>
      <h3>
        <select value={spec.type} aria-label="Instrument" onChange={(e) => {
          if (e.target.value === '__wam') { setWamUrl(true); return; }
          s.edit((d) => M.setInstrument(d, t.id, e.target.value));
        }}>
          {builtinInstruments().map((d) => <option key={d.type} value={d.type}>{d.name}</option>)}
          {isExternal(spec.type) && <option value={spec.type}>{def?.name ?? 'External'}</option>}
          <option value="__wam">Load WAM instrument…</option>
        </select>
        <button className={`arm-small ${armed ? 'on' : ''}`} onClick={() => s.arm(t.id)} title="Your keyboard / MIDI controller plays this track">{armed ? '● Playing' : 'Play this'}</button>
      </h3>
      {wamUrl && (
        <UrlField placeholder="https://…/index.js (WAM 2.0 instrument)" onCancel={() => setWamUrl(false)} onSubmit={(url) => {
          try {
            const type = `wam:${validatePluginUrl(url)}`;
            trustPlugin(type);
            s.edit((d) => M.setInstrument(d, t.id, type));
            setWamUrl(false);
          } catch (err) { s.toast((err as Error).message, 'error'); }
        }} />
      )}
      {!isTrusted(spec.type) && <TrustBanner type={spec.type} />}
      {strip?.instrument?.error && strip.instrument.error !== 'untrusted' && <div className="error">⚠ {strip.instrument.error}</div>}
      {def?.presets && (
        <div className="presets">
          {def.presets.map((p, i) => (
            <button key={p.name} className={(spec.params.preset ?? 0) === i ? 'on' : ''} onClick={() => s.edit((d) => M.setInstrument(d, t.id, spec.type, { preset: i }))}>{p.name}</button>
          ))}
        </div>
      )}
      <div className="params">
        {params.filter((p) => p.id !== 'preset').map((p) => (
          <ParamControl key={p.id} p={p} value={values[p.id] ?? p.default} color={t.color}
            onChange={(v) => s.edit((d) => M.setInstrumentParam(d, t.id, p.id, v))} />
        ))}
      </div>
      {inst?.createGui && <PluginGuiButton create={() => inst.createGui!()} />}
    </section>
  );
}

function TrustBanner({ type }: { type: string }) {
  const url = externalUrl(type);
  return (
    <div className="trust">
      <p>This session uses an external plugin from <b>{new URL(url).host}</b>. It runs code in your browser.</p>
      <code>{url}</code>
      <button onClick={() => trustPlugin(type)}>Trust &amp; load</button>
    </div>
  );
}

function PluginGuiButton({ create }: { create: () => Promise<HTMLElement> }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const factory = useRef(create);
  factory.current = create;
  useEffect(() => {
    if (!open || !host.current) return;
    let el: HTMLElement | undefined;
    let cancelled = false;
    const h = host.current;
    factory.current().then((g) => { if (cancelled) return; el = g; h.appendChild(g); });
    return () => { cancelled = true; el?.remove(); };
  }, [open]);
  return (
    <>
      <button onClick={() => setOpen(!open)}>{open ? 'Close plugin window' : 'Open plugin window'}</button>
      {open && <div className="plugin-window"><div className="plugin-window-bar"><span>Plugin</span><button onClick={() => setOpen(false)}>×</button></div><div ref={host} /></div>}
    </>
  );
}

function FxRack({ s, t }: { s: Studio; t: Track }) {
  const [adding, setAdding] = useState(false);
  const [urlKind, setUrlKind] = useState<'ext' | 'wam' | null>(null);
  const add = (type: string) => { s.edit((d) => M.addFx(d, t.id, type)); setAdding(false); setUrlKind(null); };
  const addUrl = (kind: 'ext' | 'wam', url: string) => {
    try {
      const type = `${kind}:${validatePluginUrl(url)}`;
      trustPlugin(type); // you added it, so you trust it; friends get asked
      add(type);
    } catch (err) { s.toast((err as Error).message, 'error'); }
  };
  const cats = new Map<string, ReturnType<typeof builtinFx>>();
  for (const d of builtinFx()) { const c = d.category ?? 'Other'; cats.set(c, [...(cats.get(c) ?? []), d]); }
  return (
    <section className="panel fxrack">
      <h3>Effects <span className="muted small">· processed in order, top to bottom · shared with everyone</span></h3>
      <div className="fx-list">
        {t.fx.length === 0 && <div className="muted small">No effects yet.</div>}
        {t.fx.map((f, i) => <FxCard key={f.id} s={s} t={t} f={f} first={i === 0} last={i === t.fx.length - 1} />)}
        <div className="fx-add">
          <button onClick={() => setAdding(!adding)} aria-expanded={adding}>＋ Add effect</button>
          {adding && (
            <div className="fx-menu">
              {[...cats].map(([cat, defs]) => (
                <div key={cat} className="fx-cat">
                  <span>{cat}</span>
                  {defs.map((d) => <button key={d.type} onClick={() => add(d.type)} title={d.description}>{d.name}</button>)}
                </div>
              ))}
              <div className="fx-cat">
                <span>External</span>
                <button onClick={() => setUrlKind('wam')}>WAM 2.0 plugin URL…</button>
                <button onClick={() => setUrlKind('ext')}>WeMake plugin URL…</button>
              </div>
            </div>
          )}
          {urlKind && (
            <UrlField
              placeholder={urlKind === 'wam' ? 'https://…/index.js (WAM 2.0 effect)' : 'https://…/my-plugin.js (exports a PluginDef, see PLUGINS.md)'}
              onCancel={() => setUrlKind(null)} onSubmit={(url) => addUrl(urlKind, url)} />
          )}
        </div>
      </div>
    </section>
  );
}

function UrlField({ placeholder, onSubmit, onCancel }: { placeholder: string; onSubmit: (url: string) => void; onCancel: () => void }) {
  const [v, setV] = useState('');
  return (
    <form className="url-field" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()); }}>
      <input autoFocus type="url" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <button type="submit">Load</button>
      <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function FxCard({ s, t, f, first, last }: { s: Studio; t: Track; f: FxSlot; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(true);
  const def = getDef(f.type);
  const inst = s.engine.pluginInstance(t.id, f.id);
  const err = s.engine.pluginError(t.id, f.id);
  const params = inst?.params ?? def?.params ?? [];
  const values = def ? resolveParams(def, f.params, params) : f.params;
  return (
    <div className={`fx-card ${f.bypass ? 'bypassed' : ''}`}>
      <div className="fx-head">
        <button className={`power ${f.bypass ? '' : 'on'}`} onClick={() => s.edit((d) => M.setFx(d, t.id, f.id, { bypass: !f.bypass }))} title={f.bypass ? 'Enable' : 'Bypass'} aria-label="Toggle effect">⏻</button>
        <button className="fx-name" onClick={() => setOpen(!open)}>{def?.name ?? (isExternal(f.type) ? new URL(externalUrl(f.type)).pathname.split('/').filter(Boolean).slice(-2).join('/') : f.type)}</button>
        <span className="spacer" />
        <button disabled={first} onClick={() => s.edit((d) => M.moveFx(d, t.id, f.id, -1))} aria-label="Move up">↑</button>
        <button disabled={last} onClick={() => s.edit((d) => M.moveFx(d, t.id, f.id, 1))} aria-label="Move down">↓</button>
        <button onClick={() => s.edit((d) => M.removeFx(d, t.id, f.id))} aria-label="Remove effect">×</button>
      </div>
      {!isTrusted(f.type) && <TrustBanner type={f.type} />}
      {err && err !== 'untrusted' && <div className="error">⚠ {err}</div>}
      {open && (
        <div className="params">
          {params.map((p) => (
            <ParamControl key={p.id} p={p} value={values[p.id] ?? p.default} color={t.color}
              onChange={(v) => s.edit((d) => M.setFx(d, t.id, f.id, { param: [p.id, v] }))} />
          ))}
          {inst?.createGui && <PluginGuiButton create={() => inst.createGui!()} />}
        </div>
      )}
    </div>
  );
}
