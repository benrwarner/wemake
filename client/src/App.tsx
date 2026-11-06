import { useEffect, useState } from 'react';
import { Studio } from './state/studio';
import { StudioContext } from './ui/hooks';
import { Lobby } from './ui/Lobby';
import { StudioView } from './ui/StudioView';

export function App() {
  const [studio, setStudio] = useState<Studio | null>(null);
  useEffect(() => () => studio?.dispose(), [studio]);
  if (!studio) {
    return <Lobby onJoin={(room, name, color) => {
      history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
      const st = new Studio(room, name, color);
      if (import.meta.env.DEV) (window as unknown as { wemake: Studio }).wemake = st; // debugging handle
      setStudio(st);
    }} />;
  }
  return <StudioContext.Provider value={studio}><StudioView /></StudioContext.Provider>;
}
