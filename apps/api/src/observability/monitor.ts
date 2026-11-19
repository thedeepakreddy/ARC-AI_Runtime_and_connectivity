import type { Db } from '../db/pool.js';
import { type DependencyCheck, checkReadiness } from '../readiness.js';
import type { ArcMetrics } from './metrics.js';

/**
 * Background health sampling for metrics/alerts: dependency reachability and worker heartbeat
 * age. Runs on a timer, never on the request path, with the same strict timeouts as /readyz.
 */
export function startHealthMonitor(opts: {
  db: Db;
  checks: readonly DependencyCheck[];
  metrics: ArcMetrics;
  timeoutMs: number;
  intervalMs?: number;
  telemetryDropped?: () => number;
}): () => void {
  const run = async () => {
    const report = await checkReadiness(opts.checks, opts.timeoutMs);
    for (const d of report.dependencies)
      opts.metrics.dependencyUp.set({ name: d.name }, d.status === 'up' ? 1 : 0);
    try {
      const { rows } = await opts.db.query<{ age: number | null }>(
        'SELECT extract(epoch FROM now() - max(last_seen))::float8 AS age FROM worker_heartbeats',
      );
      opts.metrics.workerHeartbeatAgeSeconds.set(rows[0]?.age ?? -1);
    } catch {
      /* database down: dependencyUp already reports it */
    }
    if (opts.telemetryDropped) opts.metrics.telemetryDropped.set(opts.telemetryDropped());
  };
  void run();
  const timer = setInterval(() => void run(), opts.intervalMs ?? 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
