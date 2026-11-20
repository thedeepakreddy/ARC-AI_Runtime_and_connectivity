#!/bin/sh
# Renders alertmanager.yml.tmpl from ALERT_* variables, checks it, then starts Alertmanager.
# Runs inside prom/alertmanager (busybox sh + awk). Refuses to start with missing settings, so a
# misconfigured alert route fails loudly instead of silently dropping alerts.
set -eu

TEMPLATE=${ALERTMANAGER_TEMPLATE:-/etc/alertmanager/alertmanager.yml.tmpl}
OUT=${ALERTMANAGER_CONFIG:-/tmp/alertmanager.yml}
PASSWORD_FILE=${ALERT_SMTP_PASSWORD_FILE:-/run/secrets/arc/smtp-password}

missing=""
for name in ALERT_EMAIL_TO ALERT_EMAIL_FROM ALERT_SMTP_HOST ALERT_SMTP_USER ALERT_SMTP_REQUIRE_TLS; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "alertmanager: set these in .env:$missing" >&2
  exit 1
fi
if [ ! -s "$PASSWORD_FILE" ]; then
  echo "alertmanager: SMTP password file is missing or empty ($PASSWORD_FILE)" >&2
  exit 1
fi

# Values are inserted literally (no shell or regex interpretation of their contents).
awk '{
  line = $0
  while (match(line, /\$\{[A-Z_]+\}/)) {
    name = substr(line, RSTART + 2, RLENGTH - 3)
    line = substr(line, 1, RSTART - 1) ENVIRON[name] substr(line, RSTART + RLENGTH)
  }
  print line
}' "$TEMPLATE" > "$OUT"
sed -i "s#/run/secrets/arc/smtp-password#$PASSWORD_FILE#" "$OUT"

amtool check-config "$OUT" > /dev/null
[ "${ALERTMANAGER_CHECK_ONLY:-false}" = "true" ] && { echo "alertmanager: config OK"; exit 0; }
exec /bin/alertmanager --config.file="$OUT" --storage.path=/alertmanager "$@"
