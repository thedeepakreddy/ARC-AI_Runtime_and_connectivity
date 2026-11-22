import '@arc/ui/fonts';
import './site.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { playOpening } from './opening';
import { Site } from './Site';

// The opening covers the page from the first frame (not after React's first render).
if (playOpening()) document.documentElement.classList.add('intro-on');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
