import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './ui';
// Self-hosted type (bundled with the console, no third-party requests; all SIL Open Font License):
// Hubot Sans — technical grotesk for controls and labels;
// Mona Sans — wide, bold large titles and figures, and reading text; Martian Mono — wide technical mono for figures.
import '@fontsource-variable/hubot-sans/wdth.css';
import '@fontsource-variable/mona-sans/wdth.css';
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
