// The WM logo: one continuous oscilloscope trace drawing the letters W and M (from WM_synth_waveform_logo.svg).
export const WAVE = 'M20 430H270L282 426H286V422H294V414H302V409H310V430H318V389H328V430H336V367H348V482H362V337H470L535 507H545L615 337H660L720 507H730L790 337H835V430H945V519H975V317H1035L1110 482H1120L1200 317H1258V507H1328V367H1338V430H1350V389H1360V430H1370V409H1380V414H1390V422H1398V426H1410H1707';

/** The trace's absolute M/L/H/V commands mapped through x' = x*sx+dx, y' = y*sy+dy (a non-uniform scale that keeps strokes even). */
function mapWave(sx: number, dx: number, sy: number, dy: number) {
  const r = (v: number) => +v.toFixed(2);
  return WAVE.replace(/([MLHV])([^MLHV]*)/g, (_, c: string, args: string) => {
    const n = args.trim().split(/[\s,]+/).map(Number);
    if (c === 'H') return `H${r(n[0] * sx + dx)}`;
    if (c === 'V') return `V${r(n[0] * sy + dy)}`;
    return `${c}${r(n[0] * sx + dx)} ${r(n[1] * sy + dy)}`;
  });
}

// square crop centred on the letters (x 330..1270, y 317..519), stretched taller so they read at 16px;
// the flat tails run off the tile's edges
const ICON_PATH = mapWave(0.0915, 50 - 800 * 0.0915, 0.3, 50 - 418 * 0.3);

/** Browser-tab icon: the W M part of the trace in the accent on a rounded tile of the background. */
export function faviconSvg(bg: string, accent: string) {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>`
    + `<rect width='100' height='100' rx='22' fill='${bg}'/>`
    + `<path d='${ICON_PATH}' fill='none' stroke='${accent}' stroke-width='6' stroke-linejoin='miter' stroke-linecap='square'/>`
    + `</svg>`;
}

export const faviconHref = (bg: string, accent: string) => `data:image/svg+xml,${encodeURIComponent(faviconSvg(bg, accent))}`;
