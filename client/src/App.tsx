import { useEffect, useState } from 'react';
import { Studio } from './state/studio';
import { StudioContext } from './ui/hooks';
import { Lobby } from './ui/Lobby';
import { StudioView } from './ui/StudioView';
import { Backdrop } from './ui/Backdrop';

export function App() {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    if (!studio) return;
    // wrong/missing password: back to the lobby with the reason
    const off = studio.session.on('auth-error', (err) => { setAuthError(err); setStudio(null); });
    return () => { off(); studio.dispose(); };
  }, [studio]);
  if (!studio) {
    return <><Backdrop /><Lobby error={authError} onJoin={(room, name, color, password) => {
      setAuthError('');
      history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
      let st: Studio;
      try {
        st = new Studio(room, name, color, password);
      } catch (err) {
        console.error('Could not start the studio', err);
        setAuthError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (import.meta.env.DEV) (window as unknown as { wemake: Studio }).wemake = st; // debugging handle
      setStudio(st);
    }} /></>;
  }
  return <><Backdrop /><StudioContext.Provider value={studio}><StudioView /></StudioContext.Provider></>;
}
