# ARC — Implementation Plan

## Current state (audited at Phase 0 start)

The repository held only a README and LICENSE. There was no prior code to preserve.

## Phases

| #   | Phase                  | Scope                                                                                                                                                                              | Exit criteria                                                                 |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0   | Foundation             | Monorepo, lint/typecheck/test, CI, Docker Compose, ADRs, threat model, health/readiness                                                                                            | Reproducible setup; baseline checks pass                                      |
| 1   | Control plane          | Schema/migrations, owner/admin auth, encrypted credential vault, provider registry with **unlimited keys per provider**, model catalogue + eligibility                             | Multiple keys per provider register and validate                              |
| 2   | Fast-path inference    | ARC key format/auth, `/v1/models`, `/v1/chat/completions` via LiteLLM, streaming + cancellation, `/v1/embeddings`, error model                                                     | Test app makes an end-to-end streamed request                                 |
| 3   | Intelligent routing    | Eligibility gates (incl. jurisdiction), cached ranking + key selection, async health/quota workers, bounded fallback, route explanations                                           | Explainable routes; paid/unknown owner routes blocked                         |
| 4   | Operations             | Metrics (ARC overhead vs provider TTFT), load tests + regression gates, alerts, backup/restore, controlled deploy/rollback                                                         | Ops checks and restore drill pass                                             |
| 5   | App integration        | Echo, Aira, Data Science Studio with separate ARC keys                                                                                                                             | Each app passes smoke tests                                                   |
| 6   | Dashboards (UI) + BYOK | Design tokens, superadmin console, customer dashboard — **each screen layout approved before coding**; customer sign-up/login; **users bring their own provider keys** through ARC | Approved screens implemented; a user's own key is used for their traffic only |
| 7   | Post-MVP               | Owner MFA/password reset, provider packs, multimodal, BALANCED/DEEP, evaluation, billing, multi-server HA                                                                          | Separately approved increments                                                |

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
- [x] Full `docker compose up` verified end to end (Phase 5: `scripts/ops/stack-smoke.sh`, in CI)

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
- [ ] Customer sign-up/login and invitations — Phase 6 (needed for BYOK); owner MFA and password reset — Phase 7
- [ ] Login throttling in Redis — needed before running multiple API instances
- [ ] Background re-validation of keys — moves to the worker in Phase 3

## Phase 2 status

- [x] ARC API keys `ARC_DEE_<id>_PAK_<secret>`: 256-bit secret, hashed, shown once, scoped,
      revocable, rotatable, expiring, last-used tracking; issued per application
- [x] `/v1/models`, `/v1/chat/completions` (JSON + streaming), `/v1/embeddings`
- [x] Request allow-listing (clients cannot inject credentials or base URLs)
- [x] Capability matching from request shape; free-only policy for owner keys
- [x] LiteLLM passthrough verified against LiteLLM 1.110.0 (keys, streaming, cancellation, no
      key/content logging); CI runs the inference suite against it
- [x] Streaming without buffering; client disconnect cancels the provider stream
- [x] Request deadlines; OpenAI-style errors; provider 401/429 marks the key's health
- [x] Route/timing response headers and metadata-only per-request logs
- [x] Bounded graceful shutdown (force-closes lingering streams after a grace period)
- [x] Early measurement: ARC overhead p95 0.56 ms (see ADR 0006) — not yet a load test
- [ ] Single LiteLLM worker saturates around 65 req/s locally: size workers in Phase 4
- [ ] Fallback across keys/models, performance ranking, jurisdiction policy — Phase 3

## Phase 3 status

- [x] Routing policies per tenant and per app: allowed jurisdictions (e.g. exclude CN), and
      paid use of owner keys only with explicit platform-owner approval
- [x] Deterministic gates → ranking by health, free-before-paid, then measured expected latency
- [x] Bounded fallback: same model on other keys, then compatible models (aliases only); capped
      attempts; never past the deadline; no fallback on request errors; policy rechecked each step
- [x] LiteLLM retries disabled (they re-hit rate-limited keys with ~4 s backoff); ARC owns retries
- [x] Cooldowns honouring Retry-After; auth failures mark keys invalid
- [x] Outcome telemetry recorded off the request path; worker computes route scores
- [x] Worker process: route scoring, background key re-validation (with SSRF guard), pruning;
      advisory-locked jobs; proven not to block inference
- [x] Route explanations: admin dry-run endpoint and `x-arc-explain` header
- [x] Fixed Phase 0 compose bug: LiteLLM had no internet egress (internal-only network)
- [ ] Redis-backed cooldowns/rate limits for multiple API instances — Phase 4
- [ ] Load tests and regression gates — Phase 4

## Phase 4 status

- [x] Prometheus metrics: ARC overhead separate from provider TTFT, end-to-end first chunk, total;
      by provider, model, key, app, mode, outcome; internal-only metrics ports
- [x] Background dependency monitor, worker heartbeat, worker job metrics
- [x] Alert rules (+ promtool unit tests in CI); Prometheus under the `monitoring` profile
- [x] Redis coordination: instant cross-instance revocation, routing invalidation and cooldowns;
      shared per-key rate limit with local fallback (tested with two instances)
- [x] Load-test harness (cold, Echo streaming, DSS long, degraded) and CI regression gate
- [x] LiteLLM worker sizing measured; default 4 workers
- [x] Encrypted backups, restore, and a restore drill (passes; fails correctly with a wrong key)
- [x] Controlled deploy with approval, pre-deploy backup, health check and automatic rollback
- [x] Alerts by email (owner's choice): Alertmanager + SMTP (Gmail App Password); verified end to end
- [x] LiteLLM pinned by digest to the verified 1.110.0 release
- [x] Fixed Phase 4 bug: Prometheus UI port was never published (container only on an internal network)
- [x] `ops` container for backups/restores/drill (matching PostgreSQL major, nothing on the host);
      off-site copy to Oracle Object Storage (free 20 GB) via rclone — owner to create the bucket
- [x] `scripts/ops/vps-verify.sh`: drill + RTO/RPO + load test → dated report (passes locally)
- [ ] Run `scripts/ops/vps-verify.sh` on the real Oracle VPS and keep its report (needs the server)

## Phase 5 status

See [app-integration.md](app-integration.md) and ADR 0009.

- [x] `scripts/ops/arc-admin.mjs`: provider keys, model enablement and one ARC key per app,
      through the audited admin API
- [x] Echo Phone → ARC (`lib/arc.js`): chat, streaming, tools, voice/images, JSON, embeddings;
      opt-in via `ARC_BASE_URL`/`ARC_API_KEY`; users' own Gemini keys stay direct
- [x] Data Science Studio → ARC (`arcClient.ts`): every AI call (JSON schema, agent tool loop);
      ARC first, Gemini keys as fallback
- [x] Smoke tests: each app passes its own `scripts/arc-smoke.*` against a real ARC stack with its
      own key; ARC CI runs them on every push
- [ ] Deploy: issue the keys on the VPS and set them on Render (owner)
- [ ] Aira, Echo Mac, Echo web extension — later, same pattern

## Phase 6 status

Increment 1 — **Console (owner)**: done. Layouts approved one by one (page list, grouped sidebar,
Overview "needs you first", Providers grouped list, Models tabs + bulk classify with terms note,
Apps list + detail with rotation overlap); the rest built to the same system.

- [x] Design system "Orbit" from the ARC mark: true black, planet-limb horizon, wide-tracked uppercase
      labels (Barlow), telemetry numbers (IBM Plex Mono), one horizon-blue accent; phone layout;
      fonts bundled, no third-party requests (strict CSP)
- [x] Pages: sign-in, Overview, Providers & keys, Models, Apps (+ detail), Routing (+ "what would
      ARC pick?"), Traffic, Customers, Audit log, Account (theme, password, sessions)
- [x] Backend: per-app traffic rollups, console overview/traffic/customers APIs, terms note, key
      rotation overlap, customer suspension, sessions and password change; served at `/console`
- [x] Tests: console API (9, real Postgres); every page rendered and reviewed in dark, light and
      phone widths against a seeded ARC (`scripts/dev/seed-demo.mjs`)
- [ ] Increment 2 — Customer dashboard + customer sign-up/login (email verification, Google
      sign-in, MFA, password reset) + teams/invitations
- [ ] Increment 3 — Users' own keys through ARC (customer BYOK in the dashboard; apps' end-user keys)

## Phase 6 scope: dashboards and users' own keys

Frontend, with **each screen layout approved before coding**:

- Design tokens and a shared component set.
- **Superadmin console** (owner): provider keys per provider (add, validate, enable/disable,
  rotate), model catalogue and eligibility, apps and their ARC keys, routing policies and route
  explanations, health/metrics and alerts, audit log. Everything `scripts/ops/arc-admin.mjs` does
  today, without the command line.
- **Customer dashboard**: sign-up/login, their apps and ARC keys, usage, and their own provider keys.

**Users bring their own API keys (BYOK) through ARC** — moved here from Phase 7:

- Customers add their own provider keys in the dashboard (the vault already stores
  `tenant_byok` keys, encrypted and scoped to the tenant; customer keys may route to paid models
  under the customer's own policy). Their traffic uses only their keys.
- App users' own keys (today Echo's and the studio's "your own Gemini key", sent to Google
  directly) go through ARC instead, so they get ARC's routing, fallback and monitoring. Design to
  approve first: how an app identifies the user to ARC (e.g. a per-user ARC key or a user id the
  app vouches for) and how the key is stored (ARC's vault, never the app).
- Prerequisite: customer sign-up/login (moved from Phase 7); same tenant-isolation tests as
  today.

## Approved decisions

1. **Name:** ARC = **AI Runtime & Connectivity** (approved). Trademark/domain check still outstanding.
2. **Model aliases:** `auto` (ARC picks the model) plus `arc/fast`, `arc/balanced`, `arc/deep` for
   execution modes; explicit model IDs allowed where policy permits (approved).
3. **Vault key source for the pilot:** versioned key file mounted from outside Postgres, with a
   separate off-site backup; move to a KMS later (approved).
4. **Pilot RTO/RPO:** RTO 4h, RPO 24h — targets only until a restore drill proves them (approved).

5. **Alerts:** by email (approved).
6. **LiteLLM version:** 1.110.0, pinned by digest (done).
7. **Hosting:** Oracle Cloud Always Free; see [costs.md](costs.md).

## Open decisions

1. Trademark/domain check for the name ARC.
