# syntax=docker/dockerfile:1
# Multi-target image for ARC services. Build with --target api or --target worker.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm build \
 && pnpm deploy --filter @arc/api --prod --legacy /out/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
USER node
WORKDIR /app

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]

# The worker ships in the API package (shared vault, probe and validation code).
FROM runtime AS worker
COPY --from=build --chown=node:node /out/api ./
CMD ["node", "dist/worker/main.js"]

# Operations toolbox: backups, restores and the restore drill, run next to the stack on its
# private network (docker compose --profile ops run --rm ops …). Built on the same PostgreSQL
# major as the server, so pg_dump/pg_restore always match it.
FROM postgres:17-alpine AS ops
RUN apk add --no-cache bash gnupg nodejs rclone
WORKDIR /repo
COPY --from=build /out/api apps/api
COPY scripts/ops scripts/ops
ENTRYPOINT []
CMD ["bash", "-c", "echo 'usage: docker compose --profile ops run --rm ops scripts/ops/<script>.sh'"]

# Load test (bench/run.ts) with the full workspace and dev dependencies. Runs inside LiteLLM's
# network namespace so the real LiteLLM can reach the benchmark's mock providers on 127.0.0.1.
FROM build AS bench
WORKDIR /repo/apps/api
CMD ["node", "--import", "tsx", "bench/run.ts", "--gate"]
