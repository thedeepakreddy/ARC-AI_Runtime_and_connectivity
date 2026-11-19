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

## Migrations

Applied automatically on API start (`MIGRATE_ON_START=true`), under a Postgres advisory lock.
To run manually: `node dist/cli/migrate.js` with `DATABASE_URL` set.

## Local development without Docker

```bash
# Postgres 16+ reachable at TEST_DATABASE_URL runs the integration tests:
TEST_DATABASE_URL=postgres://arc:arc@127.0.0.1:5432/postgres pnpm test
```

Without `TEST_DATABASE_URL`, database tests are skipped and only unit tests run.
