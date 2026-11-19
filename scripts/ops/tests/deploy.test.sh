#!/usr/bin/env bash
# Tests deploy.sh decision logic with stub git/docker/curl/backup on PATH.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/../deploy.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

setup() {
  work="$(mktemp -d)"
  mkdir -p "$work/bin" "$work/ops"
  cp "$deploy" "$work/ops/deploy.sh"
  printf '#!/usr/bin/env bash\necho backup >> "%s/calls"\n' "$work" > "$work/ops/backup.sh"
  # git: clean tree, known ref, worktree no-ops
  cat > "$work/bin/git" <<STUB
#!/usr/bin/env bash
case "\$1" in
  status) exit 0 ;;
  fetch) exit 0 ;;
  rev-parse) echo "aaaaaaaaaaaabbbbbbbbbbbbccccccccccccdddd" ;;
  worktree) exit 0 ;;
esac
STUB
  cat > "$work/bin/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$* ARC_VERSION=\${ARC_VERSION:-}" >> "$work/calls"
STUB
  # curl succeeds unless the running version is listed in \$work/unhealthy
  cat > "$work/bin/curl" <<STUB
#!/usr/bin/env bash
current=\$(grep 'compose up' "$work/calls" | tail -1 | sed 's/.*ARC_VERSION=//')
grep -qx "\$current" "$work/unhealthy" 2>/dev/null && exit 22
exit 0
STUB
  chmod +x "$work/bin/"* "$work/ops/"*.sh
  touch "$work/calls" "$work/unhealthy"
  export PATH="$work/bin:$PATH" DEPLOY_STATE_FILE="$work/state" HEALTH_TIMEOUT_S=3
}

# Dry run builds but never rolls out or backs up
setup
"$work/ops/deploy.sh" main >/dev/null
grep -q 'docker build' "$work/calls" || fail "dry run should build"
grep -q 'compose up' "$work/calls" && fail "dry run must not roll out"
grep -q backup "$work/calls" && fail "dry run must not back up"
echo "ok - dry run validates and builds only"

# Approved + healthy: backup first, roll out, record version
setup
echo "oldversion01" > "$work/state"
"$work/ops/deploy.sh" main --approve >/dev/null
grep -q backup "$work/calls" || fail "should back up"
[[ "$(grep -n backup "$work/calls" | cut -d: -f1)" -lt "$(grep -n 'compose up' "$work/calls" | cut -d: -f1)" ]] || fail "backup must precede rollout"
[[ "$(cat "$work/state")" == "aaaaaaaaaaaa" ]] || fail "state should record new version"
echo "ok - approved healthy deploy backs up first and records the new version"

# Approved + unhealthy: automatic rollback to previous version, non-zero exit
setup
echo "oldversion01" > "$work/state"
echo "aaaaaaaaaaaa" > "$work/unhealthy"
if "$work/ops/deploy.sh" main --approve >/dev/null 2>&1; then fail "unhealthy deploy must fail"; fi
grep 'compose up' "$work/calls" | tail -1 | grep -q 'ARC_VERSION=oldversion01' || fail "should roll back to previous"
[[ "$(cat "$work/state")" == "oldversion01" ]] || fail "state must keep the previous version"
echo "ok - unhealthy deploy rolls back automatically and exits non-zero"
echo "all deploy tests passed"
