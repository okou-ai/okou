#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script=${CHANGED_SCRIPT:-$repo_root/scripts/changed.sh}
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
repo="$test_dir/repo"
mkdir -p "$repo/turbo" "$test_dir/bin" "$test_dir/scratch"

fail() { echo "FAIL: $*" >&2; exit 1; }

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
printf 'base\n' >"$repo/turbo/phase"
cat >"$repo/turbo/result.json" <<'JSON'
{"tasks":[{"task":"build","taskId":"stable#build","hash":"a"},{"task":"build","taskId":"changed#build","hash":"b"}]}
JSON
git -C "$repo" add .
git -C "$repo" commit -qm base
base=$(git -C "$repo" rev-parse HEAD)
printf 'current\n' >"$repo/turbo/phase"
cat >"$repo/turbo/result.json" <<'JSON'
{"tasks":[{"task":"build","taskId":"stable#build","hash":"a"},{"task":"build","taskId":"changed#build","hash":"c"},{"task":"build","taskId":"new#build","hash":"d"},{"task":"generate","taskId":"new#generate","hash":"e"}]}
JSON
git -C "$repo" add .
git -C "$repo" commit -qm current

cat >"$test_dir/bin/npx" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == '-y turbo@^2.5.6 run build --dry=json' ]] || exit 99
phase=$(cat phase)
if [[ "$phase" != "$STUB_PHASE" ]]; then
  cat result.json
  exit 0
fi
case "$STUB_MODE" in
  success) echo 'harmless tool warning' >&2; cat result.json ;;
  failure)
    echo '{"environmentVariables":{"value":"stdout-private-fixture"}}'
    echo "npm error ETEST: unable to resolve Turbo for $phase" >&2
    printf 'token value: %s\n' "$HASH_TEST_TOKEN" >&2
    echo '_authToken=synthetic-npm-credential' >&2
    echo 'Authorization: Bearer synthetic-auth-credential' >&2
    echo 'fetch https://synthetic-user:synthetic-pass@registry.example.invalid/turbo?credential=synthetic-query-credential' >&2
    printf 'database value: %s\n' "$HASH_TEST_DATABASE_URL" >&2
    printf '\033[31m::error::untrusted annotation\033[0m\n' >&2
    exit "$STUB_STATUS" ;;
  stdout-only) echo 'stdout-private-fixture'; exit "$STUB_STATUS" ;;
  large)
    for ((i=0; i<1000; i++)); do
      printf 'ETEST line %s %s\n' "$i" "$HASH_TEST_TOKEN" >&2
    done
    exit "$STUB_STATUS" ;;
  malformed) echo 'not json' ;;
  empty) : ;;
  null) echo null ;;
  no-tasks) echo '{}' ;;
  no-builds) echo '{"tasks":[]}' ;;
  invalid-task) echo '{"tasks":[{"task":"build","taskId":"broken","hash":"a"}]}' ;;
  invalid-hash) echo '{"tasks":[{"task":"build","taskId":"broken#build","hash":null}]}' ;;
  partial) echo '{"tasks":[{"task":"build","taskId":"ok#build","hash":"a"},{"task":"build","taskId":"broken#build","hash":""}]}' ;;
  missing-task) echo '{"tasks":[{"task":"build","taskId":"ok#build","hash":"a"},{"taskId":"broken#build","hash":"b"}]}' ;;
  duplicate) echo '{"tasks":[{"task":"build","taskId":"ok#build","hash":"a"},{"task":"build","taskId":"ok#build","hash":"b"}]}' ;;
  trailing) cat result.json; echo 'not json' ;;
  multiple) cat result.json result.json ;;
  *) exit 98 ;;
esac
STUB
chmod +x "$test_dir/bin/npx"

run_case() {
  local mode=$1 phase=$2 expected=$3 status=0
  (
    cd "$repo"
    PATH="$test_dir/bin:$PATH" TMPDIR="$test_dir/scratch" \
      STUB_MODE="$mode" STUB_PHASE="$phase" STUB_STATUS="$expected" \
      HASH_TEST_TOKEN=synthetic-environment-credential \
      HASH_TEST_DATABASE_URL=postgres://synthetic-db-user:synthetic-db-password@database.example.invalid/db \
      bash "$script" "$base"
  ) >"$test_dir/stdout" 2>"$test_dir/stderr" || status=$?
  [[ "$status" == "$expected" ]] || fail "$mode/$phase: expected $expected, got $status"
  if [[ "$expected" != 0 ]]; then
    [[ ! -s "$test_dir/stdout" ]] || fail "$mode/$phase: failure emitted a JSON result"
    grep -q "$phase hash calculation" "$test_dir/stderr" || fail "$mode/$phase: missing failure context"
  fi
  [[ $(git -C "$repo" worktree list --porcelain | grep -c '^worktree ') == 1 ]] || fail "$mode/$phase: leaked worktree registration"
  [[ -z $(ls -A "$test_dir/scratch") ]] || fail "$mode/$phase: leaked temporary output"
}

run_case success current 0
jq -se 'length == 1 and .[0] == {stable: false, changed: true, new: true}' "$test_dir/stdout" >/dev/null || fail 'incorrect success comparison'

for phase in current base; do
  run_case failure "$phase" 37
  grep -q 'npm error ETEST: unable to resolve Turbo' "$test_dir/stderr" || fail 'missing actionable stderr'
  if grep -Eq 'stdout-private-fixture|synthetic-(environment|npm|auth|query)-credential|synthetic-user|synthetic-pass|synthetic-db-' "$test_dir/stderr"; then
    fail 'diagnostics exposed credentials or raw stdout'
  fi
  grep -q '^  | ::error::untrusted annotation' "$test_dir/stderr" || fail 'tool output was not rendered as inert text'
  run_case stdout-only "$phase" 43
  grep -q 'No complete stderr diagnostics available' "$test_dir/stderr" || fail 'missing stderr availability'
  ! grep -q 'stdout-private-fixture' "$test_dir/stderr" || fail 'stdout-only failure exposed raw output'
  for mode in malformed empty null no-tasks no-builds invalid-task invalid-hash partial missing-task duplicate trailing multiple; do
    run_case "$mode" "$phase" 2
    grep -q 'Invalid or empty Turbo build-task JSON' "$test_dir/stderr" || fail "$mode/$phase: missing validation error"
  done
done

run_case large base 45
[[ $(wc -c <"$test_dir/stderr") -lt 11000 ]] || fail 'diagnostics exceed the output bound'
! grep -q 'synthetic-environment-credential' "$test_dir/stderr" || fail 'large diagnostics exposed credentials'

# Even a broken diagnostic runtime must preserve the external command's status.
printf '#!/usr/bin/env bash\nexit 97\n' >"$test_dir/bin/node"
chmod +x "$test_dir/bin/node"
run_case failure base 51
grep -q 'Diagnostic formatting unavailable' "$test_dir/stderr" || fail 'missing formatter failure notice'

echo 'changed-test: ok'
