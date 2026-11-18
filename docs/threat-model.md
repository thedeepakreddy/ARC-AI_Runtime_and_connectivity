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

| Threat                                        | Mitigation                                                                                                                   | Phase   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| Provider keys leaked from the database        | Envelope encryption; key material outside Postgres; only the credential service decrypts                                     | 1       |
| ARC API key theft or guessing                 | ≥256-bit random keys, shown once, stored hashed, scoped, revocable, last-used tracking                                       | 2       |
| Secrets or prompts in logs                    | Metadata-only logging; redaction of auth headers/secret fields; LiteLLM message logging off; config errors never echo values | 0 ✔     |
| Cross-tenant access                           | Tenant scoping in every query; automated cross-tenant tests                                                                  | 1       |
| Owner's private keys used by customers        | Owner-scoped accounts only eligible for owner first-party apps; enforced as an eligibility gate                              | 3       |
| Silent paid usage                             | Free-only owner policy; unknown = blocked; policy rechecked at every fallback step; paid fallback needs admin approval       | 3       |
| Exposed backing services                      | Internal `backend` network; dev ports bound to 127.0.0.1 only via an override file                                           | 0 ✔     |
| Abuse / resource exhaustion                   | Per-key rate limits, request size limits, admin suspension                                                                   | 2       |
| Hanging dependencies stall the service        | Readiness checks run in parallel with strict timeouts; request deadlines bound retries                                       | 0 ✔ / 2 |
| Header injection via correlation IDs          | Inbound `x-request-id` accepted only if it matches a safe pattern, else replaced                                             | 0 ✔     |
| Supply chain (images, packages)               | Lockfile with `--frozen-lockfile` in CI; pin LiteLLM image digest before production                                          | 0 / 4   |
| Data sent to providers in other jurisdictions | Jurisdiction tags and per-app/tenant allow/deny policy                                                                       | 3       |
| Losing key material = losing credentials      | Separate, encrypted, off-site backup of key material; restore drills                                                         | 4       |
