#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-pr-title.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_GH_LOG"

pr_number=""
previous=""
for argument in "$@"; do
  case "$previous" in
    view) pr_number=$argument ;;
  esac
  previous=$argument
done

case "$pr_number" in
  7) printf '\n' ;;
  *) printf 'feat(api): title from the api for pr %s\n' "$pr_number" ;;
esac
SH
chmod +x "${fake_bin}/gh"

run_resolve() {
  MOCK_GH_LOG="${tmp_dir}/gh.log" PATH="${fake_bin}:$PATH" "$@" bash "$script"
}

reset_log() {
  : >"${tmp_dir}/gh.log"
}

# pull_request resolves through the API using the event's PR number.
reset_log
output="$(run_resolve env EVENT_NAME=pull_request PR_NUMBER=42 REPO=okou-ai/okou)"
[ "$output" = "feat(api): title from the api for pr 42" ] ||
  fail "pull_request should resolve the title from the api, got: $output"
grep -q 'pr view 42 --repo okou-ai/okou --json title --jq .title' "${tmp_dir}/gh.log" ||
  fail "pull_request should call gh pr view with the event pr number"

# Regression guard: a stale payload title must never win over the live title.
# This is the whole point of the check; a revert to a payload read fails here.
reset_log
output="$(run_resolve env EVENT_NAME=pull_request PR_NUMBER=42 REPO=okou-ai/okou \
  PR_TITLE="feat(api): Stale Title From The Event Payload")"
[ "$output" = "feat(api): title from the api for pr 42" ] ||
  fail "pull_request must ignore a payload title, got: $output"

# merge_group resolves the pr number out of the queue ref.
reset_log
output="$(run_resolve env EVENT_NAME=merge_group REPO=okou-ai/okou \
  MQ_HEAD_REF=gh-readonly-queue/main/pr-99-0123456789abcdef)"
[ "$output" = "feat(api): title from the api for pr 99" ] ||
  fail "merge_group should resolve the title for the queued pr, got: $output"
grep -q 'pr view 99 ' "${tmp_dir}/gh.log" ||
  fail "merge_group should call gh pr view with the queued pr number"

# Events without a pull request produce no title and no api call.
reset_log
output="$(run_resolve env EVENT_NAME=push REPO=okou-ai/okou)"
[ -z "$output" ] || fail "push should resolve no title, got: $output"
[ ! -s "${tmp_dir}/gh.log" ] || fail "push should not call gh"

# A pull_request event without a number fails instead of validating nothing.
reset_log
if run_resolve env EVENT_NAME=pull_request PR_NUMBER= REPO=okou-ai/okou >/dev/null 2>&1; then
  fail "pull_request without a pr number should fail"
fi

# An unparseable merge queue ref fails instead of validating nothing.
reset_log
if run_resolve env EVENT_NAME=merge_group REPO=okou-ai/okou \
  MQ_HEAD_REF=refs/heads/main >/dev/null 2>&1; then
  fail "merge_group with an unparseable ref should fail"
fi

# An empty resolved title fails instead of being read as "nothing to validate".
reset_log
if run_resolve env EVENT_NAME=pull_request PR_NUMBER=7 REPO=okou-ai/okou >/dev/null 2>&1; then
  fail "an empty resolved title should fail"
fi

echo "resolve-pr-title tests passed"
