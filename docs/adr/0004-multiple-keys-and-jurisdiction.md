# ADR 0004 — Multiple keys per provider and jurisdiction tags

Status: Accepted · Phase 0 (implemented in Phases 1 and 3)

## Decision

- Every user/tenant may register **any number of API keys per provider**. Each key has a label,
  owner scope, encrypted secret, enabled state, supported models and its own health, latency and
  rate-limit history.
- Routing selects the best healthy eligible key; it is **not round-robin**. A rate-limited key
  enters a cooldown. ARC does not spray requests across keys to defeat a provider's limits; the
  key owner is responsible for the provider's terms.
- Every provider carries a **jurisdiction tag** (e.g. `US`, `EU`, `CN`). Apps and tenants can
  allow or exclude jurisdictions as an eligibility gate.
- Model eligibility classes: `VERIFIED_FREE`, `RESTRICTED_FREE`, `PAID`, `UNKNOWN`, with
  evidence and last-checked date. Unknown is blocked; one-time credits are not `VERIFIED_FREE`.

Candidate providers are listed in [../providers.md](../providers.md).
