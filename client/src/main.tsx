import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, restoreImage } from './theme/theme';
import './styles.css';

applyTheme(); // before first paint, so there's no flash of the default colours
void restoreImage();

createRoot(document.getElementById('root')!).render(<App />);
