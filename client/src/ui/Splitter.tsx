// Draggable pane dividers. Sizes are per browser (localStorage), never shared with others.
import { useEffect, useRef, useState } from 'react';

export type Layout = { bottomH: number; sideW: number; kbH: number };

const KEY = 'wemake.layout';
export const LIMITS = { bottom: 120, timeline: 120, sideMin: 200, sideMax: 480, kbMin: 60, kbMax: 260 };
const defaults = (): Layout => ({ bottomH: Math.round(0.38 * (window.innerHeight - 60)), sideW: 280, kbH: 60 });

function load(): Layout {
  const d = defaults();
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const num = (x: unknown, f: number) => (typeof x === 'number' && Number.isFinite(x) ? x : f);
    return { bottomH: num(v.bottomH, d.bottomH), sideW: num(v.sideW, d.sideW), kbH: num(v.kbH, d.kbH) };
  } catch {
    return d;
  }
}

let current: Layout | null = null;
const listeners = new Set<(l: Layout) => void>();

/** [layout, patch, reset(key?)] */
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
    (p) => update({ ...current!, ...p }),
    (k) => update(k ? { ...current!, [k]: defaults()[k] } : defaults()),
  ];
}

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(Math.max(lo, hi), v)));

/**
 * A divider you can drag, arrow-key or double-click (reset).
 * dir="row": horizontal bar that resizes a height. dir="col": vertical bar that resizes a width.
 * invert: the pane grows when dragging up/left (it sits below/right of the bar).
 */
export function Splitter({ dir, value, min, max, onChange, onReset, label, invert = true, className = '' }: {
  dir: 'row' | 'col'; value: number; min: number; max: number; onChange: (v: number) => void; onReset: () => void;
  label: string; invert?: boolean; className?: string;
}) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const [active, setActive] = useState(false);
  const pos = (e: React.PointerEvent) => (dir === 'row' ? e.clientY : e.clientX);
  return (
    <div
      className={`splitter ${dir} ${active ? 'active' : ''} ${className}`}
      role="separator"
      aria-orientation={dir === 'row' ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label}: drag to resize, double-click to reset`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: pos(e), value };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const d = pos(e) - drag.current.start;
        onChange(clamp(drag.current.value + (invert ? -d : d), min, max));
      }}
      onPointerUp={() => { drag.current = null; setActive(false); }}
      onPointerCancel={() => { drag.current = null; setActive(false); }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const grow = dir === 'row' ? (invert ? 'ArrowUp' : 'ArrowDown') : (invert ? 'ArrowLeft' : 'ArrowRight');
        const shrink = dir === 'row' ? (invert ? 'ArrowDown' : 'ArrowUp') : (invert ? 'ArrowRight' : 'ArrowLeft');
        if (e.key === grow) { e.preventDefault(); onChange(clamp(value + 16, min, max)); }
        else if (e.key === shrink) { e.preventDefault(); onChange(clamp(value - 16, min, max)); }
        else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); onReset(); }
      }}
    />
  );
}

export { clamp };
