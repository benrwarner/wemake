// "Customize layout": pick a template or place each pane yourself. Changes
// apply live and stay in this browser (your friends keep their own layout).
import { useEffect, useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { TEMPLATES, applyTemplate, useLayout, type Layout, type Pane } from './Splitter';

type Opt<T> = [T, string, IconName];
const SIDE: Opt<Layout['side']>[] = [['left', 'Left', 'panelLeft'], ['right', 'Right', 'panel'], ['hidden', 'Hidden', 'panelOff']];
const EDITOR: Opt<Layout['editor']>[] = [['left', 'Left', 'panelLeft'], ['bottom', 'Bottom', 'panelBottom'], ['right', 'Right', 'panel']];
const KEYS: Opt<Layout['keyboard']>[] = [['bottom', 'Bottom', 'panelBottom'], ['hidden', 'Hidden', 'panelOff']];

export function LayoutEditor({ onClose }: { onClose: () => void }) {
  const [layout, setLayout, resetLayout] = useLayout();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const collapse = (p: Pane, v: boolean) => setLayout({ collapsed: { ...layout.collapsed, [p]: v } });
  const narrow = window.innerWidth <= 820;

  return (
    <aside className="drawer layout-editor" role="dialog" aria-label="Customize layout" ref={panel} tabIndex={-1}>
      <header className="drawer-head">
        <div>
          <h2>Layout</h2>
          <p className="muted small">Arrange the studio your way. Saved in this browser.</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close layout"><Icon name="x" /></button>
      </header>
      <div className="drawer-body">
        <section className="ap-section">
          <Schematic l={layout} big />
          {narrow && <p className="note"><Icon name="info" />On a small screen the panes stack at the bottom. Your layout returns on a wider window.</p>}
        </section>

        <section className="ap-section">
          <h3>Templates</h3>
          <div className="template-grid">
            {TEMPLATES.map((t) => {
              const on = layout.template === t.id;
              return (
                <button key={t.id} className={`template ${on ? 'on' : ''}`} aria-pressed={on} title={t.hint} onClick={() => applyTemplate(t.id, setLayout)}>
                  <Schematic l={{ ...layout, ...t.layout } as Layout} />
                  <span className="template-name">{on && <Icon name="check" size={12} />}{t.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="ap-section">
          <h3>Panes</h3>
          <PaneRow label="People & chat" opts={SIDE} value={layout.side} onPick={(v) => setLayout({ side: v, collapsed: { ...layout.collapsed, side: false } })}
            collapsed={layout.collapsed.side} canCollapse={layout.side !== 'hidden'} onCollapse={(v) => collapse('side', v)} />
          <PaneRow label="Editor panel" hint="Instrument & FX, piano roll, mixer" opts={EDITOR} value={layout.editor} onPick={(v) => setLayout({ editor: v })}
            collapsed={layout.collapsed.editor} canCollapse onCollapse={(v) => collapse('editor', v)} />
          <PaneRow label="Keyboard" opts={KEYS} value={layout.keyboard} onPick={(v) => setLayout({ keyboard: v, collapsed: { ...layout.collapsed, keyboard: false } })}
            collapsed={layout.collapsed.keyboard} canCollapse={layout.keyboard !== 'hidden'} onCollapse={(v) => collapse('keyboard', v)} />
          <p className="muted small">Every pane also has its own collapse button, so you can tuck it away in one click while you work. Drag the edges between panes to resize them.</p>
        </section>

        <section className="ap-section">
          <div className="btn-row">
            <button onClick={() => setLayout({ collapsed: { side: false, editor: false, keyboard: false } })}><Icon name="panel" />Expand all panes</button>
            <button className="ghost" onClick={() => resetLayout()}><Icon name="refresh" />Reset layout and sizes</button>
          </div>
        </section>
      </div>
    </aside>
  );
}

function PaneRow<T extends string>({ label, hint, opts, value, onPick, collapsed, canCollapse, onCollapse }: {
  label: string; hint?: string; opts: Opt<T>[]; value: T; onPick: (v: T) => void;
  collapsed: boolean; canCollapse: boolean; onCollapse: (v: boolean) => void;
}) {
  return (
    <div className="pane-row">
      <div className="pane-row-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <div className="pane-row-controls">
        <div className="segmented" role="radiogroup" aria-label={`${label} position`}>
          {opts.map(([v, name, icon]) => (
            <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onPick(v)} title={name}>
              <Icon name={icon} size={14} />{name}
            </button>
          ))}
        </div>
        <label className="check small" title="Start this pane collapsed">
          <input type="checkbox" checked={collapsed} disabled={!canCollapse} onChange={(e) => onCollapse(e.target.checked)} /> Collapsed
        </label>
      </div>
    </div>
  );
}

/** A miniature of the studio for the given layout. */
export function Schematic({ l, big = false }: { l: Layout; big?: boolean }) {
  const c = l.collapsed;
  const side = l.side !== 'hidden' && <div className={`sx sx-side ${c.side ? 'c' : ''}`}>{big && !c.side && 'People'}</div>;
  const ed = <div className={`sx sx-ed ${l.editor} ${c.editor ? 'c' : ''}`}>{big && !c.editor && 'Editor'}</div>;
  return (
    <div className={`schematic ${big ? 'big' : ''}`} aria-hidden>
      <div className="sx sx-top" />
      <div className="sx-work">
        {l.side === 'left' && side}
        <div className="sx-center">
          <div className="sx-row">
            {l.editor === 'left' && ed}
            <div className="sx sx-time">{big && 'Timeline'}</div>
            {l.editor === 'right' && ed}
          </div>
          {l.editor === 'bottom' && ed}
          {l.keyboard !== 'hidden' && <div className={`sx sx-kb ${c.keyboard ? 'c' : ''}`} style={!c.keyboard ? { flexBasis: `${Math.min(30, 8 + l.kbH / 10)}%` } : undefined}>{big && !c.keyboard && 'Keyboard'}</div>}
        </div>
        {l.side === 'right' && side}
      </div>
    </div>
  );
}
