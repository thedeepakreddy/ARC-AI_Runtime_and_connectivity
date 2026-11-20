import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './ui';
// Self-hosted type (bundled with the console, no third-party requests; all SIL Open Font License):
// Michroma — extended aerospace display face for titles and the wordmark;
// Hubot Sans — technical grotesk, set expanded for labels, navigation and controls;
// Mona Sans — its companion, for reading text; Martian Mono — wide technical mono for figures.
import '@fontsource/michroma/latin-400.css';
import '@fontsource-variable/hubot-sans/wdth.css';
import '@fontsource-variable/mona-sans/wght.css';
import '@fontsource-variable/martian-mono/wdth.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/console">
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
