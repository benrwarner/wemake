import { useEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import { useStudio } from './hooks';
import { TopBar } from './TopBar';
import { Arrange } from './Arrange';
import { PianoRoll } from './PianoRoll';
import { Inspector } from './Inspector';
import { Mixer } from './Mixer';
import { People } from './People';
import { Keyboard, useComputerKeyboard } from './Keyboard';
import { Settings } from './Settings';
import { ErrorBoundary } from './ErrorBoundary';
import { LIMITS, Splitter, clamp, useLayout } from './Splitter';

export function StudioView() {
  const s = useStudio();
  const [settings, setSettings] = useState(false);
  const [side, setSide] = useState(true);
  const [layout, setLayout, resetLayout] = useLayout();
  const center = useRef<HTMLElement>(null);
  const [centerH, setCenterH] = useState(0);
  useEffect(() => {
    const el = center.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCenterH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useComputerKeyboard();
  // Keep the timeline at least LIMITS.timeline tall whatever the window size.
  const kbH = clamp(layout.kbH, LIMITS.kbMin, LIMITS.kbMax);
  const maxBottom = centerH ? centerH - LIMITS.timeline - kbH - 30 : 2000;
  const bottomH = clamp(layout.bottomH, LIMITS.bottom, maxBottom);
  const maxKb = centerH ? Math.min(LIMITS.kbMax, centerH - LIMITS.timeline - LIMITS.bottom - 30) : LIMITS.kbMax;
  const sideW = clamp(layout.sideW, LIMITS.sideMin, Math.min(LIMITS.sideMax, window.innerWidth - 400));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') { e.preventDefault(); s.play(); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) s.session.undo.redo(); else s.session.undo.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.session.undo.redo(); }
      else if (mod && e.key.toLowerCase() === 'd' && s.selectedClip) {
        e.preventDefault();
        const c = s.snap.clips[s.selectedClip];
        if (c) { let id = ''; s.edit((d) => { id = M.addClip(d, { ...c, id: undefined, start: c.start + c.length }); }); s.selectClip(id); }
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedClip && s.bottom !== 'editor') {
        e.preventDefault();
        const id = s.selectedClip;
        s.edit((d) => M.deleteClip(d, id));
        s.selectClip(null);
      }
      else if (e.key === 'r' && !mod && e.shiftKey) { e.preventDefault(); s.record(); }
      else if (e.key === 'Enter' && !mod) { e.preventDefault(); s.stop(); }
      else if (e.key === 'Escape') s.panic();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s]);

  return (
    <div className={`studio ${side ? '' : 'no-side'}`}
      style={{ ['--side-w' as string]: `${sideW}px`, ['--bottom-h' as string]: `${bottomH}px`, ['--kb-h' as string]: `${kbH}px` }}>
      <TopBar onSettings={() => setSettings(true)} onToggleSide={() => setSide(!side)} />
      <main className="center" ref={center}>
        <ErrorBoundary label="the arrangement"><Arrange /></ErrorBoundary>
        <Splitter dir="row" label="Resize timeline and bottom panel" value={bottomH} min={LIMITS.bottom} max={maxBottom}
          onChange={(v) => setLayout({ bottomH: v })} onReset={() => resetLayout('bottomH')} />
        <section className="bottom">
          <nav className="tabs" role="tablist">
            {(['track', 'editor', 'mixer'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={s.bottom === t} className={s.bottom === t ? 'on' : ''} onClick={() => s.setBottom(t)}>
                {t === 'track' ? 'Instrument & FX' : t === 'editor' ? 'Piano Roll' : 'Mixer'}
              </button>
            ))}
          </nav>
          <div className="bottom-body">
            <ErrorBoundary key={`${s.bottom}:${s.selectedTrack}`} label="this panel">
              {s.bottom === 'track' && <Inspector />}
              {s.bottom === 'editor' && <PianoRoll />}
              {s.bottom === 'mixer' && <Mixer />}
            </ErrorBoundary>
          </div>
        </section>
        <Splitter dir="row" label="Resize keyboard" value={kbH} min={LIMITS.kbMin} max={maxKb}
          onChange={(v) => setLayout({ kbH: v })} onReset={() => resetLayout('kbH')} />
        <Keyboard />
      </main>
      {side && (
        <Splitter dir="col" className="side-splitter" label="Resize people panel" value={sideW} min={LIMITS.sideMin} max={Math.min(LIMITS.sideMax, window.innerWidth - 400)}
          onChange={(v) => setLayout({ sideW: v })} onReset={() => resetLayout('sideW')} />
      )}
      {side && <ErrorBoundary label="the people panel"><People /></ErrorBoundary>}
      {settings && <Settings onClose={() => setSettings(false)} />}
      <div className="toasts" aria-live="polite">
        {s.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
        {[...s.uploads.values()].map((u) => <div key={u} className="toast">Saving {u}…</div>)}
      </div>
    </div>
  );
}
