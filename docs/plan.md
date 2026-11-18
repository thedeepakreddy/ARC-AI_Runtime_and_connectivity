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

## Decisions needing owner approval

1. **Name:** ARC = "AI Runtime & Connectivity" (the addendum overrides "Adaptive Reasoning Core").
   Trademark/domain check still outstanding.
2. **Model alias:** propose `auto` (ARC picks the model) plus `arc/fast`, `arc/balanced`,
   `arc/deep` for execution modes; explicit model IDs allowed where policy permits.
3. **LiteLLM version:** pin a specific release/digest before production (currently `main-stable`).
4. **Envelope encryption key source for the pilot:** propose a key file mounted from outside
   Postgres with documented off-site backup; move to a KMS when available.
5. **Proposed RTO/RPO for the pilot:** RTO 4h, RPO 24h (daily encrypted off-site backups) —
   targets only until a restore drill proves them.
