# ADR 0006 — Inference path (Phase 2)

Status: Accepted · Phase 2

## Decision

**Request path (no extra LLM call, no blocking work):**

1. Verify the ARC API key (`ARC_DEE_<id>_PAK_<secret>`): lookup by the non-secret id, compare
   SHA-256 of the secret in constant time. Valid keys are cached for 30 s; revocation clears the
   cache on the instance that revoked it immediately, other instances within 30 s.
2. Per-key rate limit (in memory, per instance).
3. Validate the body and **forward only allow-listed OpenAI fields**. Clients can never set
   `api_key`, `api_base`, `base_url` or other routing/credential fields.
4. Derive required capabilities from the request shape (stream, tools, images, audio, files,
   structured output) — cheap, deterministic.
5. Load the tenant's routable (model, key) pairs from a 5 s per-tenant cache (invalidated by
   admin changes) and select: policy gate → health → capability → stable preference order.
6. Decrypt the chosen provider key in memory (AES-GCM, microseconds) and dispatch to LiteLLM.
7. Stream the provider's bytes straight through; propagate client disconnects as upstream
   cancellation; bound everything by the request deadline (`x-arc-deadline-ms`, capped).

**Policy:** owner keys are free-only (`VERIFIED_FREE`, `RESTRICTED_FREE`); customer BYOK keys may
use `PAID`; `UNKNOWN` is never routable.

**LiteLLM passthrough** (verified against LiteLLM 1.110.0): a wildcard model route plus
`allow_client_side_credentials` lets ARC send the chosen key and base URL per request. Safe here
because LiteLLM is reachable only on the private network with its master key, and ARC forwards
only allow-listed fields. Verified: keys reach the provider, chunks are not buffered,
cancellation propagates to the provider, keys and message content do not appear in LiteLLM logs.

**Errors:** OpenAI-style envelope. Provider 401/403 → `502 provider_auth_failed` and the key is
marked `invalid_credentials` (routing skips it next time); provider 429 → `429` and the key is
marked `rate_limited` (ranked lower); timeouts → `504`. Provider keys are redacted from any
provider message that is passed back.

**Observability:** every response carries `x-arc-route-provider`, `x-arc-route-model`,
`x-arc-route-account`, `x-arc-route-alternatives`, `x-arc-mode` and `x-arc-overhead-ms` (ARC
ingress → provider dispatch). One metadata-only log line per request records route, timings
(overhead, time to first byte, first chunk, total) and token usage when available.

## Early measurements (not a claim; Phase 4 runs the real load tests)

Local, ARC → LiteLLM 1.110.0 (single worker) → mock provider, 400 requests each:

| Scenario      | ARC pre-provider overhead p50 / p95 / p99 | End-to-end p50 / p95 |
| ------------- | ----------------------------------------- | -------------------- |
| Sequential    | 0.39 / 0.56 / 1.14 ms                     | 16.8 / 22.1 ms       |
| 20 concurrent | 0.34 / 0.56 / 0.69 ms                     | 298 / 382 ms         |

ARC's own overhead is far inside the ≤ 30 ms p95 target. Under concurrency the single LiteLLM
worker is the bottleneck (~65 req/s); Phase 4 must size LiteLLM workers and measure again.

## Deferred

- Ranking by measured performance, bounded fallback across keys/models, jurisdiction policy,
  BALANCED/DEEP behaviour (aliases are accepted and currently behave as FAST) — Phase 3.
- Rate limits and key cache in Redis for multi-instance deployments — Phase 4.
