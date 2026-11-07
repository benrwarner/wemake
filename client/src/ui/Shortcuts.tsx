import { useEffect } from 'react';
import { Icon } from './Icon';

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const GROUPS: [string, [string[], string][]][] = [
  ['Transport', [
    [['Space'], 'Play or stop'],
    [['Shift', 'R'], 'Record'],
    [['Enter'], 'Stop (press again to go to the start)'],
    [['Esc'], 'Stop all stuck notes'],
  ]],
  ['Editing', [
    [[mod, 'Z'], 'Undo your last change'],
    [[mod, 'Shift', 'Z'], 'Redo'],
    [['Drag'], 'Move around the timeline (on empty space)'],
    [['Right-drag'], 'Draw a box to select clips'],
    [['Shift', 'click'], 'Add or remove a clip from the selection'],
    [[mod, 'A'], 'Select every clip'],
    [[mod, 'D'], 'Repeat the selected clips'],
    [['Delete'], 'Delete the selected clips or notes'],
    [['Alt', 'drag'], 'Duplicate clips, or move without snapping'],
    [[mod, 'scroll'], 'Zoom the timeline'],
  ]],
  ['Playing notes', [
    [['A', '…', 'K'], 'Play notes on the selected instrument'],
    [['Z', '/', 'X'], 'Octave down or up'],
    [['C', '/', 'V'], 'Softer or harder'],
  ]],
  ['Piano roll', [
    [['Click'], 'Add a note (drag right to set its length)'],
    [['Right-click'], 'Delete a note'],
    [['Right-drag'], 'Draw a box to select notes'],
    [['Middle-drag'], 'Move around the piano roll'],
    [[mod, 'A'], 'Select all notes'],
  ]],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header>
          <h2>Keyboard shortcuts</h2>
          <button className="icon-btn" autoFocus onClick={onClose} aria-label="Close shortcuts"><Icon name="x" /></button>
        </header>
        <div className="shortcut-groups">
          {GROUPS.map(([title, rows]) => (
            <section key={title}>
              <h4>{title}</h4>
              <dl>
                {rows.map(([keys, what]) => (
                  <div key={what} className="sc-row">
                    <dt>{keys.map((k, i) => (k === '/' || k === '…' ? <span key={i} className="muted">{k}</span> : <kbd key={i}>{k}</kbd>))}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="muted small">Press <kbd>?</kbd> any time to open this list.</p>
      </div>
    </div>
  );
}
