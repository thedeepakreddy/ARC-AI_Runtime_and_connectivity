import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';

/** Load data from the admin API; `reload` re-fetches. Keeps old data while reloading. */
export function useData<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as Error);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Re-run a loader every `ms` while the tab is visible. */
export function usePolling(fn: () => void, ms: number) {
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}
