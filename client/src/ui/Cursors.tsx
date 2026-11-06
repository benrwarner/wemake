// Friends' live pointers, drawn every frame straight into the DOM (no React
// re-render per mouse move). Positions are musical (beat/track/pitch), so a
// cursor points at the same note or bar for everyone regardless of zoom.
import { useRef } from 'react';
import type { CursorPos } from '../net/Session';
import type { Studio } from '../state/studio';
import { useFrame } from './hooks';

const STALE_MS = 8000;

export function RemoteCursors({ s, place }: { s: Studio; place: (c: CursorPos) => { x: number; y: number } | null }) {
  const layer = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  useFrame(() => {
    const root = layer.current;
    if (!root) return;
    const now = performance.now();
    const seen = new Set<string>();
    for (const [id, { c, at }] of s.session.cursors) {
      const peer = s.session.peers.get(id);
      const pos = c && peer && now - at < STALE_MS ? place(c) : null;
      if (!pos || !peer) continue;
      seen.add(id);
      let el = nodes.current.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rcursor';
        el.innerHTML = '<svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l12 9-5.5 1L5 17z"/></svg><span></span>';
        root.appendChild(el);
        nodes.current.set(id, el);
      }
      el.style.setProperty('--pc', peer.color);
      el.querySelector('span')!.textContent = peer.name;
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      el.style.opacity = now - at > STALE_MS - 2000 ? '0.35' : '1';
    }
    for (const [id, el] of nodes.current) if (!seen.has(id)) { el.remove(); nodes.current.delete(id); }
  });
  return <div ref={layer} className="rcursor-layer" aria-hidden />;
}
