#!/usr/bin/env bash
# Prove ARC's recovery and performance targets on THIS server, and write a dated report.
#
# Run on the VPS from the ARC checkout, with the stack running (docker compose up -d):
#
#   scripts/ops/vps-verify.sh                # restore drill + load test
#   scripts/ops/vps-verify.sh --drill-only   # skip the load test
#
# 1. Restore drill (in the `ops` container, same PostgreSQL major as the server): back up the live
#    database, restore it into a scratch database, check schema, row counts and that every
#    provider credential decrypts, then drop it. Its duration is the restore part of the RTO.
# 2. RPO: age of the newest backup in ARC_BACKUP_DIR — the most data a restore would lose now.
# 3. Load test (in the `bench` container, using this server's real LiteLLM): ARC overhead and
#    error-rate gate. It adds load to the shared LiteLLM, so run it in a quiet period.
#
# Report: ops-reports/vps-verify-<UTC time>.md (and the load-test JSON next to it).
# Needs: secrets/vault-keys.json, secrets/backup-passphrase (see docs/operations.md).
# Env: ARC_ENV_FILE (.env), ARC_COMPOSE_PROJECT, ARC_COMPOSE_EXTRA (an extra compose file),
#      ARC_BACKUP_DIR (./backups), ARC_SECRETS_DIR (./secrets), BENCH_REQUESTS (300),
#      BENCH_CONCURRENCY (10), TARGET_RTO_MINUTES (240), TARGET_RPO_HOURS (24),
#      VERIFY_SKIP_BUILD=1 (use already-built arc-ops / arc-bench images).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
ENV_FILE=${ARC_ENV_FILE:-.env}
SECRETS=${ARC_SECRETS_DIR:-./secrets}
BACKUPS=${ARC_BACKUP_DIR:-./backups}
REPORTS=${ARC_REPORT_DIR:-./ops-reports}
REQUESTS=${BENCH_REQUESTS:-300}
CONCURRENCY=${BENCH_CONCURRENCY:-10}
RTO_MIN=${TARGET_RTO_MINUTES:-240}
RPO_H=${TARGET_RPO_HOURS:-24}
DRILL_ONLY=0
[ "${1:-}" = "--drill-only" ] && DRILL_ONLY=1

die() {
  echo "vps-verify: $*" >&2
  exit 1
}
compose() {
  local args=(--env-file "$ENV_FILE" -f docker-compose.yml)
  [ -n "${ARC_COMPOSE_EXTRA:-}" ] && args+=(-f "$ARC_COMPOSE_EXTRA")
  [ -n "${ARC_COMPOSE_PROJECT:-}" ] && args+=(-p "$ARC_COMPOSE_PROJECT")
  ARC_SECRETS_DIR="$SECRETS" ARC_BACKUP_DIR="$BACKUPS" ARC_REPORT_DIR="$REPORTS" \
    docker compose "${args[@]}" --profile ops "$@"
}

[ -f "$ENV_FILE" ] || die "no $ENV_FILE"
[ -s "$SECRETS/vault-keys.json" ] || die "no $SECRETS/vault-keys.json"
[ -s "$SECRETS/backup-passphrase" ] || die "no $SECRETS/backup-passphrase (create it: see docs/operations.md)"
mkdir -p "$BACKUPS" "$REPORTS"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
report="$REPORTS/vps-verify-$stamp.md"
verdict=PASS

echo "== building the ops tools for this commit"
tools=(ops)
[ "$DRILL_ONLY" = 1 ] || tools+=(bench)
if [ "${VERIFY_SKIP_BUILD:-}" = "1" ]; then
  echo "  using existing arc-ops / arc-bench images"
else
  compose build "${tools[@]}" >/dev/null
fi

echo "== stack status"
compose ps --format '{{.Service}}: {{.State}}' | sort
ready=$(compose exec -T api wget -qO- http://127.0.0.1:8080/readyz 2>/dev/null || true)
echo "$ready" | grep -q '"ready":true' || die "ARC is not ready (readyz: ${ready:-no answer}); start the stack first"

echo "== restore drill"
drill_log=$(mktemp)
drill_start=$(date +%s)
if compose run --rm -T ops scripts/ops/restore-drill.sh 2>&1 | tee "$drill_log"; then
  drill_status=PASS
else
  drill_status=FAIL
  verdict=FAIL
fi
drill_secs=$(($(date +%s) - drill_start))
[ "$drill_secs" -le $((RTO_MIN * 60)) ] || verdict=FAIL

echo "== newest backup (RPO)"
newest=$(find "$BACKUPS" -maxdepth 1 -name 'arc-db-*.dump.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 || true)
if [ -n "$newest" ]; then
  age_h=$(awk -v t="${newest%% *}" -v now="$(date +%s)" 'BEGIN { printf "%.1f", (now - t) / 3600 }')
  newest_file=$(basename "${newest#* }")
  rpo_status=$(awk -v a="$age_h" -v l="$RPO_H" 'BEGIN { print (a <= l) ? "PASS" : "FAIL" }')
else
  age_h="n/a"
  newest_file="none in $BACKUPS — schedule the nightly backup (docs/operations.md)"
  rpo_status=FAIL
fi
[ "$rpo_status" = PASS ] || verdict=FAIL
echo "$newest_file ($age_h h old)"

bench_section="Skipped (--drill-only)."
if [ "$DRILL_ONLY" = 0 ]; then
  echo "== load test ($REQUESTS requests, concurrency $CONCURRENCY)"
  bench_json="vps-bench-$stamp.json"
  if compose run --rm -T bench node --import tsx bench/run.ts --gate --requests "$REQUESTS" \
    --concurrency "$CONCURRENCY" --out "/reports/$bench_json" 2>&1 | tee "$REPORTS/vps-bench-$stamp.log"; then
    bench_status=PASS
  else
    bench_status=FAIL
    verdict=FAIL
  fi
  bench_section="**$bench_status** (gate: ARC overhead p95 ≤ 30 ms, errors ≤ 1 %). Output: \`$(basename "$REPORTS")/vps-bench-$stamp.log\`, data: \`$bench_json\`.

\`\`\`
$(grep -E '^\||regression gate' "$REPORTS/vps-bench-$stamp.log" | head -40 || true)
\`\`\`"
fi

cat > "$report" <<EOF
# ARC server verification — $stamp

Host: $(hostname) · $(nproc) vCPU · $(free -g 2>/dev/null | awk '/Mem:/ {print $2 " GB RAM"}') · $(uname -m) · commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)

**Overall: $verdict**

| Check | Target | Measured | Result |
| --- | --- | --- | --- |
| Restore drill (backup → restore → verify credentials decrypt) | completes | $(tail -1 "$drill_log" | tr '|' '/') | $drill_status |
| RTO — restore time on this server | ≤ $RTO_MIN min | $((drill_secs / 60)) min $((drill_secs % 60)) s | $([ "$drill_secs" -le $((RTO_MIN * 60)) ] && echo PASS || echo FAIL) |
| RPO — age of newest backup | ≤ $RPO_H h | $age_h h ($newest_file) | $rpo_status |

The restore time covers backup, restore and verification of the database on a running server.
A full rebuild (new VM, Docker, checkout, secrets) adds to it: rehearse that once and note it here.

## Load test

$bench_section
EOF
rm -f "$drill_log"
echo
echo "Report: $report"
echo "Overall: $verdict"
[ "$verdict" = PASS ]
