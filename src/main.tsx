import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {testLog} from './testlog';
import {ErrorBoundary} from './ui/Crash';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

testLog('start', {build: __APP_BUILD__, browser: navigator.userAgent, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, installed: matchMedia('(display-mode: standalone)').matches});

// Installable, offline-capable app (production builds only; dev uses Vite's server).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
