# ARC — Operations

## First-time setup (pilot server)

```bash
cp .env.example .env            # set real secrets
mkdir -p secrets

# 1. Vault key file — lives outside Postgres. Back it up off-site separately from DB backups:
#    a database backup alone cannot recover encrypted provider keys.
docker compose run --rm --no-deps api node dist/cli/vault-keygen.js > secrets/vault-keys.json
chmod 640 secrets/vault-keys.json   # readable by the container user (uid 1000) only
sudo chown 1000:1000 secrets/vault-keys.json

# 2. Start the stack (the API applies migrations on start).
docker compose up -d --build

# 3. Create the platform owner. Password via env so it stays out of shell history.
read -s ARC_OWNER_PASSWORD && export ARC_OWNER_PASSWORD
docker compose exec -e ARC_OWNER_EMAIL=you@example.com -e ARC_OWNER_PASSWORD api \
  node dist/cli/create-owner.js
```

Run ARC behind HTTPS (e.g. Caddy or Nginx). Session cookies are `Secure` by default; set
`TRUST_PROXY=true` when a reverse proxy sets `X-Forwarded-For`.

## Vault key rotation

```bash
# Add a new key version (old versions stay so existing data still decrypts).
docker compose exec api node dist/cli/vault-keygen.js /run/secrets/arc/vault-keys.json \
  > secrets/vault-keys.next.json
mv secrets/vault-keys.next.json secrets/vault-keys.json
docker compose restart api
# Re-wrap every credential's data key under the new version.
docker compose exec api node dist/cli/vault-rewrap.js
```

Remove an old key version from the file only after `vault-rewrap` reports success and a fresh
off-site backup of the new key file exists.

## Worker

The `worker` service (same image as the API, `node dist/worker/main.js`) computes route scores,
re-validates provider keys in the background and prunes old telemetry. It needs `DATABASE_URL`,
`ARC_VAULT_KEY_FILE` and outbound internet (the `egress` network). Tunables:
`SCORE_INTERVAL_MS` (15 s), `REVALIDATE_INTERVAL_MS` (5 min), `REVALIDATE_STALE_MINUTES` (15),
`PROBE_TIMEOUT_MS` (5 s). Running several workers is safe: jobs take Postgres advisory locks.

API routing tunables: `MAX_ATTEMPTS` (3), `MIN_ATTEMPT_MS` (250).

## Monitoring

- Metrics: API `api:9464/metrics`, worker `worker:9465/metrics` (private network only).
- Prometheus with ARC's alert rules: `docker compose --profile monitoring up -d`, UI on
  `127.0.0.1:9090`. To get notified, add an Alertmanager with your destination (email, Slack,
  PagerDuty …) in `infra/prometheus/prometheus.yml`.
- Key signals: `arc_overhead_ms` (ARC's own time, target p95 ≤ 30 ms), `arc_provider_ttfb_ms`,
  `arc_first_chunk_ms`, `arc_requests_total{outcome}`, `arc_fallbacks_total`,
  `arc_dependency_up`, `arc_worker_heartbeat_age_seconds`.

## Scaling and coordination

Run more API instances behind a load balancer: revocations, routing changes and cooldowns are
shared over Redis pub/sub (`COORDINATION=redis`, default) and the per-key rate limit is shared in
Redis. Size LiteLLM with `LITELLM_NUM_WORKERS` (default 4; see ADR 0008) to the server's cores.

## Backups and restore

```bash
# Nightly (cron): encrypted backup, optional off-site copy
DATABASE_URL=postgres://arc@127.0.0.1:5432/arc BACKUP_PASSPHRASE_FILE=/secure/backup-pass \
BACKUP_DIR=/var/backups/arc BACKUP_RCLONE_REMOTE=oci:arc-backups scripts/ops/backup.sh
```

- Use a `pg_dump` at least as new as the server (`pg_dump` refuses newer servers).
- Back up `secrets/vault-keys.json` and the backup passphrase **separately** and off-site. A
  database backup alone cannot recover provider credentials.
- Restore into a fresh database: `TARGET_DATABASE_URL=… BACKUP_PASSPHRASE_FILE=…
scripts/ops/restore.sh <file>` (add `--into-existing` only for a deliberate overwrite).
- **Restore drill** (monthly, and after any backup change):
  `DATABASE_URL=… ADMIN_DATABASE_URL=…/postgres BACKUP_PASSPHRASE_FILE=… ARC_VAULT_KEY_FILE=…
scripts/ops/restore-drill.sh` — restores into a scratch database, checks schema, row counts and
  that every credential decrypts, then drops it. Proposed pilot targets: RTO 4 h, RPO 24 h (not
  yet proven on the real VPS).

## Deploying updates

```bash
scripts/ops/deploy.sh v1.2.0              # dry run: validate + build images for that commit
scripts/ops/deploy.sh v1.2.0 --approve    # backup → roll out → health check → auto-rollback
```

Migrations run when the new API starts and are not undone by a rollback, so every migration must
be backward compatible with the previous release (expand/contract: add columns/tables first,
remove them only in a later release).

## Load testing

```bash
cd apps/api && pnpm build
LITELLM_URL=http://127.0.0.1:4000 LITELLM_MASTER_KEY=… BENCH_DATABASE_URL=postgres://…/postgres \
  node --import tsx bench/run.ts --gate --requests 300 --concurrency 10 --out results.json
```

## Migrations

Applied automatically on API start (`MIGRATE_ON_START=true`), under a Postgres advisory lock.
To run manually: `node dist/cli/migrate.js` with `DATABASE_URL` set.

## Local development without Docker

```bash
# Postgres 16+ reachable at TEST_DATABASE_URL runs the integration tests:
TEST_DATABASE_URL=postgres://arc:arc@127.0.0.1:5432/postgres pnpm test
```

Without `TEST_DATABASE_URL`, database tests are skipped and only unit tests run.
