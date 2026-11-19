#!/usr/bin/env bash
# Encrypted PostgreSQL backup for ARC.
#
#   DATABASE_URL=postgres://… BACKUP_PASSPHRASE_FILE=/secure/backup-pass scripts/ops/backup.sh
#
# Optional: BACKUP_DIR (default ./backups), BACKUP_RETENTION_DAYS (default 14),
# BACKUP_RCLONE_REMOTE (e.g. "oci:arc-backups") to copy the backup off-site with rclone.
#
# The vault key file is NOT in this backup and must be backed up separately (see
# docs/operations.md): without it, restored provider credentials cannot be decrypted.
# Prefer a DATABASE_URL without a password plus ~/.pgpass, so no secret appears in process args.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE_FILE:?BACKUP_PASSPHRASE_FILE is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

[[ -r "$BACKUP_PASSPHRASE_FILE" ]] || { echo "cannot read BACKUP_PASSPHRASE_FILE" >&2; exit 1; }
umask 077
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/arc-db-$stamp.dump.gpg"

# Custom format (compressed, selective restore). pipefail makes a pg_dump failure fail the run.
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
        --passphrase-file "$BACKUP_PASSPHRASE_FILE" --output "$out.partial"
mv "$out.partial" "$out"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")

if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  rclone copy "$out" "$BACKUP_RCLONE_REMOTE"
  rclone copy "$out.sha256" "$BACKUP_RCLONE_REMOTE"
fi

# Local retention only; off-site retention is managed on the remote.
find "$BACKUP_DIR" -maxdepth 1 -name 'arc-db-*.dump.gpg*' -type f -mtime +"$RETENTION_DAYS" -delete

echo "$out"
