// Draggable pane dividers. Sizes are per browser (localStorage), never shared with others.
import { useEffect, useRef, useState } from 'react';

export type SidePos = 'left' | 'right' | 'hidden';
export type EditorPos = 'bottom' | 'left' | 'right';
export type KeyboardPos = 'bottom' | 'hidden';
export type Pane = 'side' | 'editor' | 'keyboard';
export interface Layout {
  bottomH: number; sideW: number; kbH: number; editorW: number;
  side: SidePos; editor: EditorPos; keyboard: KeyboardPos;
  collapsed: Record<Pane, boolean>;
  template: string | null;
}

const KEY = 'wemake.layout';
export const LIMITS = { bottom: 120, timeline: 120, sideMin: 200, sideMax: 480, kbMin: 60, kbMax: 260, editorMin: 300, editorMax: 900 };
const defaults = (): Layout => ({
  bottomH: Math.round(0.38 * (window.innerHeight - 60)), sideW: 280, kbH: 60, editorW: 460,
  side: 'right', editor: 'bottom', keyboard: 'bottom',
  collapsed: { side: false, editor: false, keyboard: false },
  template: 'classic',
});

/** Starting points in the layout editor. */
export const TEMPLATES: { id: string; name: string; hint: string; layout: Partial<Layout> }[] = [
  { id: 'classic', name: 'Classic', hint: 'Timeline on top, editor below, people on the right', layout: { side: 'right', editor: 'bottom', keyboard: 'bottom', collapsed: { side: false, editor: false, keyboard: false } } },
  { id: 'jam', name: 'Jam', hint: 'People and chat up front on the left', layout: { side: 'left', editor: 'bottom', keyboard: 'bottom', sideW: 320, collapsed: { side: false, editor: false, keyboard: false } } },
  { id: 'producer', name: 'Producer', hint: 'Editor beside a full-height timeline', layout: { side: 'right', editor: 'right', keyboard: 'bottom', editorW: 520, collapsed: { side: true, editor: false, keyboard: false } } },
  { id: 'side-by-side', name: 'Side by side', hint: 'Editor on the left, timeline in the middle', layout: { side: 'right', editor: 'left', keyboard: 'bottom', editorW: 460, collapsed: { side: false, editor: false, keyboard: false } } },
  { id: 'performer', name: 'Performer', hint: 'Big keyboard for playing live', layout: { side: 'right', editor: 'bottom', keyboard: 'bottom', kbH: 170, collapsed: { side: false, editor: true, keyboard: false } } },
  { id: 'focus', name: 'Focus', hint: 'Just the timeline; open panes when you need them', layout: { side: 'right', editor: 'bottom', keyboard: 'hidden', collapsed: { side: true, editor: true, keyboard: false } } },
];

const one = <T extends string>(v: unknown, opts: readonly T[], f: T): T => (opts.includes(v as T) ? (v as T) : f);

function load(): Layout {
  const d = defaults();
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const num = (x: unknown, f: number) => (typeof x === 'number' && Number.isFinite(x) ? x : f);
    const c = v.collapsed && typeof v.collapsed === 'object' ? v.collapsed : {};
    return {
      bottomH: num(v.bottomH, d.bottomH), sideW: num(v.sideW, d.sideW), kbH: num(v.kbH, d.kbH), editorW: num(v.editorW, d.editorW),
      side: one(v.side, ['left', 'right', 'hidden'] as const, d.side),
      editor: one(v.editor, ['bottom', 'left', 'right'] as const, d.editor),
      keyboard: one(v.keyboard, ['bottom', 'hidden'] as const, d.keyboard),
      collapsed: { side: c.side === true, editor: c.editor === true, keyboard: c.keyboard === true },
      template: typeof v.template === 'string' ? v.template : null,
    };
  } catch {
    return d;
  }
}

let current: Layout | null = null;
const listeners = new Set<(l: Layout) => void>();
const SIZES = ['bottomH', 'sideW', 'kbH', 'editorW'] as const;

/** [layout, patch, reset(key?)]. Arrangement edits clear the template badge; size edits keep it. */
export function useLayout(): [Layout, (p: Partial<Layout>) => void, (k?: keyof Layout) => void] {
  if (!current) current = load();
  const [l, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    return () => { listeners.delete(set); };
  }, []);
  const update = (next: Layout) => {
    current = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    listeners.forEach((f) => f(next));
  };
  return [
    l,
    (p) => {
      const arranging = ['side', 'editor', 'keyboard'].some((k) => k in p);
      update({ ...current!, ...p, template: 'template' in p ? p.template! : arranging ? null : current!.template });
    },
    (k) => update(k ? { ...current!, [k]: defaults()[k] } : defaults()),
  ];
}

export function applyTemplate(id: string, patch: (p: Partial<Layout>) => void) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  const d = defaults();
  // a template sets the arrangement; sizes it doesn't mention go back to default
  patch({ ...Object.fromEntries(SIZES.map((k) => [k, d[k]])), ...t.layout, template: id });
}

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(Math.max(lo, hi), v)));

// Every mounted divider, so one can find a perpendicular neighbour it touches: grabbing the point where
// two meet resizes both panes at once (width and height).
interface Entry { el: HTMLDivElement; dir: 'row' | 'col'; props: () => SplitterProps }
const registry = new Set<Entry>();
const NEAR = 7; // px around a line that still counts as "on" it

/** The perpendicular divider whose line passes within reach of (x, y) and meets this one there. */
function partnerAt(self: Entry, x: number, y: number): Entry | null {
  const r = self.el.getBoundingClientRect();
  const onSelf = self.dir === 'row'
    ? Math.abs(y - r.top) <= NEAR && x >= r.left - NEAR && x <= r.right + NEAR
    : Math.abs(x - r.left) <= NEAR && y >= r.top - NEAR && y <= r.bottom + NEAR;
  if (!onSelf) return null;
  for (const o of registry) {
    if (o === self || o.dir === self.dir || !o.el.isConnected) continue;
    const q = o.el.getBoundingClientRect();
    const hit = o.dir === 'row'
      ? Math.abs(y - q.top) <= NEAR && x >= q.left - NEAR && x <= q.right + NEAR
      : Math.abs(x - q.left) <= NEAR && y >= q.top - NEAR && y <= q.bottom + NEAR;
    if (hit) return o;
  }
  return null;
}

interface SplitterProps {
  dir: 'row' | 'col'; value: number; min: number; max: number; onChange: (v: number) => void; onReset: () => void;
  label: string; invert?: boolean; className?: string;
}

/**
 * A divider you can drag, arrow-key or double-click (reset).
 * dir="row": horizontal bar that resizes a height. dir="col": vertical bar that resizes a width.
 * invert: the pane grows when dragging up/left (it sits below/right of the bar).
 * Where it meets a perpendicular divider the cursor becomes a four-way move and dragging resizes both.
 */
export function Splitter(props: SplitterProps) {
  const { dir, value, min, max, onReset, label, invert = true, className = '' } = props;
  const latest = useRef(props);
  latest.current = props;
  const el = useRef<HTMLDivElement>(null);
  const entry = useRef<Entry | null>(null);
  useEffect(() => {
    const e: Entry = { el: el.current!, dir, props: () => latest.current };
    entry.current = e;
    registry.add(e);
    return () => { registry.delete(e); };
  }, [dir]);
  type Grip = { e: Entry; start: number; value: number };
  const drag = useRef<Grip[] | null>(null);
  const [active, setActive] = useState(false);
  const [corner, setCorner] = useState(false);
  const axis = (d: 'row' | 'col', ev: { clientX: number; clientY: number }) => (d === 'row' ? ev.clientY : ev.clientX);
  const grip = (e: Entry, ev: React.PointerEvent): Grip => ({ e, start: axis(e.dir, ev), value: e.props().value });
  const end = () => {
    drag.current?.forEach((g) => g.e.el.classList.remove('active'));
    drag.current = null; setActive(false);
  };
  return (
    <div
      ref={el}
      className={`splitter ${dir} ${active ? 'active' : ''} ${corner ? 'corner' : ''} ${className}`}
      role="separator"
      aria-orientation={dir === 'row' ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label}: drag to resize (drag where dividers meet to resize both), double-click to reset`}
      onPointerDown={(ev) => {
        if (ev.button !== 0 || !entry.current) return;
        ev.preventDefault();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        const other = partnerAt(entry.current, ev.clientX, ev.clientY);
        drag.current = [grip(entry.current, ev), ...(other ? [grip(other, ev)] : [])];
        drag.current.forEach((g) => g.e.el.classList.add('active'));
        setActive(true);
      }}
      onPointerMove={(ev) => {
        if (!drag.current) {
          if (entry.current) setCorner(!!partnerAt(entry.current, ev.clientX, ev.clientY));
          return;
        }
        for (const g of drag.current) {
          const p = g.e.props();
          const d = axis(g.e.dir, ev) - g.start;
          p.onChange(clamp(g.value + ((p.invert ?? true) ? -d : d), p.min, p.max));
        }
      }}
      onPointerLeave={() => { if (!drag.current) setCorner(false); }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const grow = dir === 'row' ? (invert ? 'ArrowUp' : 'ArrowDown') : (invert ? 'ArrowLeft' : 'ArrowRight');
        const shrink = dir === 'row' ? (invert ? 'ArrowDown' : 'ArrowUp') : (invert ? 'ArrowRight' : 'ArrowLeft');
        if (e.key === grow) { e.preventDefault(); props.onChange(clamp(value + 16, min, max)); }
        else if (e.key === shrink) { e.preventDefault(); props.onChange(clamp(value - 16, min, max)); }
        else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); onReset(); }
      }}
    />
  );
}

export { clamp };
