import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const FAST_MS = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 50, 100, 250, 1000];
const SLOW_MS = [25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000];

/**
 * Prometheus metrics. ARC overhead (ingress → provider dispatch) is measured separately from
 * provider time, segmented by provider, model, key (account), app, mode and endpoint.
 * Label values are bounded (ids of registered keys/models/apps), never request content.
 */
export class ArcMetrics {
  readonly registry = new Registry();

  readonly overheadMs = new Histogram({
    name: 'arc_overhead_ms',
    help: 'ARC pre-provider overhead: request arrival to first provider dispatch',
    labelNames: ['endpoint', 'mode', 'app'] as const,
    buckets: FAST_MS,
    registers: [this.registry],
  });

  readonly providerTtfbMs = new Histogram({
    name: 'arc_provider_ttfb_ms',
    help: 'Provider time to response headers per attempt (streams: time to first token)',
    labelNames: ['provider', 'model', 'account', 'stream'] as const,
    buckets: SLOW_MS,
    registers: [this.registry],
  });

  readonly firstChunkMs = new Histogram({
    name: 'arc_first_chunk_ms',
    help: 'End-to-end time to first streamed chunk, from request arrival',
    labelNames: ['provider', 'model', 'app'] as const,
    buckets: SLOW_MS,
    registers: [this.registry],
  });

  readonly totalMs = new Histogram({
    name: 'arc_request_duration_ms',
    help: 'End-to-end request duration',
    labelNames: ['endpoint', 'provider', 'model', 'app', 'outcome'] as const,
    buckets: SLOW_MS,
    registers: [this.registry],
  });

  readonly requests = new Counter({
    name: 'arc_requests_total',
    help: 'Inference requests by outcome',
    labelNames: ['endpoint', 'provider', 'model', 'account', 'app', 'mode', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly attempts = new Counter({
    name: 'arc_provider_attempts_total',
    help: 'Provider attempts by result (success, rate_limited, auth_failed, provider_error, timeout, client_error)',
    labelNames: ['provider', 'model', 'account', 'result'] as const,
    registers: [this.registry],
  });

  readonly fallbacks = new Counter({
    name: 'arc_fallbacks_total',
    help: 'Fallback steps taken, by the failure that triggered them',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly fallbackMs = new Histogram({
    name: 'arc_fallback_ms',
    help: 'Time spent on failed attempts before the serving attempt',
    buckets: SLOW_MS,
    registers: [this.registry],
  });

  readonly routingFailures = new Counter({
    name: 'arc_routing_failures_total',
    help: 'Requests ARC could not route (unknown_model, no_eligible_key, capability_missing)',
    labelNames: ['reason', 'app'] as const,
    registers: [this.registry],
  });

  readonly dependencyUp = new Gauge({
    name: 'arc_dependency_up',
    help: 'Whether a dependency passed its last background readiness check (1/0)',
    labelNames: ['name'] as const,
    registers: [this.registry],
  });

  readonly workerHeartbeatAgeSeconds = new Gauge({
    name: 'arc_worker_heartbeat_age_seconds',
    help: 'Seconds since any worker last reported a heartbeat (-1 if none ever)',
    registers: [this.registry],
  });

  readonly telemetryDropped = new Gauge({
    name: 'arc_telemetry_dropped_total',
    help: 'Outcome observations dropped because the buffer was full or the database failed',
    registers: [this.registry],
  });

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    if (opts.defaultMetrics) collectDefaultMetrics({ register: this.registry, prefix: 'arc_api_' });
  }
}

/** Serve a registry on its own port (internal network only; never on the public edge). */
export function startMetricsServer(
  registry: Registry,
  host: string,
  port: number,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      })
      .catch(() => res.writeHead(500).end());
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
