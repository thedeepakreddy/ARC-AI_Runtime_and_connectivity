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

Run ARC behind HTTPS: the bundled Caddy does it (`docker compose --profile https up -d`, with
`ARC_DOMAIN` and `ACME_EMAIL` in `.env`), getting and renewing a Let's Encrypt certificate. The API
itself listens on loopback only (`ARC_HTTP_BIND`, default `127.0.0.1`). Session cookies are
`Secure` by default; set `TRUST_PROXY=true` behind Caddy so sign-in throttling sees real client
addresses. On Google Cloud, follow [deploy-gcp.md](deploy-gcp.md).

Sign-in, sign-up and invitation-lookup limits are shared across API instances through Redis
(`COORDINATION=redis`, the default), keyed by a hash of the email or address; if Redis is down
each instance keeps limiting on its own.

## Accounts: two-step sign-in, password reset, email, Google

- **Two-step sign-in (everyone, owner included):** Account → Security → Turn on. Any authenticator
  app works (TOTP, 6 digits). The secret is sealed with the vault key like provider keys, and
  re-wrapped by `vault-rewrap`. Ten one-use recovery codes are shown once. The owner should turn
  it on before going live.
- **Password reset and email verification** need email: set `PUBLIC_URL` (e.g.
  `https://arc.example.com`) and the `ALERT_SMTP_*`/`ALERT_EMAIL_FROM` settings; the API sends
  through the same account and `secrets/smtp-password`. Without them, "Forgot password?" is
  hidden, and open sign-ups are treated as confirmed. Links work once (reset: 30 minutes,
  confirm: 48 hours); a reset signs out every session.
- **Email verification** applies to open sign-ups only (`SIGNUP_MODE=open`): until confirmed,
  they can look around but not create apps or keys. Invited people, the owner and Google users
  are confirmed already.
- **Google sign-in (optional):** in Google Cloud Console create an OAuth client ("Web
  application") with redirect URI `https://<domain>/admin/v1/auth/google/callback`; put its id in
  `GOOGLE_CLIENT_ID` and its secret in `secrets/google-client-secret`. Google signs in existing
  accounts with the same verified email (linking them), and creates accounts only from an
  invitation (or with open sign-up). Two-step sign-in still applies after Google.
- Request logs record paths only, never query strings, so one-time values never reach logs.

## Ads in the customer dashboard

A Google AdSense unit can fill the space in the dashboard's sidebar, above the account panel
(desktop only; never in the owner console or on sign-in screens). Off by default.

1. Get the site approved in AdSense, create a display ad unit (a 200 × 300 custom size fits),
   and set `ADSENSE_CLIENT=ca-pub-…` and `ADSENSE_SLOT=…` in `.env`.
2. ARC then serves `/ads.txt` for your publisher id, and gives the dashboard a strict
   nonce-based Content Security Policy that lets Google's ad loader run (and nothing else
   unannounced). Without the settings, the dashboard allows no third-party scripts at all.
3. In the EEA, UK and Switzerland, Google requires a certified consent banner (CMP): turn on
   Google's own in AdSense → Privacy & messaging before showing ads there.

Know the trade-off: ad scripts run inside a signed-in page. They can't read the session cookie
(HttpOnly), but they share the page with things shown once, such as a new ARC key. Google's
loader is the only script admitted; the ads themselves render in Google's frames.

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
- Prometheus with ARC's alert rules, and Alertmanager emailing them:
  `docker compose --profile monitoring up -d`. UIs on the server's loopback only: Prometheus
  `127.0.0.1:9090`, Alertmanager `127.0.0.1:9093` (reach them with `ssh -L 9090:127.0.0.1:9090 …`).
- Key signals: `arc_overhead_ms` (ARC's own time, target p95 ≤ 30 ms), `arc_provider_ttfb_ms`,
  `arc_first_chunk_ms`, `arc_requests_total{outcome}`, `arc_fallbacks_total`,
  `arc_dependency_up`, `arc_worker_heartbeat_age_seconds`.

## Alerts by email

Alertmanager (`infra/alertmanager`) sends every firing and resolved alert to one inbox, grouped
(at most one email per alert group every 5 minutes, a reminder every 4 hours while it lasts).
With Gmail (free):

1. Turn on 2-Step Verification for the Google account, then create an **App Password**
   (Google Account → Security → App passwords).
2. In `.env`:

   ```bash
   ALERT_EMAIL_TO=you@example.com
   ALERT_EMAIL_FROM=you@gmail.com
   ALERT_SMTP_USER=you@gmail.com
   ALERT_SMTP_HOST=smtp.gmail.com:587
   ```

3. The App Password goes in a file, never in `.env`:

   ```bash
   read -s P && printf '%s\n' "$P" > secrets/smtp-password && unset P
   sudo chown 65534 secrets/smtp-password && chmod 600 secrets/smtp-password  # Alertmanager runs as "nobody"
   docker compose --profile monitoring up -d
   ```

4. Test it: `docker compose exec api node --input-type=module -e 'await fetch("http://alertmanager:9093/api/v2/alerts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify([{labels:{alertname:"ArcTestAlert",severity:"info"}}])})'`
   — an email titled `[ARC] FIRING: ArcTestAlert` arrives within a minute.

Alertmanager refuses to start if a setting or the password file is missing, so alerts never
vanish silently.

## Scaling and coordination

Run more API instances behind a load balancer: revocations, routing changes and cooldowns are
shared over Redis pub/sub (`COORDINATION=redis`, default) and the per-key rate limit is shared in
Redis. Size LiteLLM with `LITELLM_NUM_WORKERS` (default 4; see ADR 0008) to the server's cores.

## Backups and restore

Backups, restores and the drill run in the `ops` container, on the stack's private network and
with the same PostgreSQL major as the server (nothing to install on the host):

```bash
openssl rand -base64 32 > secrets/backup-passphrase && chmod 600 secrets/backup-passphrase
# Nightly, from cron (crontab -e), e.g. 03:17 UTC:
17 3 * * * cd /opt/arc && docker compose --profile ops run --rm -T ops scripts/ops/backup.sh >> /var/log/arc-backup.log 2>&1
```

Backups land in `./backups` (`ARC_BACKUP_DIR`), kept 14 days (`BACKUP_RETENTION_DAYS`).

**Off-site copy (Google Cloud Storage).** Create a bucket (e.g. `arc-backups`, Standard class,
same region as the VM) and a service account with the _Storage Object Creator_ and _Viewer_
roles on that bucket only; download its JSON key to `secrets/gcs-backup.json`. Then
`secrets/rclone.conf`:

```ini
[gcs]
type = google cloud storage
service_account_file = /run/secrets/arc/gcs-backup.json
bucket_policy_only = true
```

and `BACKUP_RCLONE_REMOTE=gcs:arc-backups` in `.env`. Every backup is then copied off-site.

- Use the same PostgreSQL major version for `pg_dump`, `pg_restore` and the servers you back up
  and restore to: `pg_dump` refuses newer servers, and a newer `pg_dump` can write settings an
  older server rejects on restore (e.g. `SET transaction_timeout`).
- Back up `secrets/vault-keys.json` and the backup passphrase **separately** and off-site. A
  database backup alone cannot recover provider credentials.
- Restore into a fresh database: `TARGET_DATABASE_URL=… BACKUP_PASSPHRASE_FILE=…
scripts/ops/restore.sh <file>` (add `--into-existing` only for a deliberate overwrite).
- **Restore drill** (monthly, and after any backup change):
  `DATABASE_URL=… ADMIN_DATABASE_URL=…/postgres BACKUP_PASSPHRASE_FILE=… ARC_VAULT_KEY_FILE=…
scripts/ops/restore-drill.sh` — restores into a scratch database, checks schema, row counts and
  that every credential decrypts, then drops it. Proposed pilot targets: RTO 4 h, RPO 24 h (not
  yet proven on the real VPS).

## Verifying the server (RTO / RPO / load)

On the VPS, with the stack running and a nightly backup in place:

```bash
scripts/ops/vps-verify.sh            # restore drill + load test → ops-reports/vps-verify-<time>.md
scripts/ops/vps-verify.sh --drill-only
```

It runs the restore drill (backup → scratch restore → schema, row counts, every credential
decrypts → drop) and records its duration against the RTO target (4 h), the newest backup's age
against the RPO target (24 h), and runs the load-test gate against this server's real LiteLLM
(run that in a quiet period). Re-run it after changing the server size or `LITELLM_NUM_WORKERS`.

## Full-stack smoke test

`scripts/ops/stack-smoke.sh` builds and starts the whole stack in an isolated Compose project
(your `.env` and `secrets/` are not touched), with a stand-in provider and mail catcher, and
checks health, the admin flow, inference for two apps with separate keys, Prometheus, an alert
email and — with `ECHO_DIR` / `DSS_DIR` — the apps' own ARC smoke tests. CI runs it on every push.

## Console

The owner console is served by the API at `https://<arc-domain>/console` (same origin as the admin
API, strict content-security policy). Sign in as the platform owner. For development:
`pnpm --filter @arc/console dev` proxies to a local ARC; `scripts/dev/seed-demo.mjs` fills a
**non-production** database with demo keys, models, apps and traffic.

## Connecting apps

See [app-integration.md](app-integration.md): `scripts/ops/arc-admin.mjs` adds provider keys,
enables models and issues one ARC key per app.

## Deploying updates

```bash
scripts/ops/deploy.sh v1.2.0              # dry run: validate + build images for that commit
scripts/ops/deploy.sh v1.2.0 --approve    # backup → roll out → health check → auto-rollback
```

Migrations run when the new API starts and are not undone by a rollback, so every migration must
be backward compatible with the previous release (expand/contract: add columns/tables first,
remove them only in a later release).

## Load testing

On the server: `scripts/ops/vps-verify.sh`. During development:

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
