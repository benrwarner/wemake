// Personal appearance: a theme is 4 seed colours plus a few shape/backdrop
// settings. Every other colour in the UI is derived from those seeds here, so
// any combination stays legible. Stored per browser, never shared with the room.
import { useSyncExternalStore } from 'react';
import { faviconHref } from './logo';
import { alpha, contrast, ensureContrast, extractPalette, inkOn, isHex, lch, luminance, mix, toLch } from './color';

export interface Theme {
  preset: string | null; // id of the preset it came from (null once edited)
  bg: string;
  text: string;
  accent: string;
  accent2: string;
  radius: number; // px, 2..18
  dim: number; // darken/lighten the page-background picture, 0..0.9
  blur: number; // px of blur on the page-background picture, 0..30
  image: boolean; // a picture is stored in IndexedDB
  bgPicture: boolean; // show the picture behind everything
  surfaces: Surface[]; // panes that embed the picture themselves
  paneBlur: number; // px of blur on the picture inside panes, 0..40
  paneTint: number; // how much panel colour covers the picture in panes, 0.25..0.95
}

/** Parts of the interface that can show the picture inside themselves. */
export const SURFACES = [
  ['topbar', 'Top bar'],
  ['toolbar', 'Toolbars & ruler'],
  ['timeline', 'Timeline'],
  ['editor', 'Editor panel'],
  ['side', 'People & chat'],
  ['keyboard', 'Keyboard'],
  ['cards', 'Cards & dialogs'],
] as const;
export type Surface = typeof SURFACES[number][0];
const SURFACE_IDS = SURFACES.map(([id]) => id) as Surface[];

export interface Preset { id: string; name: string; bg: string; text: string; accent: string; accent2: string; radius?: number }

export const PRESETS: Preset[] = [
  { id: 'console', name: 'Console', bg: '#15171c', text: '#ebe7df', accent: '#f4b740', accent2: '#4fc4b8' },
  { id: 'tape', name: 'Tape', bg: '#1c1511', text: '#f1e4cf', accent: '#ff8a3d', accent2: '#a3c96b' },
  { id: 'deep', name: 'Deep sea', bg: '#0d1623', text: '#dfeaf5', accent: '#53c7ff', accent2: '#ffd166' },
  { id: 'moss', name: 'Moss', bg: '#131913', text: '#e3ead8', accent: '#b8df5c', accent2: '#e8a0bf' },
  { id: 'bloom', name: 'Bloom', bg: '#1d1420', text: '#f6e6f0', accent: '#ff7bb5', accent2: '#8fd3ff' },
  { id: 'daylight', name: 'Daylight', bg: '#ebebe6', text: '#1b1d22', accent: '#3463e0', accent2: '#0f9a78' },
  { id: 'studio-white', name: 'Studio white', bg: '#f4f5f7', text: '#16181d', accent: '#7a55f0', accent2: '#e2533a', radius: 12 },
  { id: 'contrast', name: 'High contrast', bg: '#000000', text: '#ffffff', accent: '#ffd400', accent2: '#00e0ff', radius: 4 },
];

const BASE = { radius: 9, dim: 0.35, blur: 0, image: false, bgPicture: true, surfaces: SURFACE_IDS.filter((x) => x !== 'cards'), paneBlur: 18, paneTint: 0.6 };
export const DEFAULT_THEME: Theme = { ...BASE, ...fromPreset(PRESETS[0]) };

function fromPreset(p: Preset) {
  return { preset: p.id, bg: p.bg, text: p.text, accent: p.accent, accent2: p.accent2, ...(p.radius != null ? { radius: p.radius } : {}) };
}

const KEY = 'wemake.theme';
const num = (v: unknown, lo: number, hi: number, f: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : f);

/** Accept anything (storage, imported file) and return a valid theme. */
export function sanitize(v: unknown): Theme {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof Theme, unknown>>;
  const d = DEFAULT_THEME;
  return {
    preset: typeof o.preset === 'string' && PRESETS.some((p) => p.id === o.preset) ? o.preset : null,
    bg: isHex(o.bg) ? o.bg : d.bg,
    text: isHex(o.text) ? o.text : d.text,
    accent: isHex(o.accent) ? o.accent : d.accent,
    accent2: isHex(o.accent2) ? o.accent2 : d.accent2,
    radius: num(o.radius, 2, 18, d.radius),
    dim: num(o.dim, 0, 0.9, d.dim),
    blur: num(o.blur, 0, 30, d.blur),
    image: o.image === true,
    bgPicture: o.bgPicture !== false,
    surfaces: Array.isArray(o.surfaces) ? SURFACE_IDS.filter((x) => (o.surfaces as unknown[]).includes(x)) : d.surfaces,
    paneBlur: num(o.paneBlur, 0, 40, d.paneBlur),
    paneTint: num(o.paneTint, 0.25, 0.95, d.paneTint),
  };
}

function load(): Theme {
  try { const raw = localStorage.getItem(KEY); return raw ? sanitize(JSON.parse(raw)) : DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

// ------------------------------------------------------------ store

let theme: Theme = load();
let imageUrl: string | null = null;
let imageBlob: Blob | null = null;
let paneUrl: string | null = null; // the picture pre-blurred for panes
let version = 0;
const subs = new Set<() => void>();
const emit = () => { version++; subs.forEach((f) => f()); };

export function getTheme() { return theme; }
export function getImageUrl() { return imageUrl; }

export function setTheme(patch: Partial<Theme>, keepPreset = false) {
  const colorEdit = ['bg', 'text', 'accent', 'accent2'].some((k) => k in patch);
  const reblur = 'paneBlur' in patch && patch.paneBlur !== theme.paneBlur;
  theme = sanitize({ ...theme, ...patch, preset: patch.preset !== undefined ? patch.preset : colorEdit && !keepPreset ? null : theme.preset });
  try { localStorage.setItem(KEY, JSON.stringify(theme)); } catch { /* storage full or blocked: still applies for this visit */ }
  applyTheme();
  emit();
  if (reblur) schedulePaneRender();
}

export function applyPreset(p: Preset) { setTheme({ ...fromPreset(p), radius: p.radius ?? BASE.radius }, true); }
export function resetTheme() { void clearImage(); setTheme({ ...DEFAULT_THEME }, true); }

export function useTheme() {
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  return { theme, imageUrl };
}

// ------------------------------------------------------------ derived tokens

export const isLight = (t: Pick<Theme, 'bg'>) => luminance(t.bg) > 0.4;

/** Everything the stylesheet reads, derived from the seeds. */
export function tokens(t: Theme): Record<string, string> {
  const light = isLight(t);
  const { bg, text } = t;
  // keep text readable even if someone picks two similar colours
  const tx = contrast(text, bg) >= 4.5 ? text : inkOn(bg, '#16181d', '#f2f0ea');
  const pic = t.image && !!imageUrl;
  const panelSolid = light ? mix(bg, '#ffffff', 0.55) : mix(bg, tx, 0.04);
  const panel2Solid = light ? mix(bg, tx, 0.035) : mix(bg, tx, 0.075);
  const raised = light ? mix(bg, '#ffffff', 0.85) : mix(bg, tx, 0.12);
  const accentText = ensureContrast(t.accent, panelSolid, 4.5);
  const accent2Text = ensureContrast(t.accent2, panelSolid, 4.5);
  const rec = light ? '#d92d2d' : '#ff5252';
  return {
    '--bg': bg,
    '--panel': panelSolid,
    '--panel-solid': panelSolid,
    '--panel2': pic ? alpha(panel2Solid, 0.62) : panel2Solid,
    '--pane-tint': alpha(panelSolid, t.paneTint),
    '--lane-tint': alpha(mix(bg, '#000000', light ? 0 : 0.2), Math.max(0.15, t.paneTint - 0.2)),
    '--raised': raised,
    '--field': light ? mix(bg, '#ffffff', 0.9) : mix(bg, '#000000', 0.35),
    '--lcd': light ? mix(tx, bg, 0.06) : mix(bg, '#000000', 0.5),
    '--lcd-text': light ? ensureContrast(mix(t.accent, '#ffffff', 0.35), mix(tx, bg, 0.06), 4.5) : ensureContrast(t.accent, mix(bg, '#000000', 0.5), 5),
    '--line': light ? mix(bg, tx, 0.13) : mix(bg, tx, 0.13),
    '--line-strong': light ? mix(bg, tx, 0.26) : mix(bg, tx, 0.24),
    '--text': tx,
    '--muted': mix(tx, light ? panelSolid : bg, light ? 0.38 : 0.4),
    '--faint': mix(tx, bg, 0.62),
    '--accent': t.accent,
    '--accent-ink': inkOn(t.accent),
    '--accent-text': accentText,
    '--accent-soft': alpha(t.accent, light ? 0.16 : 0.2),
    '--accent2': t.accent2,
    '--accent2-ink': inkOn(t.accent2),
    '--accent2-text': accent2Text,
    '--accent2-soft': alpha(t.accent2, light ? 0.16 : 0.2),
    '--rec': rec,
    '--rec-soft': alpha(rec, 0.18),
    '--ok': light ? '#1f9d55' : '#7bd88f',
    '--warn': light ? '#b7791f' : '#ffb547',
    '--hover': alpha(tx, light ? 0.06 : 0.07),
    '--press': alpha(tx, light ? 0.1 : 0.12),
    '--grid-bar': alpha(tx, light ? 0.2 : 0.13),
    '--grid-beat': alpha(tx, light ? 0.08 : 0.05),
    '--grid-sub': alpha(tx, light ? 0.04 : 0.022),
    '--lane': pic && t.bgPicture ? alpha(bg, 0.45) : mix(bg, light ? '#ffffff' : '#000000', light ? 0.25 : 0.12),
    '--shadow': light ? '0 1px 2px rgba(20,22,30,.06), 0 8px 24px rgba(20,22,30,.1)' : '0 1px 2px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.45)',
    '--focus': ensureContrast(t.accent, bg, 3),
    '--r': `${t.radius}px`,
    '--r-sm': `${Math.max(2, Math.round(t.radius * 0.6))}px`,
    '--r-lg': `${Math.round(t.radius * 1.5)}px`,
    '--bg-dim': String(t.dim),
    '--bg-blur': `${t.blur}px`,
  };
}

export function applyTheme(t = theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens(t))) root.style.setProperty(k, v);
  const light = isLight(t);
  root.dataset.mode = light ? 'light' : 'dark';
  const pic = t.image && imageUrl;
  root.dataset.image = pic && t.bgPicture ? '1' : '';
  if (pic && paneUrl && t.surfaces.length) root.dataset.pic = t.surfaces.join(' '); else delete root.dataset.pic;
  if (pic && paneUrl) root.style.setProperty('--pic', `url("${paneUrl}")`); else root.style.removeProperty('--pic');
  root.style.colorScheme = light ? 'light' : 'dark';
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = t.bg;
  // the tab icon follows the theme too
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
  const href = faviconHref(t.bg, t.accent);
  if (icon.href !== href) icon.href = href;
}

/**
 * The theme re-coloured around one colour (the lobby's "Your colour"): it becomes the accent, and the
 * background keeps its lightness but takes on that colour's hue, so the page reads as one family.
 * Never saved; the stored theme is untouched.
 */
export function tintTheme(t: Theme, color: string): Theme {
  if (!isHex(color)) return t;
  const [L, C] = toLch(t.bg);
  const [, cC, cH] = toLch(color);
  const light = isLight(t);
  // a whisper of chroma: enough to feel the hue, never enough to fight the text
  const chroma = Math.min(cC, Math.max(C, light ? 6 : 7) + (light ? 2 : 4));
  return { ...t, bg: lch(L, chroma, cH), accent: color };
}

/** Readability report for the editor: text and accent against the panels. */
export function readability(t: Theme) {
  const tk = tokens(t);
  return {
    text: contrast(t.text, t.bg),
    accentOnPanel: contrast(t.accent, tk['--panel-solid']),
  };
}

// ------------------------------------------------------------ background image (IndexedDB)

const DB = 'wemake-theme', STORE = 'files', IMG = 'background';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('Could not open browser storage'));
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise<T>((res, rej) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { res(req.result as T); d.close(); };
    tx.onerror = tx.onabort = () => { rej(tx.error ?? new Error('Browser storage failed')); d.close(); };
  });
}

function setUrl(blob: Blob | null) {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = blob ? URL.createObjectURL(blob) : null;
  imageBlob = blob;
  if (!blob && paneUrl) { URL.revokeObjectURL(paneUrl); paneUrl = null; }
  if (blob) schedulePaneRender(0);
}

// Panes show a pre-blurred copy, so they can be blurrier than the page
// background without any per-frame filter cost while playing.
let paneTimer = 0;
let paneJob = 0;
function schedulePaneRender(delay = 160) {
  clearTimeout(paneTimer);
  paneTimer = window.setTimeout(() => void renderPane(), delay);
}
async function renderPane() {
  const blob = imageBlob;
  if (!blob) return;
  const job = ++paneJob;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d')!;
    const r = (theme.paneBlur * w) / Math.max(window.innerWidth, 800); // screen px -> canvas px
    if (r > 0.5 && 'filter' in g) {
      g.filter = `blur(${r.toFixed(1)}px)`;
      const pad = r * 2; // overdraw so edges don't fade to transparent
      g.drawImage(bmp, -pad, -pad, w + pad * 2, h + pad * 2);
    } else if (r > 0.5) {
      // no canvas filters (older Safari): soften by shrinking and enlarging
      const f = Math.max(2, r / 2);
      const sm = document.createElement('canvas');
      sm.width = Math.max(1, Math.round(w / f)); sm.height = Math.max(1, Math.round(h / f));
      sm.getContext('2d')!.drawImage(bmp, 0, 0, sm.width, sm.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(sm, 0, 0, w, h);
    } else {
      g.drawImage(bmp, 0, 0, w, h);
    }
    bmp.close();
    const out = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.86));
    if (!out || job !== paneJob || blob !== imageBlob) return;
    if (paneUrl) URL.revokeObjectURL(paneUrl);
    paneUrl = URL.createObjectURL(out);
    applyTheme(); emit();
  } catch { /* panes fall back to plain colour */ }
}

export const MAX_IMAGE_MB = 30;

/** Downscale, store and switch on a background image. Returns the stored blob. */
export async function setImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} isn't an image. Choose a JPG, PNG, WebP or GIF.`);
  if (file.size > MAX_IMAGE_MB * 1024 * 1024) throw new Error(`That image is ${(file.size / 1048576).toFixed(0)} MB. Choose one under ${MAX_IMAGE_MB} MB.`);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(`Couldn't read ${file.name}. It may be damaged or in an unsupported format.`); }
  const max = 2560;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not process the image'))), 'image/jpeg', 0.88));
  try { await idb('readwrite', (s) => s.put(blob, IMG)); } catch { throw new Error('Your browser blocked saving the image (private window or storage full). It will show until you reload.'); }
  setUrl(blob);
  setTheme({ image: true }, true);
  return blob;
}

export async function clearImage() {
  setUrl(null);
  try { await idb('readwrite', (s) => s.delete(IMG)); } catch { /* nothing stored */ }
  if (theme.image) setTheme({ image: false }, true); else { applyTheme(); emit(); }
}

/** Load the stored background image on start-up. */
export async function restoreImage() {
  if (!theme.image) return;
  try {
    const blob = await idb<Blob | undefined>('readonly', (s) => s.get(IMG));
    if (blob) { setUrl(blob); applyTheme(); emit(); return; }
  } catch { /* storage unavailable */ }
  setTheme({ image: false }, true);
}

/** Build a theme whose colours come from the background image. */
export async function themeFromImage(src?: Blob): Promise<Partial<Theme>> {
  const blob = src ?? (imageUrl ? await (await fetch(imageUrl)).blob() : null);
  if (!blob) throw new Error('Add a background image first.');
  const bmp = await createImageBitmap(blob);
  const sw = extractPalette(bmp, 6);
  bmp.close();
  if (!sw.length) throw new Error('Could not read colours from that image.');
  const avgL = sw.reduce((a, s) => a + s.lab[0] * s.weight, 0);
  const light = avgL > 0.72;
  const hue = (s: { lab: number[] }) => ((Math.atan2(s.lab[2], s.lab[1]) * 180) / Math.PI + 360) % 360;
  const chroma = (s: { lab: number[] }) => Math.hypot(s.lab[1], s.lab[2]);
  const base = sw[0];
  const bg = lch(light ? 0.95 : 0.19, Math.min(chroma(base) * 0.35, 0.03), hue(base));
  const text = lch(light ? 0.22 : 0.93, 0.012, hue(base));
  const vivid = [...sw].sort((a, b) => chroma(b) * Math.sqrt(b.weight + 0.05) - chroma(a) * Math.sqrt(a.weight + 0.05));
  const a1 = vivid[0];
  const h1 = chroma(a1) > 0.03 ? hue(a1) : (hue(base) + 40) % 360;
  const accent = lch(light ? 0.56 : 0.8, Math.max(0.13, Math.min(0.19, chroma(a1) * 1.2)), h1);
  const hd = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
  const a2 = vivid.slice(1).find((s) => chroma(s) > 0.04 && hd(hue(s), h1) > 45);
  const h2 = a2 ? hue(a2) : (h1 + 150) % 360;
  const accent2 = lch(light ? 0.58 : 0.78, 0.12, h2);
  return { bg, text, accent, accent2 };
}

// re-exported for the editor's contrast notes
export { contrast, toLch };
