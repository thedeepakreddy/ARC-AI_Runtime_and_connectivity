# ARC — AI Runtime & Connectivity

One intelligence layer for every application. ARC gives Echo, Aira, Data Science Studio and
future apps a single OpenAI-compatible API, while it manages providers, multiple keys per
provider, routing, fallback, security and monitoring behind it.

> Status: **Phase 4 — operations.** OpenAI-compatible `/v1` API with intelligent routing, plus
> Prometheus metrics and alerts, Redis coordination for multiple instances, a load-test gate,
> encrypted backups with a restore drill, and controlled deploys with rollback. See
> [docs/plan.md](docs/plan.md), [docs/operations.md](docs/operations.md),
> [docs/inference-api.md](docs/inference-api.md) and [docs/admin-api.md](docs/admin-api.md).

## Layout

```
apps/api         Fastify + Zod API: control plane, /v1 inference, and the worker entrypoint
                 (src/worker: route scoring, key health checks — kept off the request path)
packages/shared  Config validation and log redaction shared by services
apps/api/bench   Load test and regression gate
infra/           LiteLLM, Prometheus (alerts), Postgres init
scripts/ops/     Backup, restore, restore drill, controlled deploy
docs/            Plan, ADRs, threat model, provider list
```

## Requirements

Node 22+, pnpm 10 (`corepack enable`), Docker with Compose v2.

## Local setup

```bash
pnpm install
pnpm check            # format, lint, typecheck, tests

cp .env.example .env  # then set real secrets
# create secrets/vault-keys.json and the owner: see docs/operations.md
docker compose up -d --build
curl localhost:8080/healthz   # liveness
curl localhost:8080/readyz    # postgres, redis, litellm reachable
```

Integration tests need a PostgreSQL server:

```bash
TEST_DATABASE_URL=postgres://arc:arc@127.0.0.1:5432/postgres pnpm test
```

Add `LITELLM_TEST_URL=http://127.0.0.1:4000` (and `LITELLM_TEST_MASTER_KEY`) to run the
inference suite through a real LiteLLM proxy instead of the built-in stand-in.

Run the API on the host against containerised dependencies:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis litellm
DATABASE_URL=postgres://arc:<password>@127.0.0.1:5432/arc \
REDIS_URL=redis://127.0.0.1:6379 \
LITELLM_BASE_URL=http://127.0.0.1:4000 \
LITELLM_MASTER_KEY=<from .env> \
ARC_VAULT_KEY_FILE=./secrets/vault-keys.json COOKIE_SECURE=false \
pnpm dev
```

## Principles

- **Latency first:** no extra LLM call to route ordinary requests; stream immediately; provider
  intelligence is maintained asynchronously by the worker.
- **Free-first, honest:** unknown pricing or quota is never treated as free.
- **Metadata-only logging:** no secrets, prompts, responses or file contents in logs.
