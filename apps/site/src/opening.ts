// Whether the opening plays: once per visit, never with reduced motion, and not when coming
// back to the page (Back/Forward, or a return from the sign-in) with the scroll restored.
const KEY = 'arc:opening-seen';

export function playOpening(): boolean {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
  } catch {
    // Storage blocked: fall through.
  }
  const nav = performance.getEntriesByType?.('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  return nav?.type !== 'back_forward';
}

export function markOpeningSeen(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // Storage blocked: the opening may play again next time; harmless.
  }
}
