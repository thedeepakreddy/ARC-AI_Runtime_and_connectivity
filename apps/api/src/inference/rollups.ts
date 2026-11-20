import type { Db } from '../db/pool.js';

export interface RequestRecord {
  tenantId: string;
  applicationId: string;
  endpoint: string;
  providerId: string;
  modelName: string;
  accountId: string;
  error: boolean;
  fallback: boolean;
  overheadMs: number | null;
  durationMs: number;
}

interface Totals {
  requests: number;
  errors: number;
  fallbacks: number;
  overheadMsSum: number;
  overheadN: number;
  durationMsSum: number;
}

/**
 * Per-app traffic for the console and dashboards: one row per minute, app, route and endpoint.
 * Like ObservationRecorder, record() never awaits I/O and writes are batched and best-effort, so
 * this can never slow or fail a request.
 */
export class RollupRecorder {
  private buffer = new Map<string, { r: RequestRecord; t: Totals; bucket: string }>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | null = null;
  dropped = 0;

  constructor(
    private readonly db: Db,
    private readonly intervalMs = 5000,
    private readonly maxKeys = 20_000,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  record(r: RequestRecord): void {
    const bucket = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const key = [bucket, r.applicationId, r.endpoint, r.providerId, r.modelName, r.accountId].join(
      '|',
    );
    let e = this.buffer.get(key);
    if (!e) {
      if (this.buffer.size >= this.maxKeys) {
        this.dropped++;
        return;
      }
      e = {
        r,
        bucket,
        t: {
          requests: 0,
          errors: 0,
          fallbacks: 0,
          overheadMsSum: 0,
          overheadN: 0,
          durationMsSum: 0,
        },
      };
      this.buffer.set(key, e);
    }
    const t = e.t;
    t.requests++;
    if (r.error) t.errors++;
    if (r.fallback) t.fallbacks++;
    if (r.overheadMs !== null) {
      t.overheadMsSum += r.overheadMs;
      t.overheadN++;
    }
    t.durationMsSum += r.durationMs;
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.size === 0) return Promise.resolve();
    const batch = this.buffer;
    this.buffer = new Map();
    this.flushing = this.write([...batch.values()])
      .catch(() => {
        this.dropped += batch.size;
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async write(rows: { r: RequestRecord; t: Totals; bucket: string }[]): Promise<void> {
    const cols: unknown[][] = Array.from({ length: 13 }, () => []);
    for (const { r, t, bucket } of rows) {
      [
        bucket,
        r.tenantId,
        r.applicationId,
        r.endpoint,
        r.providerId,
        r.modelName,
        r.accountId,
        t.requests,
        t.errors,
        t.fallbacks,
        t.overheadMsSum,
        t.overheadN,
        t.durationMsSum,
      ].forEach((v, i) => cols[i]!.push(v));
    }
    await this.db.query(
      `INSERT INTO request_rollups AS o
         (bucket, tenant_id, application_id, endpoint, provider_id, model_name, account_id,
          requests, errors, fallbacks, overhead_ms_sum, overhead_n, duration_ms_sum)
       SELECT u.* FROM unnest($1::timestamptz[], $2::uuid[], $3::uuid[], $4::text[], $5::text[],
                              $6::text[], $7::text[], $8::int[], $9::int[], $10::int[],
                              $11::float8[], $12::int[], $13::float8[])
              AS u(bucket, tenant_id, application_id, endpoint, provider_id, model_name, account_id,
                   requests, errors, fallbacks, overhead_ms_sum, overhead_n, duration_ms_sum)
       -- Skip apps deleted since the request, instead of failing the whole batch.
       JOIN applications a ON a.id = u.application_id
       ON CONFLICT (bucket, application_id, endpoint, provider_id, model_name, account_id) DO UPDATE SET
         requests = o.requests + EXCLUDED.requests, errors = o.errors + EXCLUDED.errors,
         fallbacks = o.fallbacks + EXCLUDED.fallbacks,
         overhead_ms_sum = o.overhead_ms_sum + EXCLUDED.overhead_ms_sum,
         overhead_n = o.overhead_n + EXCLUDED.overhead_n,
         duration_ms_sum = o.duration_ms_sum + EXCLUDED.duration_ms_sum`,
      cols,
    );
  }
}
