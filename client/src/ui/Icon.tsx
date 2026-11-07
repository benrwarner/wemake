// One consistent stroke icon set (24px grid, currentColor) so the interface
// looks the same on every OS instead of depending on emoji fonts.

const P: Record<string, string> = {
  play: 'M7 5.5v13a.6.6 0 0 0 .9.5l10.4-6.5a.6.6 0 0 0 0-1L7.9 5a.6.6 0 0 0-.9.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  record: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  start: 'M6 5v14M18 6v12l-9-6z',
  loop: 'M17 2.5l3 3-3 3M4 11.5v-1a5 5 0 0 1 5-5h11M7 21.5l-3-3 3-3M20 12.5v1a5 5 0 0 1-5 5H4',
  metronome: 'M9.5 3h5l4 18h-13zM12 15l5-8M7.6 15h8.8',
  countin: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 1.5M10 2h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  download: 'M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2.2-1.8 3.5-3.6 3.5h-2a1.9 1.9 0 0 0-1.4 3.2 1.4 1.4 0 0 1-1 2.3zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01M17 11h.01',
  mic: 'M12 2.5a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3zM19 10.5v1a7 7 0 0 1-14 0v-1M12 18.5V22M8.5 22h7',
  keys: 'M3 5h18v14H3zM8 5v8M13 5v8M18 5v8M6.5 13h3M11.5 13h3M16.5 13h3M8 13v6M13 13v6M18 13v6',
  drums: 'M12 9c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM3 6v11c0 1.66 4.03 3 9 3s9-1.34 9-3V6M7 13.5V20M17 13.5V20M12 14.5V21',
  synth: 'M2 12h3l2.5-7 4 14 3.5-10 2 3h5',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5l-4.6-4.6',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M6 9l6 6 6-6',
  lock: 'M5.5 11h13v10h-13zM8 11V7.5a4 4 0 0 1 8 0V11',
  link: 'M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.3l-1.7 1.7M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.3l1.7-1.7',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  power: 'M12 3v8M18.4 6.6a8 8 0 1 1-12.8 0',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  capture: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4',
  headphones: 'M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  refresh: 'M3.5 12a8.5 8.5 0 0 1 14.6-5.9L21 9M21 3.5V9h-5.5M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3 15M3 20.5V15h5.5',
  image: 'M3.5 3.5h17v17h-17zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20.5 15l-5-5-11 11',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4M15 9l-12 12',
  keyboard: 'M2.5 6h19v12h-19zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  chat: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3a8.5 8.5 0 0 1 8.5 8.5z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  panel: 'M3.5 4h17v16h-17zM15 4v16',
  panelLeft: 'M3.5 4h17v16h-17zM9 4v16',
  panelBottom: 'M3.5 4h17v16h-17zM3.5 14h17',
  panelOff: 'M3.5 4h17v16h-17zM7 8l10 8',
  layout: 'M3.5 3.5h17v17h-17zM3.5 9h17M10 9v11.5M10 15h10.5',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  piano: 'M3 4h18v16H3zM7.5 4v9M12 4v9M16.5 4v9',
  mixer: 'M6 3v18M12 3v18M18 3v18M3.5 15h5M9.5 8h5M15.5 12h5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  upload: 'M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-4M12 8h.01',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
};

const FILLED = new Set(['play', 'stop', 'record']);

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className = '', title }: { name: IconName; size?: number; className?: string; title?: string }) {
  const fill = FILLED.has(name);
  return (
    <svg
      className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={fill ? 0 : 1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={P[name]} />
    </svg>
  );
}

/** Icon for a track's instrument type. */
export function trackIcon(kind: 'audio' | 'instrument', type?: string): IconName {
  if (kind === 'audio') return 'mic';
  return type === 'drums' ? 'drums' : type === 'epiano' ? 'keys' : 'synth';
}
