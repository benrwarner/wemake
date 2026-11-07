// The Appearance drawer: presets, your own colours, a background image and
// shape. Changes apply live to the whole app and stay in this browser.
import { useEffect, useRef, useState } from 'react';
import {
  PRESETS, SURFACES, applyPreset, clearImage, contrast, getTheme, readability, resetTheme, sanitize, setImage, setTheme,
  themeFromImage, useTheme, type Preset, type Theme,
} from '../theme/theme';
import { isHex } from '../theme/color';
import { Icon } from './Icon';

export function Appearance({ onClose }: { onClose: () => void }) {
  const { theme, imageUrl } = useTheme();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const importIn = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const addImage = async (f: File | undefined, match: boolean) => {
    if (!f) return;
    setError(''); setBusy('Adding image…');
    try {
      const blob = await setImage(f);
      if (match) setTheme(await themeFromImage(blob));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  };
  const match = async () => {
    setError(''); setBusy('Reading colours…');
    try { setTheme(await themeFromImage()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  };
  const exportTheme = () => {
    const { image: _i, ...rest } = getTheme();
    const blob = new Blob([JSON.stringify({ wemakeTheme: 1, ...rest }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'wemake-theme.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importTheme = async (f: File | undefined) => {
    if (!f) return;
    setError('');
    try {
      const v = JSON.parse(await f.text());
      if (!v || typeof v !== 'object' || !isHex(v.bg)) throw new Error();
      const { image: _i, ...t } = sanitize(v);
      setTheme(t, true);
    } catch { setError(`${f.name} isn't a WeMake theme file.`); }
  };

  const r = readability(theme);
  return (
    <aside className="drawer appearance" role="dialog" aria-label="Appearance" ref={panel} tabIndex={-1}>
      <header className="drawer-head">
        <div>
          <h2>Appearance</h2>
          <p className="muted small">Only you see this. It's saved in this browser.</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close appearance"><Icon name="x" /></button>
      </header>

      <div className="drawer-body">
        <section className="ap-section">
          <h3>Themes</h3>
          <div className="preset-grid">
            {PRESETS.map((p) => <PresetTile key={p.id} p={p} on={theme.preset === p.id} onPick={() => applyPreset(p)} />)}
          </div>
        </section>

        <section className="ap-section">
          <h3>Picture</h3>
          <div
            className={`dropzone ${drag ? 'over' : ''} ${imageUrl ? 'has' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); void addImage(e.dataTransfer.files[0], true); }}
          >
            {imageUrl
              ? <img src={imageUrl} alt="Your background" />
              : (
                <div className="dropzone-empty">
                  <Icon name="image" size={22} />
                  <span>Drop a picture here</span>
                  <span className="muted small">The app's colours will be matched to it</span>
                </div>
              )}
          </div>
          <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => { void addImage(e.target.files?.[0], !imageUrl); e.target.value = ''; }} />
          <div className="btn-row">
            <button onClick={() => fileIn.current?.click()} disabled={!!busy}><Icon name="upload" />{imageUrl ? 'Replace image' : 'Choose image'}</button>
            {imageUrl && <button onClick={() => void match()} disabled={!!busy} title="Pick background, text and accent colours from the image"><Icon name="wand" />Match colours</button>}
            {imageUrl && <button className="ghost" onClick={() => void clearImage()} disabled={!!busy}><Icon name="trash" />Remove</button>}
          </div>
          {busy && <p className="muted small" role="status">{busy}</p>}
          {error && <p className="note error" role="alert"><Icon name="alert" />{error}</p>}
          {imageUrl && (
            <>
              <div className="ap-sub">
                <h4>Show the picture in</h4>
                <div className="surface-chips" role="group" aria-label="Where the picture shows">
                  <Toggle on={theme.bgPicture} onClick={() => setTheme({ bgPicture: !theme.bgPicture }, true)}>Page background</Toggle>
                  {SURFACES.map(([id, label]) => {
                    const on = theme.surfaces.includes(id);
                    return (
                      <Toggle key={id} on={on} onClick={() => setTheme({ surfaces: on ? theme.surfaces.filter((x) => x !== id) : [...theme.surfaces, id] }, true)}>{label}</Toggle>
                    );
                  })}
                </div>
                <div className="btn-row">
                  <button className="ghost small" onClick={() => setTheme({ surfaces: SURFACES.map(([id]) => id) }, true)}>All panes</button>
                  <button className="ghost small" onClick={() => setTheme({ surfaces: [] }, true)}>No panes</button>
                </div>
              </div>
              {theme.surfaces.length > 0 && (
                <div className="ap-sub">
                  <h4>Inside panes</h4>
                  <div className="ap-sliders">
                    <Slider label="Picture strength" value={1 - theme.paneTint} min={0.05} max={0.75} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setTheme({ paneTint: 1 - v }, true)} />
                    <Slider label="Blur" value={theme.paneBlur} min={0} max={40} step={1} fmt={(v) => `${v}px`} onChange={(v) => setTheme({ paneBlur: v }, true)} />
                  </div>
                </div>
              )}
              {theme.bgPicture && (
                <div className="ap-sub">
                  <h4>Page background</h4>
                  <div className="ap-sliders">
                    <Slider label={isLightHex(theme.bg) ? 'Fade' : 'Darken'} value={theme.dim} min={0} max={0.9} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setTheme({ dim: v }, true)} />
                    <Slider label="Blur" value={theme.blur} min={0} max={30} step={1} fmt={(v) => `${v}px`} onChange={(v) => setTheme({ blur: v }, true)} />
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <section className="ap-section">
          <h3>Colours</h3>
          <ColorRow label="Background" value={theme.bg} onChange={(v) => setTheme({ bg: v })} />
          <ColorRow label="Text" value={theme.text} onChange={(v) => setTheme({ text: v })} />
          <ColorRow label="Accent" hint="Play, selection, highlights" value={theme.accent} onChange={(v) => setTheme({ accent: v })} />
          <ColorRow label="Second accent" hint="Shared listening, online status" value={theme.accent2} onChange={(v) => setTheme({ accent2: v })} />
          {r.text < 4.5 && (
            <p className="note warn" role="status"><Icon name="alert" />
              Text contrast is {r.text.toFixed(1)}:1, so it's swapped for a readable colour. Pick a lighter or darker text colour to use your own.
            </p>
          )}
          {r.text >= 4.5 && r.accentOnPanel < 3 && (
            <p className="note warn" role="status"><Icon name="alert" />The accent is faint on panels ({r.accentOnPanel.toFixed(1)}:1). Labels use an adjusted shade so they stay readable.</p>
          )}
        </section>

        <section className="ap-section">
          <h3>Shape</h3>
          <Slider label="Corner roundness" value={theme.radius} min={2} max={18} step={1} fmt={(v) => `${v}px`} onChange={(v) => setTheme({ radius: v }, true)} />
        </section>

        <section className="ap-section">
          <h3>Share or reset</h3>
          <input ref={importIn} type="file" accept="application/json,.json" hidden onChange={(e) => { void importTheme(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="btn-row">
            <button onClick={exportTheme} title="Save your colours to a file you can send to friends"><Icon name="download" />Export theme</button>
            <button onClick={() => importIn.current?.click()}><Icon name="upload" />Import theme</button>
            <button className="ghost" onClick={() => resetTheme()}><Icon name="refresh" />Reset to default</button>
          </div>
        </section>
      </div>
    </aside>
  );
}

const isLightHex = (h: string) => contrast(h, '#000000') > contrast(h, '#ffffff');

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick}>{on && <Icon name="check" size={12} />}{children}</button>;
}

function PresetTile({ p, on, onPick }: { p: Preset; on: boolean; onPick: () => void }) {
  return (
    <button className={`preset ${on ? 'on' : ''}`} onClick={onPick} aria-pressed={on} title={`Use the ${p.name} theme`}>
      <span className="preset-swatch" style={{ background: p.bg, color: p.text, borderRadius: (p.radius ?? 9) * 0.7 }}>
        <span className="ps-bar" style={{ background: p.text }} />
        <span className="ps-bar short" style={{ background: p.text }} />
        <span className="ps-row">
          <span className="ps-dot" style={{ background: p.accent }} />
          <span className="ps-pill" style={{ background: p.accent2 }} />
        </span>
      </span>
      <span className="preset-name">{on && <Icon name="check" size={13} />}{p.name}</span>
    </button>
  );
}

function ColorRow({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = `c-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="color-row">
      <label className="color-swatch" style={{ background: value }} title={`Pick ${label.toLowerCase()} colour`}>
        <input type="color" value={value} aria-label={`${label} colour picker`} onChange={(e) => onChange(e.target.value)} />
      </label>
      <label htmlFor={id} className="color-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </label>
      <input
        id={id} className="color-hex mono" value={text} maxLength={7} spellCheck={false} aria-label={`${label} hex value`}
        onChange={(e) => {
          const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setText(v);
          if (isHex(v)) onChange(v.toLowerCase());
        }}
        onBlur={() => setText(value)}
      />
    </div>
  );
}

function Slider({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono small slider-val">{fmt(value)}</span>
    </label>
  );
}

export type { Theme };
