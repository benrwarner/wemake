import { useEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import type { FxSlot, Track } from '../../../shared/model';
import type { Studio } from '../state/studio';
import { builtinFx, builtinInstruments, externalUrl, getDef, isCatalogPlugin, safeHost, shortPluginName, isExternal, isTrusted, trustCatalog, trustPlugin, validatePluginUrl } from '../audio/plugins/registry';
import { BrowseSounds, SaveSound } from './BrowseSounds';
import { type ParamDef, resolveParams } from '../audio/plugins/types';
import { ParamControl } from './controls';
import { useStudio } from './hooks';
import { Icon } from './Icon';

export function Inspector() {
  const s = useStudio();
  const t = s.selectedTrack ? s.snap.tracks[s.selectedTrack] : undefined;
  const [browse, setBrowse] = useState<null | 'fx' | 'instrument'>(null);
  if (!t) return <EmptyState icon="sliders" title="No track selected">Click a track on the timeline to see its instrument and effects here.</EmptyState>;
  return (
    <div className="inspector">
      {t.kind === 'instrument' && <InstrumentPanel s={s} t={t} onBrowse={() => setBrowse('instrument')} />}
      {t.kind === 'audio' && <InputPanel s={s} t={t} />}
      <FxRack s={s} t={t} onBrowse={() => setBrowse('fx')} />
      {browse && <BrowseSounds s={s} t={t} initialKind={browse} onClose={() => setBrowse(null)} />}
    </div>
  );
}

function InputPanel({ s, t }: { s: Studio; t: Track }) {
  const e = s.engine;
  const armed = e.armedAudio === t.id;
  return (
    <section className="panel input-panel" style={{ ['--tc' as string]: t.color }}>
      <h3><Icon name="mic" />{t.name} <span className="muted small">Audio track</span></h3>
      <p className="muted small">Arm this track to play your mic or instrument through its effects live, so friends hear it in the jam, and record takes.</p>
      <button className={`arm-big ${armed ? 'on' : ''}`} onClick={() => s.arm(t.id)} aria-pressed={armed}><Icon name="record" size={12} />{armed ? 'Armed: your input is live here' : 'Arm track (R)'}</button>
      <label className="check"><input type="checkbox" checked={e.settings.monitor} onChange={(ev) => { e.setMonitor(ev.target.checked); s.saveSettings(); }} /> Monitor: hear yourself through the FX</label>
      <label className="check"><input type="checkbox" checked={e.live} onChange={(ev) => s.setLive(ev.target.checked)} /> Live to room: friends hear you</label>
      {e.hasInput ? <div className="row"><span className="muted small">Input</span><MeterInline s={s} /></div> : <p className="muted small">Your input opens when you arm the track. Choose a device in Settings.</p>}
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

function InstrumentPanel({ s, t, onBrowse }: { s: Studio; t: Track; onBrowse: () => void }) {
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
        <button className={`arm-small ${armed ? 'on' : ''}`} onClick={() => s.arm(t.id)} aria-pressed={armed} title="Your keyboard / MIDI controller plays this track"><Icon name={armed ? 'record' : 'keys'} size={armed ? 10 : 14} />{armed ? 'Playing' : 'Play this'}</button>
      </h3>
      <div className="row sound-actions">
        <button className="ghost small" onClick={onBrowse}><Icon name="search" />Browse sounds</button>
        <SaveSound kind="instrument" type={spec.type} defaultName={def?.name ?? 'My sound'}
          values={async () => ({ ...spec.params, ...values, ...((await inst?.getParamValues?.().catch(() => ({}))) ?? {}) })} />
      </div>
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
      {strip?.instrument?.error && strip.instrument.error !== 'untrusted' && <div className="note error"><Icon name="alert" />{strip.instrument.error}</div>}
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
      <p><Icon name="plug" />This session uses an external plugin from <b>{safeHost(type)}</b>. It runs code in your browser.</p>
      <code>{url}</code>
      <div className="row">
        <button onClick={() => trustPlugin(type)}>Trust &amp; load</button>
        {isCatalogPlugin(type) && <button className="ghost" onClick={() => trustCatalog()}>Trust all community plugins</button>}
      </div>
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
      <button className="small" onClick={() => setOpen(!open)}><Icon name="panel" />{open ? 'Close plugin window' : 'Open plugin window'}</button>
      {open && <div className="plugin-window" role="dialog" aria-label="Plugin window"><div className="plugin-window-bar"><span>Plugin</span><button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close plugin window"><Icon name="x" /></button></div><div ref={host} /></div>}
    </>
  );
}

function FxRack({ s, t, onBrowse }: { s: Studio; t: Track; onBrowse: () => void }) {
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
      <h3>Effects <span className="muted small">Processed in order, shared with everyone</span></h3>
      <div className="fx-list">
        {t.fx.length === 0 && <div className="fx-empty muted small">No effects yet. Add reverb, delay, EQ and more.</div>}
        {t.fx.map((f, i) => <FxCard key={f.id} s={s} t={t} f={f} first={i === 0} last={i === t.fx.length - 1} />)}
        <div className="fx-add">
          <div className="row">
            <button className="primary-soft" onClick={() => setAdding(!adding)} aria-expanded={adding}><Icon name="plus" />Add effect</button>
            <button className="ghost" onClick={onBrowse}><Icon name="search" />Browse sounds</button>
          </div>
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
        <button className={`icon-btn power ${f.bypass ? '' : 'on'}`} onClick={() => s.edit((d) => M.setFx(d, t.id, f.id, { bypass: !f.bypass }))} title={f.bypass ? 'Turn on' : 'Bypass'} aria-label="Toggle effect" aria-pressed={!f.bypass}><Icon name="power" size={14} /></button>
        <button className="fx-name" onClick={() => setOpen(!open)} aria-expanded={open}>{def?.name ?? (isExternal(f.type) ? shortPluginName(f.type) : f.type)}<Icon name="chevron" size={12} className={`chev ${open ? '' : 'closed'}`} /></button>
        <span className="spacer" />
        <button className="icon-btn subtle" disabled={first} onClick={() => s.edit((d) => M.moveFx(d, t.id, f.id, -1))} aria-label="Move up" title="Move earlier in the chain"><Icon name="up" size={14} /></button>
        <button className="icon-btn subtle" disabled={last} onClick={() => s.edit((d) => M.moveFx(d, t.id, f.id, 1))} aria-label="Move down" title="Move later in the chain"><Icon name="down" size={14} /></button>
        <button className="icon-btn subtle" onClick={() => s.edit((d) => M.removeFx(d, t.id, f.id))} aria-label="Remove effect" title="Remove effect"><Icon name="x" size={14} /></button>
      </div>
      {!isTrusted(f.type) && <TrustBanner type={f.type} />}
      {err && err !== 'untrusted' && <div className="note error"><Icon name="alert" />{err}</div>}
      {open && (
        <div className="params">
          {params.map((p) => (
            <ParamControl key={p.id} p={p} value={values[p.id] ?? p.default} color={t.color}
              onChange={(v) => s.edit((d) => M.setFx(d, t.id, f.id, { param: [p.id, v] }))} />
          ))}
          {inst?.createGui && <PluginGuiButton create={() => inst.createGui!()} />}
          <SaveSound kind="fx" type={f.type} defaultName={def?.name ?? 'My effect'}
            values={async () => ({ ...f.params, ...values, ...((await inst?.getParamValues?.().catch(() => ({}))) ?? {}) })} />
        </div>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <span className="es-icon"><Icon name={icon} size={20} /></span>
      <b>{title}</b>
      <p>{children}</p>
    </div>
  );
}
