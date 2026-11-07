import { Icon } from './Icon';

/** Collapse/expand chevron that points the way the pane will move. */
export function CollapseButton({ collapsed, edge, label, onClick }: { collapsed: boolean; edge: 'left' | 'right' | 'bottom'; label: string; onClick: () => void }) {
  return (
    <button className={`icon-btn subtle collapse-btn to-${edge} ${collapsed ? 'is-collapsed' : ''}`} onClick={onClick}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`} title={`${collapsed ? 'Expand' : 'Collapse'} ${label}`} aria-expanded={!collapsed}>
      <Icon name="chevron" size={15} />
    </button>
  );
}
