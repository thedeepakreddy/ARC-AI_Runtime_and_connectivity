#!/usr/bin/env bash
# Full-stack smoke test: builds and starts the real Compose stack (Postgres, Redis, LiteLLM, API,
# worker, Prometheus, Alertmanager) in an isolated project, then checks it end to end:
#
#   1. /healthz and /readyz
#   2. the owner, a provider key (a stand-in provider) and two first-party apps with separate
#      ARC keys, all created through the admin API (scripts/ops/arc-admin.mjs)
#   3. for each app key: /v1/models, chat (JSON, streaming, tool call, JSON mode), embeddings,
#      and that an unknown key is refused
#   4. Prometheus scrapes the API and worker, and an alert reaches the inbox as an email
#   5. optional: the apps' own smoke scripts against this ARC (ECHO_DIR, DSS_DIR)
#
# Your own .env and secrets/ are never touched: everything lives in a temp dir and a separate
# Compose project, removed at the end (KEEP=1 keeps it running for inspection).
#
# Usage: scripts/ops/stack-smoke.sh
# Env:   SMOKE_PROJECT (arc-smoke), SMOKE_PORT (18080), KEEP, ECHO_DIR, DSS_DIR, SMOKE_SKIP_BUILD=1
#        (use already-built arc-api:local and arc-worker:local images),
#        SMOKE_KEYS_OUT (write the issued app keys to this file, for running app smokes by hand),
#        SMOKE_WORK_DIR (use this directory for the temp .env and secrets; kept with KEEP=1)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PROJECT=${SMOKE_PROJECT:-arc-smoke}
PORT=${SMOKE_PORT:-18080}
ARC_URL="http://127.0.0.1:${PORT}"
WORK=${SMOKE_WORK_DIR:-$(mktemp -d)}
mkdir -p "$WORK/secrets"
chmod 755 "$WORK" "$WORK/secrets"

step() { printf '\n== %s\n' "$*"; }
die() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
rand() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))'; }

cat > "$WORK/.env" <<EOF
POSTGRES_USER=arc
POSTGRES_PASSWORD=$(rand)
POSTGRES_DB=arc
LITELLM_MASTER_KEY=sk-$(rand)
LITELLM_NUM_WORKERS=2
LOG_LEVEL=warn
COOKIE_SECURE=false
ARC_HTTP_PORT=${PORT}
ARC_SECRETS_DIR=${WORK}/secrets
ALERT_EMAIL_TO=owner@example.test
ALERT_EMAIL_FROM=arc@example.test
ALERT_SMTP_HOST=mailpit:1025
ALERT_SMTP_USER=arc@example.test
ALERT_SMTP_REQUIRE_TLS=false
EOF

compose() {
  docker compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$WORK/.env" \
    -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.smoke.yml" --profile monitoring "$@"
}
# HTTP from inside the private network (Prometheus, Alertmanager and Mailpit are not published).
inside() { compose exec -T api node --input-type=module -e "$1"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- recent logs (failure) ---" >&2
    compose logs --tail 40 api worker litellm alertmanager >&2 2>/dev/null || true
  fi
  if [ "${KEEP:-}" = "1" ]; then
    echo "KEEP=1: stack left running (project $PROJECT, env $WORK/.env)"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

step "build images"
if [ "${SMOKE_SKIP_BUILD:-}" = "1" ]; then echo "  using existing arc-api:local / arc-worker:local"; else compose build api worker >/dev/null; fi

step "vault key and SMTP password (temp dir only)"
compose run --rm --no-deps -T api node dist/cli/vault-keygen.js > "$WORK/secrets/vault-keys.json"
printf 'smoke-smtp-password\n' > "$WORK/secrets/smtp-password"
if [ "$(id -u)" = "0" ]; then
  chown 1000:1000 "$WORK/secrets/vault-keys.json" && chmod 640 "$WORK/secrets/vault-keys.json"
  chown 65534 "$WORK/secrets/smtp-password" && chmod 600 "$WORK/secrets/smtp-password"
else
  chmod 644 "$WORK/secrets/vault-keys.json" "$WORK/secrets/smtp-password"
fi

step "start the stack"
compose up -d --wait --wait-timeout 300

step "health"
curl -fsS "$ARC_URL/healthz" | grep -q '"ok"\|"status"' || die "/healthz"
ready=$(curl -sS "$ARC_URL/readyz")
echo "$ready"
echo "$ready" | grep -q '"postgres":{"ok":true' || echo "$ready" | grep -q 'ready' || die "/readyz: $ready"

console_headers=$(curl -fsS -D - -o /dev/null "$ARC_URL/console/providers")
echo "$console_headers" | grep -qi "content-security-policy: default-src 'self'" || die "console not served with its CSP"
echo "  ok: console served at /console"

step "owner, provider key, models, apps"
export ARC_URL ARC_OWNER_EMAIL=owner@example.test ARC_OWNER_PASSWORD
ARC_OWNER_PASSWORD="smoke-$(rand)"
compose exec -T -e ARC_OWNER_EMAIL -e ARC_OWNER_PASSWORD api node dist/cli/create-owner.js
admin() { node "$ROOT/scripts/ops/arc-admin.mjs" "$@"; }
PROVIDER_API_KEY=smoke-provider-key admin add-provider-key --provider llama-cpp --label smoke \
  --base-url http://mock-provider:9000/v1 | tee "$WORK/account.json" | grep -q '"healthy"' ||
  die "provider key did not validate"
admin enable-model --provider llama-cpp --model mock-chat --eligibility VERIFIED_FREE \
  --evidence https://example.test/smoke-terms --capabilities text,streaming,tools,structured_output >/dev/null
admin enable-model --provider llama-cpp --model mock-embed --eligibility VERIFIED_FREE \
  --evidence https://example.test/smoke-terms --capabilities embeddings >/dev/null
ECHO_KEY=$(admin app-key --name "Echo Phone" --slug echo-phone --key-only)
DSS_KEY=$(admin app-key --name "Data Science Studio" --slug data-science-studio --key-only)
[ "$ECHO_KEY" != "$DSS_KEY" ] || die "apps must get separate keys"
if [ -n "${SMOKE_KEYS_OUT:-}" ]; then
  printf 'ARC_BASE_URL=%s/v1\nECHO_ARC_API_KEY=%s\nDSS_ARC_API_KEY=%s\n' "$ARC_URL" "$ECHO_KEY" "$DSS_KEY" > "$SMOKE_KEYS_OUT"
fi

v1() { # v1 <key> <path> [json-body] → prints body; fails on non-2xx
  local key=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -H "authorization: Bearer $key" -H 'content-type: application/json' -d "$body" "$ARC_URL/v1$path"
  else
    curl -fsS -H "authorization: Bearer $key" "$ARC_URL/v1$path"
  fi
}

for app in echo-phone data-science-studio; do
  key=$ECHO_KEY
  [ "$app" = "data-science-studio" ] && key=$DSS_KEY
  step "inference as $app"
  v1 "$key" /models | grep -q 'llama-cpp/mock-chat' || die "$app: /v1/models"
  v1 "$key" /chat/completions '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' |
    grep -q 'smoke-test provider' || die "$app: chat"
  v1 "$key" /chat/completions '{"model":"auto","stream":true,"messages":[{"role":"user","content":"hi"}]}' |
    grep -q '\[DONE\]' || die "$app: streaming"
  v1 "$key" /chat/completions '{"model":"auto","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"required"}' |
    grep -q '"get_weather"' || die "$app: tool call"
  v1 "$key" /chat/completions '{"model":"auto","response_format":{"type":"json_object"},"messages":[{"role":"user","content":"json"}]}' |
    grep -q 'mock-provider' || die "$app: JSON mode"
  v1 "$key" /embeddings '{"model":"llama-cpp/mock-embed","input":["a","b"],"dimensions":512}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.data.length===2&&j.data[0].embedding.length>0?0:1)})' ||
    die "$app: embeddings"
  hdr=$(curl -sS -o /dev/null -D - -H "authorization: Bearer $key" -H 'content-type: application/json' \
    -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' "$ARC_URL/v1/chat/completions")
  echo "$hdr" | grep -qi '^x-arc-route-provider: llama-cpp' || die "$app: route headers"
  echo "  ok: models, chat, stream, tools, JSON mode, embeddings, route headers"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer ${ECHO_KEY%?}0" "$ARC_URL/v1/models")
[ "$code" = "401" ] || die "a wrong key must get 401 (got $code)"

step "monitoring: Prometheus targets"
targets_ok=0
for _ in $(seq 1 30); do
  if inside 'const r=await fetch("http://prometheus:9090/api/v1/targets").then(r=>r.json());const t=r.data.activeTargets;if(t.length<2||t.some(x=>x.health!=="up"))process.exit(1)' 2>/dev/null; then
    targets_ok=1
    break
  fi
  sleep 2
done
[ "$targets_ok" = 1 ] || die "Prometheus is not scraping the API and worker"
inside 'const r=await fetch("http://prometheus:9090/api/v1/alertmanagers").then(r=>r.json());if(!r.data.activeAlertmanagers.length)process.exit(1)' ||
  die "Prometheus has no Alertmanager"
curl -fsS -m 5 http://127.0.0.1:9090/-/ready >/dev/null || die "Prometheus UI is not reachable on 127.0.0.1:9090"
curl -fsS -m 5 http://127.0.0.1:9093/-/ready >/dev/null || die "Alertmanager UI is not reachable on 127.0.0.1:9093"
echo "  ok: api and worker scraped; Alertmanager connected; both UIs on the host loopback"

step "alert email (Alertmanager → SMTP)"
inside 'const r=await fetch("http://alertmanager:9093/api/v2/alerts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify([{labels:{alertname:"ArcSmokeTest",severity:"info"},annotations:{summary:"stack smoke test"}}])});if(!r.ok)process.exit(1)' ||
  die "Alertmanager rejected the test alert"
mail_ok=0
for _ in $(seq 1 45); do
  if inside 'const r=await fetch("http://mailpit:8025/api/v1/messages").then(r=>r.json());const m=(r.messages||[]).find(m=>/ArcSmokeTest/.test(m.Subject)&&m.To.some(t=>t.Address==="owner@example.test"));if(!m)process.exit(1);console.log("  email: "+m.Subject)'; then
    mail_ok=1
    break
  fi
  sleep 2
done
[ "$mail_ok" = 1 ] || die "the alert email never arrived"

app_failures=0
if [ -n "${ECHO_DIR:-}" ]; then
  step "Echo Phone smoke against this ARC"
  # The stand-in provider's embedding model (in production Echo pins gemini/gemini-embedding-001).
  (cd "$ECHO_DIR" && ARC_BASE_URL="$ARC_URL/v1" ARC_API_KEY="$ECHO_KEY" ARC_EMBED_MODEL=llama-cpp/mock-embed \
    node scripts/arc-smoke.mjs) || app_failures=$((app_failures + 1))
fi
if [ -n "${DSS_DIR:-}" ]; then
  step "Data Science Studio smoke against this ARC"
  (cd "$DSS_DIR" && ARC_BASE_URL="$ARC_URL/v1" ARC_API_KEY="$DSS_KEY" npx tsx scripts/arc-smoke.ts) ||
    app_failures=$((app_failures + 1))
fi
[ "$app_failures" = 0 ] || die "$app_failures app smoke test(s) failed"

step "PASS: full stack verified end to end"
