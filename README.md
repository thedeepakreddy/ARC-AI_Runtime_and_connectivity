# ARC — AI Runtime & Connectivity

One intelligence layer for every application. ARC gives Echo, Aira, Data Science Studio and
future apps a single OpenAI-compatible API, while it manages providers, multiple keys per
provider, routing, fallback, security and monitoring behind it.

> Status: **Phase 0 — foundation.** No inference endpoints yet. See [docs/plan.md](docs/plan.md).

## Layout

```
apps/api         Fastify + Zod API / control plane (health, readiness; inference in Phase 2)
apps/worker      Background jobs kept off the inference path (discovery, health, quota, ranking)
packages/shared  Config validation and log redaction shared by services
infra/           LiteLLM config, Postgres init
docs/            Plan, ADRs, threat model, provider list
```

## Requirements

Node 22+, pnpm 10 (`corepack enable`), Docker with Compose v2.

## Local setup

```bash
pnpm install
pnpm check            # format, lint, typecheck, tests

cp .env.example .env  # then set real secrets
docker compose up -d --build
curl localhost:8080/healthz   # liveness
curl localhost:8080/readyz    # postgres, redis, litellm reachable
```

Run the API on the host against containerised dependencies:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis litellm
DATABASE_URL=postgres://arc:<password>@127.0.0.1:5432/arc \
REDIS_URL=redis://127.0.0.1:6379 \
LITELLM_BASE_URL=http://127.0.0.1:4000 \
pnpm dev
```

## Principles

- **Latency first:** no extra LLM call to route ordinary requests; stream immediately; provider
  intelligence is maintained asynchronously by the worker.
- **Free-first, honest:** unknown pricing or quota is never treated as free.
- **Metadata-only logging:** no secrets, prompts, responses or file contents in logs.
