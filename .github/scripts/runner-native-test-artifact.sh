#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/runner-image-target.sh
source "$SCRIPT_DIR/runner-image-target.sh"

fail() {
  echo "::error::Native test artifact: $*" >&2
  exit 1
}

for name in TARGET_TRIPLE TEST_NAME ARTIFACT_DIR GITHUB_REPOSITORY GITHUB_SHA \
  GITHUB_RUN_ID PRODUCER_ATTEMPT; do
  [ -n "${!name:-}" ] || fail "missing required env: $name"
done
runner_image_validate_target "$TARGET_TRIPLE"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "invalid source SHA"
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$PRODUCER_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "invalid producer identity"
case "$TEST_NAME" in
  host_cpu_fairness) profile=release; profile_args=(--release) ;;
  guest_rpc) profile=ci; profile_args=(--profile ci) ;;
  *) fail "unsupported integration test: $TEST_NAME" ;;
esac

case "${1:-}" in
  build)
    [[ ! -e "$ARTIFACT_DIR" && ! -L "$ARTIFACT_DIR" ]] || fail "artifact directory already exists"
    mkdir -p "$ARTIFACT_DIR"
    cargo_output=$(mktemp)
    trap 'rm -f "$cargo_output"' EXIT
    (
      cd "$SCRIPT_DIR/../../crates"
      cargo test --no-run "${profile_args[@]}" --target "$TARGET_TRIPLE" \
        -p sandbox-firecracker --test "$TEST_NAME" --message-format=json-render-diagnostics
    ) >"$cargo_output"
    test_bin=$(jq -ers --arg test "$TEST_NAME" '
      [.[] | select(.reason == "compiler-artifact" and .target.name == $test
        and .target.kind == ["test"] and .profile.test == true)
        | .executable | select(. != null)]
      | if length == 1 then .[0] else error("expected exactly one test executable") end
    ' "$cargo_output")
    [[ -s "$test_bin" && -x "$test_bin" ]] || fail "missing compiled executable"
    cp -- "$test_bin" "$ARTIFACT_DIR/test-bin"
    digest=$(sha256sum "$ARTIFACT_DIR/test-bin" | cut -d ' ' -f 1)
    jq -n --arg repository "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" \
      --arg run "$GITHUB_RUN_ID" --arg attempt "$PRODUCER_ATTEMPT" \
      --arg target "$TARGET_TRIPLE" --arg test "$TEST_NAME" --arg profile "$profile" \
      --arg digest "$digest" \
      '{version: 1, repository: $repository, sha: $sha, run: $run, attempt: $attempt,
        target: $target, test: $test, profile: $profile, sha256: $digest}' \
      >"$ARTIFACT_DIR/manifest.json"
    echo "producer-attempt=$PRODUCER_ATTEMPT" >>"${GITHUB_OUTPUT:?}"
    ;;
  validate)
    for file in manifest.json test-bin; do
      [[ -f "$ARTIFACT_DIR/$file" && -s "$ARTIFACT_DIR/$file" && \
        ! -L "$ARTIFACT_DIR/$file" ]] || fail "missing or invalid $file"
    done
    # Failed-job-only reruns retain their successful producer's attempt output.
    # Never compare the manifest with the consumer's current run_attempt.
    jq -e --arg repository "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" \
      --arg run "$GITHUB_RUN_ID" --arg attempt "$PRODUCER_ATTEMPT" \
      --arg target "$TARGET_TRIPLE" --arg test "$TEST_NAME" --arg profile "$profile" '
      .version == 1 and .repository == $repository and .sha == $sha
        and .run == $run and .attempt == $attempt and .target == $target
        and .test == $test and .profile == $profile
        and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    ' "$ARTIFACT_DIR/manifest.json" >/dev/null || fail "producer identity mismatch"
    digest=$(sha256sum "$ARTIFACT_DIR/test-bin" | cut -d ' ' -f 1)
    [ "$digest" = "$(jq -r .sha256 "$ARTIFACT_DIR/manifest.json")" ] || fail "binary checksum mismatch"
    chmod 755 "$ARTIFACT_DIR/test-bin"
    echo "TEST_BIN=$ARTIFACT_DIR/test-bin" >>"${GITHUB_ENV:?}"
    ;;
  *) fail "expected build or validate" ;;
esac
