# ADR 0003 — Latency-first routing

Status: Accepted · Phase 0 (implemented in Phases 2–3)

## Decision

- **Fast path is the default** (FAST mode): deterministic eligibility gates, then a pick from
  cached/precomputed rankings. No extra LLM call to choose a model.
- Discovery, benchmarking, quota sync, health polling and ranking run in the **worker**, never on
  the request path. Optional lookups use strict timeouts and never block a request.
- Stream provider output immediately; propagate client cancellation upstream.
- Retries and fallback are bounded by the request deadline; prefer a healthy alternative over
  serial retries.
- BALANCED and DEEP modes are opt-in or policy-driven, with explicit budgets and stop conditions.
- Initial overhead targets (p95): routing ≤ 10 ms, auth + policy ≤ 10 ms, total pre-provider
  ≤ 30 ms. These are **targets**, not claims, until load tests prove them.
