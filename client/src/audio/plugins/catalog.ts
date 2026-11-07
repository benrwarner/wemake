// The public WAM Community plugin catalog (https://www.webaudiomodules.com/community/).
// Plugins load straight from webaudiomodules.com in each browser; nothing is stored on our server.
import { CATALOG_ALLOW } from './catalog-allow';

export const CATALOG_URL = 'https://www.webaudiomodules.com/community/plugins.json';
export const CATALOG_BASE = 'https://www.webaudiomodules.com/community/plugins/';
const CACHE_KEY = 'wemake.catalog';
const CACHE_MS = 24 * 3600_000;

export const CATEGORIES = ['All', 'Instruments', 'Distortion', 'Reverb', 'Delay', 'EQ & Filter', 'Modulation', 'Pitch', 'Amp'] as const;

export interface CatalogItem {
  id: string; // catalog identifier
  name: string;
  vendor: string;
  description: string;
  keywords: string[];
  kind: 'fx' | 'instrument';
  category: string;
  thumbnail?: string; // absolute URL
  type: string; // 'wam:' + absolute URL
}

const CATEGORY_NAMES: Record<string, string> = { 'Amp Simulator': 'Amp', 'Equalizer & Filter': 'EQ & Filter' };

/**
 * True only for an https URL on www.webaudiomodules.com under /community/plugins/, already in
 * normal form (no dot segments, encoded characters, credentials, port, query or fragment).
 * Plugin URLs come from shared session data that any participant can edit, so be strict.
 */
export function isCatalogUrl(url: string): boolean {
  if (typeof url !== 'string' || /[%\\?#@]/.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.href === url &&
    u.protocol === 'https:' &&
    u.host === 'www.webaudiomodules.com' &&
    u.pathname.startsWith('/community/plugins/') &&
    !u.pathname.split('/').some((seg) => seg === '..' || seg === '.')
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseCatalog(json: unknown, allow: Set<string>): CatalogItem[] {
  if (!Array.isArray(json)) return [];
  const out: CatalogItem[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const id = str(p.identifier);
    const cats = Array.isArray(p.category) ? p.category.map(str) : [];
    const top = cats[0];
    if (!allow.has(id) || (top !== 'Effect' && top !== 'Instrument')) continue;
    let url: string;
    try {
      url = new URL(str(p.path), CATALOG_BASE).href;
    } catch {
      continue;
    }
    if (!isCatalogUrl(url)) continue;
    let thumbnail: string | undefined;
    try {
      const t = p.thumbnail ? new URL(str(p.thumbnail), CATALOG_BASE).href : '';
      if (t && isCatalogUrl(t)) thumbnail = t;
    } catch { /* no thumbnail */ }
    const kind = top === 'Instrument' ? 'instrument' : 'fx';
    const sub = cats[1] ?? 'Other';
    out.push({
      id,
      name: str(p.name) || id,
      vendor: str(p.vendor),
      description: str(p.description),
      keywords: Array.isArray(p.keywords) ? p.keywords.map(str).filter(Boolean) : [],
      kind,
      category: kind === 'instrument' ? 'Instruments' : (CATEGORY_NAMES[sub] ?? sub),
      thumbnail,
      type: `wam:${url}`,
    });
  }
  return out;
}

export function matchesCategory(item: Pick<CatalogItem, 'category' | 'kind'>, category: string | null): boolean {
  if (!category || category === 'All') return true;
  if (category === 'Instruments') return item.kind === 'instrument';
  return item.category === category || item.category.split(' & ').includes(category);
}

/** Every word must appear in the name, maker, description or keywords. */
export function search<T extends Pick<CatalogItem, 'name' | 'vendor' | 'description' | 'keywords' | 'category' | 'kind'>>(
  items: T[],
  q: string,
  category: string | null,
): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    if (!matchesCategory(i, category)) return false;
    const hay = [i.name, i.vendor, i.description, ...i.keywords].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

let memory: CatalogItem[] | null = null;

/** Display name for a catalog plugin URL, if the catalog has been loaded. */
export function catalogName(url: string): string | undefined {
  return memory?.find((i) => i.type === `wam:${url}`)?.name;
}

/** The curated catalog, cached for a day in localStorage. Falls back to a stale copy, then []. */
export async function loadCatalog(): Promise<CatalogItem[]> {
  let cached: { t: number; json: unknown } | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
  } catch { /* none */ }
  if (cached && Date.now() - cached.t < CACHE_MS) return (memory = parseCatalog(cached.json, CATALOG_ALLOW));
  try {
    const res = await fetch(CATALOG_URL, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), json })); } catch { /* storage full or blocked */ }
    return (memory = parseCatalog(json, CATALOG_ALLOW));
  } catch {
    return (memory = cached ? parseCatalog(cached.json, CATALOG_ALLOW) : []);
  }
}
