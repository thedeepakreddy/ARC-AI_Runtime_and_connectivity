#!/usr/bin/env bash
# Restore drill: back up the live database, restore it into a scratch database, and prove the
# result is usable — same schema version, same row counts, and every provider credential
# decrypts with the vault key file. The scratch database is always dropped afterwards.
#
#   DATABASE_URL=postgres://…/arc  ADMIN_DATABASE_URL=postgres://…/postgres \
#   BACKUP_PASSPHRASE_FILE=…  ARC_VAULT_KEY_FILE=…  scripts/ops/restore-drill.sh
set -euo pipefail

: "${DATABASE_URL:?}" "${ADMIN_DATABASE_URL:?}" "${BACKUP_PASSPHRASE_FILE:?}" "${ARC_VAULT_KEY_FILE:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
scratch="arc_restore_drill_$(date -u +%Y%m%d%H%M%S)"
restored_url="$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$ADMIN_DATABASE_URL" "$scratch")"

cleanup() {
  psql --dbname="$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

started=$(date +%s)
echo "1/4 backing up"
backup="$(BACKUP_DIR="$work" BACKUP_RETENTION_DAYS=36500 "$here/backup.sh")"

echo "2/4 creating scratch database $scratch"
psql --dbname="$ADMIN_DATABASE_URL" -qc "CREATE DATABASE $scratch" >/dev/null

echo "3/4 restoring"
TARGET_DATABASE_URL="$restored_url" "$here/restore.sh" "$backup" >/dev/null

echo "4/4 verifying"
SOURCE_DATABASE_URL="$DATABASE_URL" RESTORED_DATABASE_URL="$restored_url" \
  node "$root/apps/api/dist/cli/verify-restore.js"

echo "restore drill passed in $(( $(date +%s) - started ))s (backup size $(du -h "$backup" | cut -f1))"
