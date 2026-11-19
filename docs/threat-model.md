# ARC — Threat Model (Phase 0 baseline)

Revisit at the start of every phase.

## Assets

1. Provider API keys (owner-managed and customer BYOK) — highest value.
2. ARC API keys issued to applications.
3. Envelope-encryption key material.
4. Tenant data: apps, usage metadata, routing policy.
5. Prompt/response content in transit (never stored by default).

## Trust boundaries

Client apps → ARC API (internet, TLS) → LiteLLM (private network) → providers (internet, TLS).
Postgres and Redis sit on an internal Docker network and are not exposed publicly.

## Threats and mitigations

| Threat                                                        | Mitigation                                                                                                                                     | Phase   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Provider keys leaked from the database                        | Envelope encryption; key material outside Postgres; only the credential service decrypts                                                       | 1       |
| ARC API key theft or guessing                                 | ≥256-bit random keys, shown once, stored hashed, scoped, revocable, last-used tracking                                                         | 2       |
| Secrets or prompts in logs                                    | Metadata-only logging; redaction of auth headers/secret fields; LiteLLM message logging off; config errors never echo values                   | 0 ✔     |
| Cross-tenant access                                           | Tenant scoping in every query; automated cross-tenant tests                                                                                    | 1       |
| Owner's private keys used by customers                        | Owner-scoped accounts only eligible for owner first-party apps; enforced as an eligibility gate                                                | 3       |
| Silent paid usage                                             | Free-only owner policy; unknown = blocked; policy rechecked at every fallback step; paid fallback needs admin approval                         | 3       |
| Exposed backing services                                      | Internal `backend` network; dev ports bound to 127.0.0.1 only via an override file                                                             | 0 ✔     |
| Abuse / resource exhaustion                                   | Per-key rate limits, request size limits, admin suspension                                                                                     | 2       |
| Hanging dependencies stall the service                        | Readiness checks run in parallel with strict timeouts; request deadlines bound retries                                                         | 0 ✔ / 2 |
| Header injection via correlation IDs                          | Inbound `x-request-id` accepted only if it matches a safe pattern, else replaced                                                               | 0 ✔     |
| Supply chain (images, packages)                               | Lockfile with `--frozen-lockfile` in CI; pin LiteLLM image digest before production                                                            | 0 / 4   |
| Data sent to providers in other jurisdictions                 | Jurisdiction tags and per-app/tenant allow/deny policy                                                                                         | 3       |
| Losing key material = losing credentials                      | Separate, encrypted, off-site backup of key material; restore drills                                                                           | 4       |
| SSRF via customer-supplied provider base URLs                 | Customer URLs must be HTTPS and resolve only to public addresses; re-checked before each probe. Residual: DNS rebinding until egress is pinned | 1 ✔ / 4 |
| Apps injecting credentials/base URLs via request bodies       | Only allow-listed OpenAI fields are forwarded; ARC sets model, key and base URL itself                                                         | 2 ✔     |
| LiteLLM client-side credentials abused                        | LiteLLM only on the private network behind its master key; ARC is its only caller                                                              | 2 ✔     |
| Stolen ARC key used after revocation                          | Immediate on the revoking instance; ≤30 s on others (cache TTL)                                                                                | 2 ✔ / 4 |
| Provider keys echoed in provider error messages               | Known key value redacted from any upstream message returned to the client                                                                      | 2 ✔     |
| Data routed to a disallowed jurisdiction (incl. via fallback) | Jurisdiction gate in every ranking and re-checked at each fallback step; tested                                                                | 3 ✔     |
| Silent paid fallback on owner keys                            | Paid owner use needs `allowPaidOwnerKeys`, settable only by the platform owner; audited                                                        | 3 ✔     |
| Hammering a rate-limited provider key                         | LiteLLM retries disabled; cooldown honours Retry-After; no fallback past the deadline                                                          | 3 ✔     |
| Worker SSRF via customer base URLs                            | Same public-HTTPS guard before every background probe                                                                                          | 3 ✔     |
| Background jobs degrading inference                           | Separate process; API reads scores with 50 ms lock / 100 ms statement timeouts; telemetry buffered and droppable                               | 3 ✔     |
