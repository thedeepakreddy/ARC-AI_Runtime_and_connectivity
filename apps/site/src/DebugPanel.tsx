import { useEffect, useState } from 'react';
import { noteError, skyDebug } from './debug';

/** The ?debug=1 panel: what the sky is doing on this device, to read off a screenshot. */
export function DebugPanel() {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!skyDebug.on) return;
    const onErr = (e: ErrorEvent) => noteError('error', e.error ?? e.message);
    const onRej = (e: PromiseRejectionEvent) => noteError('promise', e.reason);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => {
      clearInterval(t);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);
  if (!skyDebug.on) return null;
  const d = skyDebug;
  const lines = [
    `tier ${d.tier || '(sky not started)'} · max texture ${d.maxTexture}`,
    `gpu ${d.gpu}`,
    `frames ${d.frames} · context lost ${d.contextLost}`,
    `loaded ${d.loaded.length}: ${d.loaded.join(', ')}`,
    `failed ${d.failed.length}: ${d.failed.join(', ')}`,
    ...d.errors.map((e) => `! ${e}`),
  ];
  return <pre className="debug-panel">{lines.join('\n')}</pre>;
}
