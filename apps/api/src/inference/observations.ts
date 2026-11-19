import type { Db } from '../db/pool.js';

export type Outcome = 'success' | 'rate_limited' | 'error' | 'timeout';

interface Totals {
  requests: number;
  successes: number;
  rateLimited: number;
  errors: number;
  timeouts: number;
  ttfbMsSum: number;
  ttfbSamples: number;
}

/**
 * Collects per-(key, model) outcomes in memory and writes them in one batched upsert every few
 * seconds. record() never awaits I/O, so telemetry cannot slow or block a request. If the
 * database is slow or down, the buffer is bounded and the oldest entries are dropped.
 */
export class ObservationRecorder {
  private buffer = new Map<string, Totals>();
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

  record(accountId: string, modelUuid: string, outcome: Outcome, ttfbMs?: number): void {
    const bucket = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const key = `${accountId}|${modelUuid}|${bucket}`;
    let t = this.buffer.get(key);
    if (!t) {
      if (this.buffer.size >= this.maxKeys) {
        this.dropped++;
        return;
      }
      t = {
        requests: 0,
        successes: 0,
        rateLimited: 0,
        errors: 0,
        timeouts: 0,
        ttfbMsSum: 0,
        ttfbSamples: 0,
      };
      this.buffer.set(key, t);
    }
    t.requests++;
    if (outcome === 'success') t.successes++;
    else if (outcome === 'rate_limited') t.rateLimited++;
    else if (outcome === 'timeout') t.timeouts++;
    else t.errors++;
    if (outcome === 'success' && ttfbMs !== undefined) {
      t.ttfbMsSum += ttfbMs;
      t.ttfbSamples++;
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.size === 0) return Promise.resolve();
    const batch = this.buffer;
    this.buffer = new Map();
    this.flushing = this.write(batch)
      .catch(() => {
        this.dropped += batch.size; // telemetry is best-effort; never retried on the hot path
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async write(batch: Map<string, Totals>): Promise<void> {
    const cols: unknown[][] = [[], [], [], [], [], [], [], [], [], []];
    for (const [key, t] of batch) {
      const [account, model, bucket] = key.split('|');
      const row = [
        account,
        model,
        bucket,
        t.requests,
        t.successes,
        t.rateLimited,
        t.errors,
        t.timeouts,
        t.ttfbMsSum,
        t.ttfbSamples,
      ];
      row.forEach((v, i) => cols[i]!.push(v));
    }
    await this.db.query(
      `INSERT INTO route_observations AS o
         (account_id, model_id, bucket, requests, successes, rate_limited, errors, timeouts, ttfb_ms_sum, ttfb_samples)
       SELECT u.* FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[], $4::int[], $5::int[], $6::int[],
                              $7::int[], $8::int[], $9::float8[], $10::int[])
              AS u(account_id, model_id, bucket, requests, successes, rate_limited, errors, timeouts, ttfb_ms_sum, ttfb_samples)
       -- Skip keys/models deleted since the request, instead of failing the whole batch.
       JOIN provider_accounts a ON a.id = u.account_id
       JOIN models m ON m.id = u.model_id
       ON CONFLICT (account_id, model_id, bucket) DO UPDATE SET
         requests = o.requests + EXCLUDED.requests, successes = o.successes + EXCLUDED.successes,
         rate_limited = o.rate_limited + EXCLUDED.rate_limited, errors = o.errors + EXCLUDED.errors,
         timeouts = o.timeouts + EXCLUDED.timeouts, ttfb_ms_sum = o.ttfb_ms_sum + EXCLUDED.ttfb_ms_sum,
         ttfb_samples = o.ttfb_samples + EXCLUDED.ttfb_samples`,
      cols,
    );
  }
}
