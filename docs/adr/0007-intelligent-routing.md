# ADR 0007 — Intelligent routing without a latency penalty (Phase 3)

Status: Accepted · Phase 3

## Decision

**Ranking is precomputed; the request path only reads it.**

- The API records each attempt's outcome (success, rate limited, error, timeout, time to
  response headers) into an in-memory buffer. `record()` does no I/O; a batched upsert every 5 s
  writes per-minute counters to `route_observations`. If Postgres is slow or down the buffer is
  bounded and telemetry is dropped, never the request.
- The **worker** (separate process) turns the last 30 minutes of observations into
  `route_scores` every 15 s, with a 10-minute half-life so recent behaviour counts most. The
  score is the expected time to a successful response: `avg_latency / success_rate +
(1 − success_rate) × 2 s`, with priors (95 % success, 1.5 s) so new or rarely used keys stay
  competitive and a few samples cannot dominate.
- The API reads scores with the candidate cache (5 s), under `lock_timeout 50 ms` and
  `statement_timeout 100 ms`. If the worker holds the table, routing continues with neutral
  scores (tested by locking the table during a request).

**Order of decisions per request (microseconds, no I/O on a warm cache):**

1. Deterministic gates: model match → eligibility policy → jurisdiction policy → key health →
   cooldown → capabilities.
2. Rank: health bucket → free before paid (an admin-defined bound) → expected latency → id.
3. Fallback plan: the same model on its other keys first, then other compatible models — only
   for `auto`/`arc/*`. An explicit `<provider>/<model>` never silently switches model.

**Bounded fallback:** up to `MAX_ATTEMPTS` (3) attempts, each bounded by the remaining request
deadline; no new attempt with less than `MIN_ATTEMPT_MS` (250 ms) left. Fallback happens only on
failures another key could fix (401/403, 429, 408/5xx, timeouts) and only before any byte reached
the client. A provider 4xx about the request itself is returned at once. If the LiteLLM gateway
itself is down, ARC fails fast (every route goes through it). Policy is re-checked at each step.

**LiteLLM retries are disabled** (`num_retries: 0` on every call). Verified on LiteLLM 1.110.0:
by default a provider 429 caused 3 provider calls and ~4.3 s of backoff; with retries off it is
one call in ~30 ms. ARC owns retries so that a rate-limited key is not hit again and the deadline
holds.

**Cooldowns** (in memory, per instance): a 429 cools the key for `Retry-After` (default 30 s,
max 300 s); an auth failure for 10 min (and marks it `invalid_credentials`); three transient
failures in a row for 30 s. A cooling key gets no traffic. Other legitimately registered keys may
serve meanwhile; this respects each key's limit rather than evading it.

**Policies** (`routing_policies`, per tenant with optional per-app override): allowed
jurisdictions (e.g. keep Echo on `US`/`EU`/`SELF_HOSTED`, exclude `CN`), and
`allowPaidOwnerKeys` — settable only by the platform owner (blueprint: no paid use of owner keys
without explicit approval).

**Explainability:** `POST /admin/v1/routing/explain` returns the decision for every candidate
(selected / eligible / rejected with reason) plus the fallback order — a dry run, no provider
call. Apps can send `x-arc-explain: true` to receive a compact explanation header. Every
response carries `x-arc-route-attempts`; fallbacks add `x-arc-fallback` (reasons) and
`x-arc-fallback-ms`.

**Background health checks:** the worker re-validates enabled keys whose health is older than
15 minutes (keys with failed authentication every 6 hours), 4 at a time with probe timeouts,
discovering models as it goes. Customer base URLs get the same SSRF check as in the admin API.
Jobs use Postgres advisory locks so several workers never duplicate work.

## Notes and limits

- Latency samples are time to response headers: for streams that is time to first token; for
  non-streaming calls it includes generation time. Good enough to compare keys serving the same
  model; Phase 4 may separate the two.
- Cooldowns and rate limits are per API instance until moved to Redis (Phase 4).
- BALANCED and DEEP modes still behave as FAST; multi-model collaboration is a later phase.

## Bug found while building

Fastify's `reply.elapsedTime` returns 0 when the request logger is disabled, so the first
version recorded every latency as 0 ms in tests. ARC now uses its own `performance.now()` timer
started on request arrival; a test asserts a deliberately slow key is measured as slow.
