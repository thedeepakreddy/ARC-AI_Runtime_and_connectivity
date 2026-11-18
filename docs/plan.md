# ARC — Implementation Plan

## Current state (audited at Phase 0 start)

The repository held only a README and LICENSE. There was no prior code to preserve.

## Phases

| #   | Phase               | Scope                                                                                                                                                  | Exit criteria                                         |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 0   | Foundation          | Monorepo, lint/typecheck/test, CI, Docker Compose, ADRs, threat model, health/readiness                                                                | Reproducible setup; baseline checks pass              |
| 1   | Control plane       | Schema/migrations, owner/admin auth, encrypted credential vault, provider registry with **unlimited keys per provider**, model catalogue + eligibility | Multiple keys per provider register and validate      |
| 2   | Fast-path inference | ARC key format/auth, `/v1/models`, `/v1/chat/completions` via LiteLLM, streaming + cancellation, `/v1/embeddings`, error model                         | Test app makes an end-to-end streamed request         |
| 3   | Intelligent routing | Eligibility gates (incl. jurisdiction), cached ranking + key selection, async health/quota workers, bounded fallback, route explanations               | Explainable routes; paid/unknown owner routes blocked |
| 4   | Operations          | Metrics (ARC overhead vs provider TTFT), load tests + regression gates, alerts, backup/restore, controlled deploy/rollback                             | Ops checks and restore drill pass                     |
| 5   | App integration     | Echo, Aira, Data Science Studio with separate ARC keys                                                                                                 | Each app passes smoke tests                           |
| 6   | Dashboards (UI)     | Design tokens, superadmin console, customer dashboard — **each screen layout approved before coding**                                                  | Approved screens implemented                          |
| 7   | Post-MVP            | Full customer auth, BYOK, provider packs, multimodal, BALANCED/DEEP, evaluation, billing, multi-server HA                                              | Separately approved increments                        |

Provider packs (see [providers.md](providers.md)) land after the core gateway works:
international, Chinese, local, speech/embeddings.

## Phase 0 status

- [x] pnpm monorepo: `apps/api`, `apps/worker`, `packages/shared`
- [x] TypeScript strict, ESLint, Prettier, Vitest; `pnpm check` runs all
- [x] Validated env config that never echoes values in errors
- [x] Log redaction for auth headers/secrets; correlation IDs (`x-request-id`)
- [x] `/healthz` (liveness) and `/readyz` (parallel, time-bounded dependency checks)
- [x] Docker Compose: Postgres, Redis, LiteLLM (separate DB), API, worker; private backend network
- [x] CI: build, format, lint, typecheck, test, compose validation
- [x] ADRs and threat model
- [ ] Full `docker compose up` verified on a machine with a Docker daemon (not available in the
      build container; compose files validated with `docker compose config`)

## Phase 1 status

- [x] Schema + migration runner (advisory-locked, idempotent): tenants, users, memberships,
      sessions, applications, providers, credentials, provider accounts, models, audit events
- [x] Envelope-encrypted credential vault with versioned key file, AAD binding and rotation CLI
- [x] Owner bootstrap CLI; email/password login, sessions, logout, login throttling
- [x] Provider catalogue: all providers from `providers.md` (incl. Chinese), with jurisdiction
      tags — **all marked unverified**
- [x] **Unlimited keys per provider**: add, list (hint only), rename, enable/disable, replace,
      delete, validate (health + model discovery)
- [x] Model catalogue: discovered models are `UNKNOWN` + disabled; classification requires an
      evidence URL; `UNKNOWN` can never be enabled (enforced in API and database)
- [x] Applications registry (first-party apps in the platform tenant only), audit log
- [x] Integration tests on real PostgreSQL incl. cross-tenant isolation; CI runs them
- [ ] Owner MFA, password reset, invitations/signup — deferred to customer auth (Phase 7)
- [ ] Login throttling in Redis — needed before running multiple API instances
- [ ] Background re-validation of keys — moves to the worker in Phase 3

## Approved decisions

1. **Name:** ARC = **AI Runtime & Connectivity** (approved). Trademark/domain check still outstanding.
2. **Model aliases:** `auto` (ARC picks the model) plus `arc/fast`, `arc/balanced`, `arc/deep` for
   execution modes; explicit model IDs allowed where policy permits (approved).
3. **Vault key source for the pilot:** versioned key file mounted from outside Postgres, with a
   separate off-site backup; move to a KMS later (approved).
4. **Pilot RTO/RPO:** RTO 4h, RPO 24h — targets only until a restore drill proves them (approved).

## Open decisions

1. **LiteLLM version:** pin a specific release/digest before production (currently `main-stable`).
