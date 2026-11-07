import { useEffect, useMemo, useState } from 'react';
import * as M from '../../../shared/model';
import type { Track } from '../../../shared/model';
import type { Studio } from '../state/studio';
import { CATEGORIES, loadCatalog, search, type CatalogItem } from '../audio/plugins/catalog';
import { builtinFx, builtinInstruments, catalogTrusted, getDef, isCatalogPlugin, trustCatalog } from '../audio/plugins/registry';
import * as account from '../net/account';
import { useUser, type SavedSound } from '../net/account';
import { Icon } from './Icon';

type Source = 'builtin' | 'community' | 'mine';
type Card = Omit<CatalogItem, 'id'> & { id: string; params?: Record<string, number>; saved?: SavedSound };

const builtins = (): Card[] =>
  [...builtinInstruments(), ...builtinFx()].map((d) => ({
    id: d.type, name: d.name, vendor: 'WeMake', description: d.description ?? '', keywords: [d.category ?? ''],
    kind: d.kind, category: d.kind === 'instrument' ? 'Instruments' : (d.category ?? 'Other'), type: d.type,
  }));

function savedCard(s: SavedSound): Card {
  const plugin = getDef(s.plugin_type)?.name ?? (isCatalogPlugin(s.plugin_type) ? 'Community plugin' : s.plugin_type);
  return {
    id: s.id, name: s.name, vendor: plugin, description: `${s.kind === 'instrument' ? 'Instrument' : 'Effect'} · settings only`,
    keywords: [plugin], kind: s.kind, category: s.kind === 'instrument' ? 'Instruments' : (getDef(s.plugin_type)?.category ?? 'Other'),
    type: s.plugin_type, params: s.params, saved: s,
  };
}

export function BrowseSounds({ s, t, onClose, initialKind }: { s: Studio; t: Track; onClose: () => void; initialKind?: 'fx' | 'instrument' }) {
  const [user] = useUser();
  const [source, setSource] = useState<Source>('community');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>(initialKind === 'instrument' ? 'Instruments' : 'All');
  const [community, setCommunity] = useState<CatalogItem[] | null>(null);
  const [mine, setMine] = useState<SavedSound[] | null>(null);
  const [pending, setPending] = useState<Card | null>(null); // waiting for "Allow" on first community add
  const [error, setError] = useState('');

  useEffect(() => { void loadCatalog().then(setCommunity); }, []);
  useEffect(() => {
    if (!user) { setMine(null); if (source === 'mine') setSource('community'); return; }
    account.sounds().then(setMine, (e) => setError(String(e.message ?? e)));
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);

  const cards: Card[] = useMemo(() => {
    const list = source === 'builtin' ? builtins() : source === 'community' ? (community ?? []) : (mine ?? []).map(savedCard);
    return search(list, q, cat);
  }, [source, community, mine, q, cat]);

  const canAdd = (c: Card) => c.kind === 'fx' || t.kind === 'instrument';
  const apply = (c: Card) => {
    if (c.kind === 'instrument') s.edit((d) => M.setInstrument(d, t.id, c.type, c.params ?? {}));
    else s.edit((d) => M.addFx(d, t.id, c.type, c.params ?? {}));
    s.toast(`${c.name} added to ${t.name}`);
  };
  const add = (c: Card) => {
    if (!canAdd(c)) return;
    if (isCatalogPlugin(c.type) && !catalogTrusted()) { setPending(c); return; }
    apply(c);
  };
  const remove = async (c: Card) => {
    if (!c.saved) return;
    setMine((m) => m?.filter((x) => x.id !== c.id) ?? null);
    try { await account.deleteSound(c.id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const rename = async (c: Card, name: string) => {
    try {
      await account.renameSound(c.id, name);
      setMine((m) => m?.map((x) => (x.id === c.id ? { ...x, name } : x)) ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal browse" role="dialog" aria-modal="true" aria-label="Browse sounds">
        <header>
          <div className="modal-title">
            <h2>Browse sounds</h2>
            <span className="muted small">Adding to <span className="tc-dot" style={{ background: t.color }} /><b>{t.name}</b></span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="browse-bar">
          <div className="segmented" role="tablist" aria-label="Source">
            <button role="tab" aria-selected={source === 'builtin'} className={source === 'builtin' ? 'on' : ''} onClick={() => setSource('builtin')}>Built-in</button>
            <button role="tab" aria-selected={source === 'community'} className={source === 'community' ? 'on' : ''} onClick={() => setSource('community')}>Community</button>
            {user && <button role="tab" aria-selected={source === 'mine'} className={source === 'mine' ? 'on' : ''} onClick={() => setSource('mine')}>My sounds</button>}
          </div>
          <span className="search-field"><Icon name="search" />
          <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, maker, style…" aria-label="Search sounds" /></span>
        </div>
        <div className="chips" role="group" aria-label="Category">
          {CATEGORIES.map((c) => <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
        {pending && (
          <div className="trust browse-trust" role="alert">
            <p><Icon name="plug" />Allow plugins from webaudiomodules.com? They run in your browser and in your friends' browsers.</p>
            <div className="row">
              <button className="primary" onClick={() => { trustCatalog(); const c = pending; setPending(null); apply(c); }}>Allow</button>
              <button className="ghost" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
        {error && <div className="lobby-error">{error}</div>}
        {source === 'community' && community === null && <p className="muted loading-line"><span className="spinner" />Loading the community catalog…</p>}
        {source === 'community' && community?.length === 0 && <p className="muted">Couldn't load the community catalog. Built-in sounds still work.</p>}
        {source === 'mine' && mine?.length === 0 && <p className="muted">Nothing saved yet. Use “Save sound” on an instrument or effect to keep its settings here.</p>}
        <div className="browse-grid">
          {cards.map((c) => <SoundCard key={c.id} c={c} canAdd={canAdd(c)} onAdd={() => add(c)} onRemove={c.saved ? () => void remove(c) : undefined} onRename={c.saved ? (n) => void rename(c, n) : undefined} />)}
          {cards.length === 0 && (source !== 'community' || community?.length) ? <p className="muted">No sounds match.</p> : null}
        </div>
      </div>
    </div>
  );
}

function SoundCard({ c, canAdd, onAdd, onRemove, onRename }: { c: Card; canAdd: boolean; onAdd: () => void; onRemove?: () => void; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  return (
    <div className="sound-card">
      {c.thumbnail ? <img src={c.thumbnail} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <div className={`sound-icon ${c.kind}`} aria-hidden><Icon name={c.kind === 'instrument' ? 'keys' : 'sliders'} size={34} /></div>}
      <div className="sound-body">
        {editing ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onRename?.(name.trim()); setEditing(false); } }}>
            <input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} aria-label="Sound name" />
            <button type="submit">Save</button>
          </form>
        ) : <b className="sound-name">{c.name}</b>}
        <span className="muted small">{c.vendor}{c.category && c.category !== 'Instruments' ? ` · ${c.category}` : ''}</span>
        <p className="sound-desc muted small">{c.description}</p>
        <div className="row">
          <button className="primary" disabled={!canAdd} onClick={onAdd} title={canAdd ? undefined : 'Select an instrument track to use instruments'}>
            {c.kind === 'instrument' ? 'Use on track' : 'Add to track'}
          </button>
          {onRename && !editing && <button className="ghost small" onClick={() => setEditing(true)}>Rename</button>}
          {onRemove && <button className="ghost small" onClick={onRemove}>Delete</button>}
        </div>
      </div>
    </div>
  );
}

/** "Save sound": name it and store the plugin + its current settings in your account. */
export function SaveSound({ kind, type, defaultName, values }: { kind: 'fx' | 'instrument'; type: string; defaultName: string; values: () => Promise<Record<string, number>> }) {
  const [user] = useUser();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [state, setState] = useState<'' | 'saving' | 'saved' | string>('');
  if (!user) return null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('saving');
    try {
      await account.saveSound({ name: name.trim(), kind, plugin_type: type, params: await values() });
      setState('saved');
      setOpen(false);
      setTimeout(() => setState(''), 1500);
    } catch (err) {
      setState(err instanceof Error ? err.message : String(err));
    }
  };
  if (!open) {
    return (
      <button className="ghost small save-sound" onClick={() => { setName(defaultName); setState(''); setOpen(true); }} title="Save this sound and its settings to your account">
        {state === 'saved' ? '✓ Saved' : <><Icon name="star" />Save sound</>}
      </button>
    );
  }
  return (
    <form className="save-sound-form" onSubmit={save}>
      <input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Name this sound" aria-label="Name this sound"
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <button type="submit" disabled={!name.trim() || state === 'saving'}>Save</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      {state && state !== 'saving' && state !== 'saved' && <span className="error">{state}</span>}
    </form>
  );
}
