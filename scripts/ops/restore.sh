#!/usr/bin/env bash
# Restore an encrypted ARC backup into a database.
#
#   TARGET_DATABASE_URL=postgres://…/arc_restored BACKUP_PASSPHRASE_FILE=… \
#     scripts/ops/restore.sh backups/arc-db-<stamp>.dump.gpg [--into-existing]
#
# By default the target must be empty (a fresh database). --into-existing overwrites objects
# in a database that already has ARC tables — only for a deliberate production restore.
set -euo pipefail

backup="${1:?usage: restore.sh <backup.dump.gpg> [--into-existing]}"
mode="${2:-}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE_FILE:?BACKUP_PASSPHRASE_FILE is required}"

[[ -r "$backup" ]] || { echo "cannot read $backup" >&2; exit 1; }
if [[ -f "$backup.sha256" ]]; then
  (cd "$(dirname "$backup")" && sha256sum --check --quiet "$(basename "$backup").sha256")
else
  echo "warning: no checksum file next to the backup; skipping integrity check" >&2
fi

existing="$(psql --dbname="$TARGET_DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
if [[ "$existing" != "0" && "$mode" != "--into-existing" ]]; then
  echo "target database is not empty ($existing tables); pass --into-existing to overwrite" >&2
  exit 1
fi

gpg --batch --quiet --decrypt --passphrase-file "$BACKUP_PASSPHRASE_FILE" "$backup" \
  | pg_restore --no-owner --no-privileges --exit-on-error \
      ${mode:+--clean --if-exists} --dbname="$TARGET_DATABASE_URL"

echo "restored $(basename "$backup")"
