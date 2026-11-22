#!/usr/bin/env bash
# Controlled ARC deployment: validate → build → (approval) → backup → roll out → health-check →
# automatic rollback on failure.
#
#   scripts/ops/deploy.sh <git-ref>            # dry run: validate and build images, change nothing
#   scripts/ops/deploy.sh <git-ref> --approve  # production rollout
#
# Env: DATABASE_URL + BACKUP_PASSPHRASE_FILE (pre-deploy backup; SKIP_BACKUP=1 to skip),
#      HEALTH_URL (default http://127.0.0.1:8080/readyz), HEALTH_TIMEOUT_S (default 120),
#      DEPLOY_STATE_FILE (default .deploy/current-version).
#
# Database migrations run when the new API starts. Rollback restarts the previous images but
# cannot undo a migration, so migrations must be backward compatible (expand/contract; see
# docs/operations.md). Changes to docker-compose.yml itself are applied separately.
set -euo pipefail

ref="${1:?usage: deploy.sh <git-ref> [--approve]}"
approve="${2:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/readyz}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
STATE_FILE="${DEPLOY_STATE_FILE:-.deploy/current-version}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

rollout() {
  ARC_VERSION="$1" docker compose up -d --no-build api worker
}

# Record the live version in .env, so later plain `docker compose` commands (recreating Caddy,
# `up -d` after a compose change) keep these images instead of falling back to arc-*:local.
pin_version() {
  local env_file="${ENV_FILE:-.env}"
  [[ -f "$env_file" ]] || return 0
  if grep -q '^ARC_VERSION=' "$env_file"; then
    sed -i "s/^ARC_VERSION=.*/ARC_VERSION=$1/" "$env_file"
  else
    printf '\nARC_VERSION=%s\n' "$1" >> "$env_file"
  fi
}

# 1. Validate
[[ -z "$(git status --porcelain)" ]] || die "working tree has uncommitted changes"
git fetch --quiet --tags origin || log "warning: fetch failed; using local refs"
sha="$(git rev-parse --verify --quiet "${ref}^{commit}")" || die "unknown ref: $ref"
short="${sha:0:12}"
previous="$(cat "$STATE_FILE" 2>/dev/null || echo "")"
log "current version: ${previous:-unknown}  →  target: $short ($ref)"

# 2. Build images for the exact commit, from a clean worktree (stage)
tree="$(mktemp -d)"
trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || true' EXIT
git worktree add --quiet --detach "$tree" "$sha"
docker build --quiet --target api -t "arc-api:$short" "$tree" >/dev/null
docker build --quiet --target worker -t "arc-worker:$short" "$tree" >/dev/null
log "built arc-api:$short and arc-worker:$short"

if [[ "$approve" != "--approve" ]]; then
  log "dry run complete. Re-run with --approve to deploy $short to production."
  exit 0
fi

# 3. Backup before changing anything
if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  log "backing up database"
  "$here/backup.sh" >/dev/null
fi

# 4. Roll out and health-check
log "rolling out $short"
rollout "$short"
if wait_healthy; then
  mkdir -p "$(dirname "$STATE_FILE")"
  echo "$short" > "$STATE_FILE"
  pin_version "$short"
  log "healthy: $short is live"
  exit 0
fi

# 5. Automatic rollback
log "health check failed within ${HEALTH_TIMEOUT_S}s"
[[ -n "$previous" ]] || die "no previous version recorded; cannot roll back automatically"
log "rolling back to $previous"
rollout "$previous"
if wait_healthy; then
  pin_version "$previous"
  die "rolled back to $previous (healthy). Deployment of $short FAILED."
fi
die "rollback to $previous is NOT healthy either: manual intervention required"
