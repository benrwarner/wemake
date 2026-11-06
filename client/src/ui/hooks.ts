import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Studio } from '../state/studio';

export const StudioContext = createContext<Studio | null>(null);

/** Access the studio and re-render whenever it changes. */
export function useStudio() {
  const s = useContext(StudioContext)!;
  useSyncExternalStore(s.subscribe, s.getVersion);
  return s;
}

/** Run a callback every animation frame (for meters/playheads; bypasses React). */
export function useFrame(fn: (t: number) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = (t: number) => { ref.current(t); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

/** Pointer drag helper with capture. */
export function startDrag(e: React.PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, up?: (ev: PointerEvent, moved: boolean) => void) {
  const x0 = e.clientX, y0 = e.clientY;
  const target = e.currentTarget as Element;
  target.setPointerCapture?.(e.pointerId);
  let moved = false;
  const onMove = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 2) moved = true;
    move(ev.clientX - x0, ev.clientY - y0, ev);
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    up?.(ev, moved);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

export const fmtDb = (db: number) => (db <= -60 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
export function fmtPos(beat: number, sig: number) {
  const b = Math.max(0, beat);
  const bar = Math.floor(b / sig) + 1;
  const bt = Math.floor(b % sig) + 1;
  const tick = Math.floor((b % 1) * 4) + 1;
  return `${bar}.${bt}.${tick}`;
}
