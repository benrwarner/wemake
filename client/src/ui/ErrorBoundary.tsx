import { Component, type ReactNode } from 'react';

/** Contain rendering errors (e.g. from malformed shared data) to one panel. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[${this.props.label}]`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        Something in {this.props.label} failed to display: {this.state.error.message}{' '}
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
