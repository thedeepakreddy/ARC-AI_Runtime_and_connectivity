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

## Migrations

Applied automatically on API start (`MIGRATE_ON_START=true`), under a Postgres advisory lock.
To run manually: `node dist/cli/migrate.js` with `DATABASE_URL` set.

## Local development without Docker

```bash
# Postgres 16+ reachable at TEST_DATABASE_URL runs the integration tests:
TEST_DATABASE_URL=postgres://arc:arc@127.0.0.1:5432/postgres pnpm test
```

Without `TEST_DATABASE_URL`, database tests are skipped and only unit tests run.
