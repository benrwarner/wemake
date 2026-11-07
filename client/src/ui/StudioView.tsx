import { useEffect, useRef, useState } from 'react';
import * as M from '../../../shared/model';
import type { BottomTab } from '../state/studio';
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
import { LIMITS, Splitter, clamp, useLayout, type EditorPos, type Pane } from './Splitter';
import { Appearance } from './Appearance';
import { LayoutEditor } from './LayoutEditor';
import { Icon, type IconName } from './Icon';
import { Shortcuts } from './Shortcuts';
import { CollapseButton } from './Collapse';

/** True while the window is at most `px` wide. */
function useNarrow(px: number) {
  const q = `(max-width: ${px}px)`;
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

export function StudioView() {
  const s = useStudio();
  const [settings, setSettings] = useState(false);
  const [drawer, setDrawer] = useState<null | 'appearance' | 'layout'>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [layout, setLayout, resetLayout] = useLayout();
  const narrow = useNarrow(820);
  const center = useRef<HTMLElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = center.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useComputerKeyboard();

  // small screens stack everything at the bottom; your layout comes back when there's room
  const sidePos = narrow ? 'hidden' : layout.side;
  const edPos: EditorPos = narrow ? 'bottom' : layout.editor;
  const kbOn = layout.keyboard !== 'hidden';
  const col = layout.collapsed;
  const setCollapsed = (p: Pane, v: boolean) => setLayout({ collapsed: { ...layout.collapsed, [p]: v } });

  // Keep the timeline at least LIMITS.timeline tall/wide whatever the window size.
  const kbH = clamp(layout.kbH, LIMITS.kbMin, LIMITS.kbMax);
  const kbSpace = !kbOn ? 0 : col.keyboard ? 34 : kbH;
  const edBottomOpen = edPos === 'bottom' && !col.editor;
  const maxBottom = box.h ? box.h - LIMITS.timeline - kbSpace - 30 : 2000;
  const bottomH = clamp(layout.bottomH, LIMITS.bottom, maxBottom);
  const maxKb = box.h ? Math.min(LIMITS.kbMax, box.h - LIMITS.timeline - (edBottomOpen ? LIMITS.bottom : 40) - 30) : LIMITS.kbMax;
  const maxEditorW = box.w ? Math.min(LIMITS.editorMax, box.w - 360) : LIMITS.editorMax;
  const editorW = clamp(layout.editorW, LIMITS.editorMin, maxEditorW);
  const maxSide = Math.min(LIMITS.sideMax, window.innerWidth - 400);
  const sideW = clamp(layout.sideW, LIMITS.sideMin, maxSide);

  // opening a clip or picking a tab brings a collapsed editor back
  const prev = useRef({ tab: s.bottom, clip: s.editorClip });
  useEffect(() => {
    const p = prev.current;
    if ((p.tab !== s.bottom || p.clip !== s.editorClip) && col.editor) setCollapsed('editor', false);
    prev.current = { tab: s.bottom, clip: s.editorClip };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') { e.preventDefault(); s.play(); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) s.session.undo.redo(); else s.session.undo.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.session.undo.redo(); }
      else if (mod && e.key.toLowerCase() === 'd' && s.selectedClips.size) {
        // repeat the selection right after itself
        e.preventDefault();
        const sel = [...s.selectedClips].map((id) => s.snap.clips[id]).filter(Boolean);
        const span = Math.max(...sel.map((c) => c.start + c.length)) - Math.min(...sel.map((c) => c.start));
        const ids: string[] = [];
        s.edit((d) => { for (const c of sel) ids.push(M.addClip(d, { ...c, id: undefined, start: c.start + span })); });
        s.selectClips(ids);
      }
      else if (mod && e.key.toLowerCase() === 'a' && !el.closest('.pianoroll')) {
        e.preventDefault();
        s.selectClips(Object.keys(s.snap.clips));
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedClips.size && !el.closest('.pianoroll')) {
        e.preventDefault();
        const ids = [...s.selectedClips];
        s.edit((d) => { for (const id of ids) M.deleteClip(d, id); });
        s.selectClips([]);
      }
      else if (e.key === 'r' && !mod && e.shiftKey) { e.preventDefault(); s.record(); }
      else if (e.key === 'Enter' && !mod) { e.preventDefault(); s.stop(); }
      else if (e.key === '?' && !mod) { e.preventDefault(); setShortcuts((v) => !v); }
      else if (e.key === 'Escape') { s.panic(); if (s.selectedClips.size > 1) s.selectClips([]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s]);

  const toggleSide = () => {
    if (layout.side === 'hidden') setLayout({ side: 'right', collapsed: { ...col, side: false } });
    else setCollapsed('side', !col.side);
  };

  const sidePane = sidePos !== 'hidden' && (
    <ErrorBoundary label="the people panel"><People pos={sidePos} collapsed={col.side} onToggle={() => setCollapsed('side', !col.side)} /></ErrorBoundary>
  );
  const sideSplit = sidePos !== 'hidden' && !col.side && (
    <Splitter dir="col" label="Resize people panel" value={sideW} min={LIMITS.sideMin} max={maxSide} invert={sidePos === 'right'}
      onChange={(v) => setLayout({ sideW: v })} onReset={() => resetLayout('sideW')} />
  );
  const editor = <EditorPane pos={edPos} collapsed={col.editor} onToggle={() => setCollapsed('editor', !col.editor)} />;
  const edSplit = edPos !== 'bottom' && !col.editor && (
    <Splitter dir="col" label="Resize editor panel" value={editorW} min={LIMITS.editorMin} max={maxEditorW} invert={edPos === 'right'}
      onChange={(v) => setLayout({ editorW: v })} onReset={() => resetLayout('editorW')} />
  );

  return (
    <div className={`studio side-${sidePos} editor-${edPos}`}
      style={{ ['--side-w' as string]: `${sideW}px`, ['--bottom-h' as string]: `${bottomH}px`, ['--kb-h' as string]: `${kbH}px`, ['--editor-w' as string]: `${editorW}px` }}>
      <TopBar onSettings={() => setSettings(true)} onToggleSide={toggleSide} sideOpen={sidePos !== 'hidden' && !col.side}
        onAppearance={() => setDrawer((d) => (d === 'appearance' ? null : 'appearance'))}
        onLayout={() => setDrawer((d) => (d === 'layout' ? null : 'layout'))}
        onShortcuts={() => setShortcuts(true)} />
      <div className="workspace">
        {sidePos === 'left' && sidePane}
        {sidePos === 'left' && sideSplit}
        <main className="center" ref={center}>
          <div className="main-row">
            {edPos === 'left' && editor}
            {edPos === 'left' && edSplit}
            <ErrorBoundary label="the arrangement"><Arrange welcome={<Welcome onShortcuts={() => setShortcuts(true)} onLayout={() => setDrawer('layout')} />} /></ErrorBoundary>
            {edPos === 'right' && edSplit}
            {edPos === 'right' && editor}
          </div>
          {edBottomOpen && (
            <Splitter dir="row" label="Resize timeline and bottom panel" value={bottomH} min={LIMITS.bottom} max={maxBottom}
              onChange={(v) => setLayout({ bottomH: v })} onReset={() => resetLayout('bottomH')} />
          )}
          {edPos === 'bottom' && editor}
          {kbOn && !col.keyboard && (
            <Splitter dir="row" label="Resize keyboard" value={kbH} min={LIMITS.kbMin} max={maxKb}
              onChange={(v) => setLayout({ kbH: v })} onReset={() => resetLayout('kbH')} />
          )}
          {kbOn && <Keyboard collapsed={col.keyboard} onToggle={() => setCollapsed('keyboard', !col.keyboard)} />}
        </main>
        {sidePos === 'right' && sideSplit}
        {sidePos === 'right' && sidePane}
      </div>
      {settings && <Settings onClose={() => setSettings(false)} />}
      {drawer === 'appearance' && <Appearance onClose={() => setDrawer(null)} />}
      {drawer === 'layout' && <LayoutEditor onClose={() => setDrawer(null)} />}
      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
      <div className="toasts" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
            <Icon name={t.kind === 'error' ? 'alert' : 'check'} />{t.text}
          </div>
        ))}
        {[...s.uploads.values()].map((u) => <div key={u} className="toast"><span className="spinner" />Saving {u}…</div>)}
      </div>
    </div>
  );
}

/** Instrument & FX / Piano roll / Mixer, wherever the layout puts it. */
function EditorPane({ pos, collapsed, onToggle }: { pos: EditorPos; collapsed: boolean; onToggle: () => void }) {
  const s = useStudio();
  const selected = s.selectedTrack ? s.snap.tracks[s.selectedTrack] : undefined;
  const open = (t: BottomTab) => { s.setBottom(t); if (collapsed) onToggle(); };
  if (collapsed && pos !== 'bottom') {
    return (
      <section className={`bottom editor-pane pos-${pos} rail`} aria-label="Editor panel (collapsed)">
        <CollapseButton collapsed edge={pos} label="editor panel" onClick={onToggle} />
        {TABS.map(([t, label, icon]) => (
          <button key={t} className={`icon-btn rail-btn ${s.bottom === t ? 'active' : ''}`} onClick={() => open(t)} title={label} aria-label={label}><Icon name={icon} size={17} /></button>
        ))}
      </section>
    );
  }
  return (
    <section className={`bottom editor-pane pos-${pos} ${collapsed ? 'collapsed' : ''}`} aria-label="Editor panel">
      <nav className="tabs" role="tablist" aria-label="Bottom panel">
        {TABS.map(([t, label, icon]) => (
          <button key={t} role="tab" aria-selected={!collapsed && s.bottom === t} className={!collapsed && s.bottom === t ? 'on' : ''} onClick={() => open(t)}>
            <Icon name={icon} /><span className="tab-label">{label}</span>
          </button>
        ))}
        <span className="spacer" />
        {selected && <span className="tabs-context muted small"><span className="tc-dot" style={{ background: selected.color }} />{selected.name}</span>}
        <CollapseButton collapsed={collapsed} edge={pos} label="editor panel" onClick={onToggle} />
      </nav>
      {!collapsed && (
        <div className="bottom-body">
          <ErrorBoundary key={`${s.bottom}:${s.selectedTrack}`} label="this panel">
            {s.bottom === 'track' && <Inspector />}
            {s.bottom === 'editor' && <PianoRoll />}
            {s.bottom === 'mixer' && <Mixer />}
          </ErrorBoundary>
        </div>
      )}
    </section>
  );
}

const TABS: [BottomTab, string, IconName][] = [['track', 'Instrument & FX', 'sliders'], ['editor', 'Piano Roll', 'piano'], ['mixer', 'Mixer', 'mixer']];

const WELCOME_KEY = 'wemake.welcomed';
/** First-visit steps, shown in-line above the timeline until dismissed. */
function Welcome({ onShortcuts, onLayout }: { onShortcuts: () => void; onLayout: () => void }) {
  const s = useStudio();
  const [show, setShow] = useState(() => { try { return !localStorage.getItem(WELCOME_KEY); } catch { return false; } });
  if (!show) return null;
  const done = () => { setShow(false); try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* */ } };
  const invite = () => {
    const url = `${location.origin}${location.pathname}?room=${s.room}`;
    navigator.clipboard?.writeText(url).then(() => s.toast('Invite link copied. Send it to your friends.'), () => s.toast(url));
  };
  return (
    <div className="welcome" role="region" aria-label="Getting started">
      <ol>
        <li><b>Invite friends.</b> <button className="link" onClick={invite}>Copy the session link</button> and send it to them.</li>
        <li><b>Pick a track and press R</b> to play it with keys A to K, a MIDI keyboard or your mic.</li>
        <li><b>Press record</b> (Shift+R) to lay down a take everyone hears.</li>
      </ol>
      <div className="welcome-actions">
        <button className="ghost small" onClick={onLayout}><Icon name="layout" />Layout</button>
        <button className="ghost small" onClick={onShortcuts}><Icon name="keyboard" />Shortcuts</button>
        <button className="small" onClick={done}>Got it</button>
      </div>
    </div>
  );
}
