// Small colour toolkit for the theme engine: hex <-> OKLab/OKLCH, perceptual
// mixing, WCAG contrast and a k-means palette extractor for imported images.

export type RGB = [number, number, number]; // 0..1 sRGB
export type Lab = [number, number, number]; // OKLab L, a, b

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function parseHex(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0];
  const n = parseInt(h, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function toHex([r, g, b]: RGB) {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

export function rgbToLab([r, g, b]: RGB): Lab {
  r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (c: RGB) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLab -> sRGB, reducing chroma (not lightness) until it fits the sRGB gamut. */
export function labToRgb(lab: Lab): RGB {
  let lin = labToLinear(lab);
  if (!inGamut(lin)) {
    const [L, a, b] = lab;
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const k = (lo + hi) / 2;
      if (inGamut(labToLinear([L, a * k, b * k]))) lo = k; else hi = k;
    }
    lin = labToLinear([L, a * lo, b * lo]);
  }
  return lin.map((v) => toGamma(Math.max(0, Math.min(1, v)))) as RGB;
}

export const hexToLab = (h: string) => rgbToLab(parseHex(h));
export const labToHex = (l: Lab) => toHex(labToRgb(l));

export function lch(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  return labToHex([L, C * Math.cos(h), C * Math.sin(h)]);
}
export function toLch(hex: string): [number, number, number] {
  const [L, a, b] = hexToLab(hex);
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** Perceptual mix: t=0 gives a, t=1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const A = hexToLab(a), B = hexToLab(b);
  return labToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

export function alpha(hex: string, a: number) {
  const [r, g, b] = parseHex(hex).map((v) => Math.round(v * 255));
  return `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}

export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Black or white, whichever reads better on `bg`. */
export function inkOn(bg: string, dark = '#121317', light = '#ffffff') {
  return contrast(bg, dark) >= contrast(bg, light) ? dark : light;
}

/** Nudge `fg` lighter or darker (keeping its hue) until it reaches `ratio` against `bg`. */
export function ensureContrast(fg: string, bg: string, ratio: number): string {
  if (contrast(fg, bg) >= ratio) return fg;
  const [L, a, b] = hexToLab(fg);
  const up = luminance(bg) < 0.25;
  let out = fg;
  for (let i = 1; i <= 40; i++) {
    const nl = up ? L + (1 - L) * (i / 40) : L * (1 - i / 40);
    out = labToHex([nl, a, b]);
    if (contrast(out, bg) >= ratio) return out;
  }
  return out;
}

// ------------------------------------------------------------ palette extraction

export interface Swatch { hex: string; lab: Lab; weight: number }

/** Dominant colours of an image via k-means in OKLab on a small downsample. */
export function extractPalette(src: CanvasImageSource, k = 6): Swatch[] {
  const size = 72;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;
  const px: Lab[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    px.push(rgbToLab([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]));
  }
  if (!px.length) return [];
  const d2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  // deterministic farthest-point seeding
  const centers: Lab[] = [px[Math.floor(px.length / 2)]];
  while (centers.length < Math.min(k, px.length)) {
    let best = px[0], bd = -1;
    for (const p of px) {
      const d = Math.min(...centers.map((c) => d2(p, c)));
      if (d > bd) { bd = d; best = p; }
    }
    centers.push(best);
  }
  const assign = new Int32Array(px.length);
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < px.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) { const d = d2(px[i], centers[c]); if (d < bd) { bd = d; bi = c; } }
      assign[i] = bi;
    }
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) { const s = sum[assign[i]]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++; }
    sum.forEach((s, c) => { if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = centers.map(() => 0);
  for (let i = 0; i < px.length; i++) counts[assign[i]]++;
  return centers
    .map((lab, i) => ({ lab, hex: labToHex(lab), weight: counts[i] / px.length }))
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}
