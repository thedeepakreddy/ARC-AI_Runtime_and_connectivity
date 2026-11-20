# ADR 0001 — Stack and repository layout

Status: Accepted · Phase 0 · Hosting confirmed in Phase 6: Oracle Cloud Always Free
([deploy-oracle.md](../deploy-oracle.md)); Google Cloud documented as the paid alternative.

## Context

The blueprint fixes the backend stack (Node.js, TypeScript, Fastify, Zod), PostgreSQL, Redis,
LiteLLM and Docker Compose on an Oracle Cloud VPS for the pilot.

## Decision

- **pnpm workspace monorepo**: `apps/api`, `apps/worker`, `packages/shared`; the dashboard will
  be added as `apps/dashboard` in Phase 6.
- **Node 22 LTS**, ESM, TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
- **TypeScript 6.0.x**, not 7.x: typescript-eslint does not yet support TS 7. Revisit when it does.
- **Vitest** for tests, **ESLint** (typescript-eslint) and **Prettier** for style.
- Workspace packages export source through a custom `arc-source` condition for dev/test
  (`tsx`, Vitest) and compiled `dist` for production builds.
- The API and the worker are **separate processes**, so background jobs can never block the
  inference path (latency-first principle).

## Consequences

One `pnpm check` gates every change. Services share config/redaction code without duplication.
