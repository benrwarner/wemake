import { useEffect, useState } from 'react';
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

export function StudioView() {
  const s = useStudio();
  const [settings, setSettings] = useState(false);
  const [side, setSide] = useState(true);
  useComputerKeyboard();

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
    <div className={`studio ${side ? '' : 'no-side'}`}>
      <TopBar onSettings={() => setSettings(true)} onToggleSide={() => setSide(!side)} />
      <main className="center">
        <Arrange />
        <section className="bottom">
          <nav className="tabs" role="tablist">
            {(['track', 'editor', 'mixer'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={s.bottom === t} className={s.bottom === t ? 'on' : ''} onClick={() => s.setBottom(t)}>
                {t === 'track' ? 'Instrument & FX' : t === 'editor' ? 'Piano Roll' : 'Mixer'}
              </button>
            ))}
          </nav>
          <div className="bottom-body">
            {s.bottom === 'track' && <Inspector />}
            {s.bottom === 'editor' && <PianoRoll />}
            {s.bottom === 'mixer' && <Mixer />}
          </div>
        </section>
        <Keyboard />
      </main>
      {side && <People />}
      {settings && <Settings onClose={() => setSettings(false)} />}
      <div className="toasts" aria-live="polite">
        {s.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
        {[...s.uploads.values()].map((u) => <div key={u} className="toast">Saving {u}…</div>)}
      </div>
    </div>
  );
}
