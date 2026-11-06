import { useRef } from 'react';
import type { ParamDef } from '../audio/plugins/types';
import { startDrag, useFrame } from './hooks';

const toNorm = (p: ParamDef, v: number) => {
  if (p.scale === 'log' && p.min > 0) return Math.log(v / p.min) / Math.log(p.max / p.min);
  return (v - p.min) / (p.max - p.min);
};
const fromNorm = (p: ParamDef, n: number) => {
  n = Math.max(0, Math.min(1, n));
  let v = p.scale === 'log' && p.min > 0 ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
  if (p.step) v = Math.round(v / p.step) * p.step;
  return v;
};

export function fmtParam(p: ParamDef, v: number) {
  if (p.options) return p.options[Math.round(v)] ?? String(v);
  const abs = Math.abs(v);
  const s = abs >= 1000 ? `${(v / 1000).toFixed(abs >= 10000 ? 1 : 2)}k` : abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${s}${p.unit ? ` ${p.unit}` : ''}`;
}

export function Knob({ p, value, onChange, color = 'var(--accent)', size = 44 }: { p: ParamDef; value: number; onChange: (v: number) => void; color?: string; size?: number }) {
  const n = Math.max(0, Math.min(1, toNorm(p, value)));
  const a0 = -135, a = a0 + n * 270;
  const r = size / 2 - 4, c = size / 2;
  const pt = (deg: number) => [c + r * Math.sin((deg * Math.PI) / 180), c - r * Math.cos((deg * Math.PI) / 180)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a);
  const arc = `M ${x0} ${y0} A ${r} ${r} 0 ${a - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  const [bx, by] = pt(135);
  return (
    <div className="knob" title={`${p.name}: ${fmtParam(p, value)} (double-click to reset)`}>
      <svg
        width={size} height={size} role="slider" aria-label={p.name} aria-valuenow={value} aria-valuemin={p.min} aria-valuemax={p.max} tabIndex={0}
        onPointerDown={(e) => {
          const start = n;
          startDrag(e, (_dx, dy, ev) => onChange(fromNorm(p, start - dy / (ev.shiftKey ? 600 : 150))));
        }}
        onDoubleClick={() => onChange(p.default)}
        onWheel={(e) => onChange(fromNorm(p, n - Math.sign(e.deltaY) * 0.02))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onChange(fromNorm(p, n + 0.02)); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onChange(fromNorm(p, n - 0.02)); }
        }}
      >
        <path d={`M ${x0} ${y0} A ${r} ${r} 0 1 1 ${bx} ${by}`} className="knob-track" />
        {n > 0.001 && <path d={arc} stroke={color} className="knob-val" />}
        <circle cx={c} cy={c} r={r - 6} className="knob-cap" />
        <line x1={c} y1={c} x2={c + (r - 8) * Math.sin((a * Math.PI) / 180)} y2={c - (r - 8) * Math.cos((a * Math.PI) / 180)} className="knob-ptr" />
      </svg>
      <span className="knob-label">{p.name}</span>
      <span className="knob-value">{fmtParam(p, value)}</span>
    </div>
  );
}

export function ParamControl({ p, value, onChange, color }: { p: ParamDef; value: number; onChange: (v: number) => void; color?: string }) {
  if (p.options) {
    return (
      <label className="param-select">
        <span>{p.name}</span>
        <select value={Math.round(value)} onChange={(e) => onChange(Number(e.target.value))}>
          {p.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
        </select>
      </label>
    );
  }
  return <Knob p={p} value={value} onChange={onChange} color={color} />;
}

/** Peak meter driven by requestAnimationFrame with peak-hold decay. */
export function Meter({ read, vertical = false }: { read: () => number | undefined; vertical?: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  const level = useRef(0);
  useFrame(() => {
    const v = read() ?? 0;
    level.current = Math.max(v, level.current * 0.9);
    const db = 20 * Math.log10(level.current || 1e-6);
    const n = Math.max(0, Math.min(1, (db + 60) / 63));
    if (bar.current) {
      bar.current.style[vertical ? 'height' : 'width'] = `${n * 100}%`;
      bar.current.dataset.clip = db > -0.5 ? '1' : '';
    }
  });
  return <div className={`meter ${vertical ? 'v' : 'h'}`}><div ref={bar} className="meter-fill" /></div>;
}
