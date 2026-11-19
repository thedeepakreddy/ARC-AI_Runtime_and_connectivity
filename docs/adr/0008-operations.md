# ADR 0008 — Operations: metrics, coordination, load tests, backups, deploys (Phase 4)

Status: Accepted · Phase 4

## Metrics and alerts

- Prometheus metrics on a separate port (API `9464`, worker `9465`), on the private network only.
- ARC overhead (`arc_overhead_ms`, arrival → first provider dispatch) is a separate histogram from
  provider time (`arc_provider_ttfb_ms`), end-to-end first chunk (`arc_first_chunk_ms`) and total
  duration. Requests, attempts and fallbacks are counted by provider, model, key (account), app,
  mode and outcome. Label values are registered ids, never request content.
- A background monitor (not the request path) publishes dependency health and worker heartbeat
  age. The worker publishes job durations, failures and last success.
- Alert rules (`infra/prometheus/alerts.yml`) with promtool unit tests: API down, dependency
  down, worker stalled, job failing, overhead p95 > 30 ms, fallback spike, error rate > 5 %,
  "no eligible route", provider rejected a key, telemetry dropping. Prometheus runs under the
  `monitoring` compose profile; an Alertmanager destination is still to be chosen.

## Multi-instance coordination (Redis)

- Key revocations, routing changes and cooldowns are broadcast over Redis pub/sub and applied to
  each instance's in-memory state: revocation is now immediate everywhere (was ≤ 30 s), with no
  Redis read on the request path. If Redis is down, instances keep working independently.
- The per-key rate limit is shared via one atomic `INCR`+`EXPIRE` per request with a 50 ms bound;
  on Redis trouble it falls back to the instance's local limiter instead of failing or waiting.
- Tested with two ARC instances sharing Postgres and Redis.

## Load testing and regression gate

`apps/api/bench/run.ts` starts the real built API, a real LiteLLM and two mock providers (separate
processes), and runs cold-cache, Echo-style streaming, DSS-style long non-streaming and degraded
(30 % failing primary key) scenarios. CI runs it with `--gate`: ARC overhead p95 ≤ 30 ms and error
rate ≤ 1 % in every scenario.

Local results (4 vCPU, everything on one machine, LiteLLM 1.110.0, simulated provider TTFT 40 ms
for streams and 300 ms for long requests):

| Scenario (concurrency 10) | Errors | Fallbacks | ARC overhead p50 / p95 / p99 ms |
| ------------------------- | ------ | --------- | ------------------------------- |
| cold (first requests)     | 0 %    | 0 %       | 4.3 / 20.9 (2 samples)          |
| echo-voice (300)          | 0 %    | 0 %       | 0.58 / 2.96 / 4.54              |
| dss-long (100)            | 0 %    | 0 %       | 0.58 / 1.61 / 2.36              |
| degraded (300)            | 0 %    | 1.3 %     | 0.57 / 1.46 / 1.92              |

In the degraded run the primary key failed 30 % of the time yet no request failed: fallback covered
the first failures and the cooldown then kept traffic on the healthy key.

**LiteLLM workers** (concurrency 20, Echo streaming):

| LiteLLM workers | Client TTFT p50 / p95 | Added by ARC + LiteLLM p50 |
| --------------- | --------------------- | -------------------------- |
| 1               | 259 / 307 ms          | 219 ms                     |
| 4               | 75 / 126 ms           | 35 ms                      |

A single LiteLLM worker queues under load; ARC overhead stayed ~0.6 ms either way. Compose now
defaults to `--num_workers 4` (`LITELLM_NUM_WORKERS`); size it to the server's cores and re-measure
on the real VPS. These are local measurements, not production guarantees.

## Backups, restore drill, controlled deploys

- `scripts/ops/backup.sh`: `pg_dump` (custom format) piped into GPG AES-256, checksum, optional
  off-site copy with rclone, local retention. The vault key file is backed up separately.
- `scripts/ops/restore-drill.sh`: backup → restore into a scratch database → verify schema version,
  per-table row counts, and that every credential decrypts with the vault key file → drop. Passes
  locally; fails (correctly) with the wrong vault key. CI runs it on every push.
- `scripts/ops/deploy.sh`: dry run by default (validate, build images for the exact commit from a
  clean worktree); `--approve` backs up, rolls out, health-checks `/readyz`, and rolls back to the
  previous images automatically on failure. Covered by stubbed tests in CI.
- Rollback cannot undo a migration, so migrations must be backward compatible (expand/contract).
