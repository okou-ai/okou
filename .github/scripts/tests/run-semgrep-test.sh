#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_semgrep="$script_dir/checks/run-semgrep.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT

repo_dir="$test_dir/repo"
fake_bin="$test_dir/bin"
args_file="$test_dir/semgrep-args"
mkdir -p "$repo_dir" "$fake_bin"

cat > "$fake_bin/semgrep" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$SEMGREP_ARGS_FILE"
EOF
chmod +x "$fake_bin/semgrep"

git -C "$repo_dir" init --quiet
git -C "$repo_dir" config user.name "Semgrep Test"
git -C "$repo_dir" config user.email "semgrep-test@okou.ai"

printf 'base\n' > "$repo_dir/source.txt"
git -C "$repo_dir" add source.txt
git -C "$repo_dir" commit --quiet -m "base"
base_sha="$(git -C "$repo_dir" rev-parse HEAD)"

git -C "$repo_dir" switch --quiet -c feature
printf 'feature\n' >> "$repo_dir/source.txt"
git -C "$repo_dir" commit --quiet -am "feature"

git -C "$repo_dir" switch --quiet -
git -C "$repo_dir" merge --quiet --no-ff feature -m "merge feature"
pull_request_base="$(git -C "$repo_dir" rev-parse HEAD^1)"

read_baseline_argument() {
  awk '
    previous == "--baseline-commit" {
      print
      exit
    }
    {
      previous = $0
    }
  ' "$args_file"
}

(
  cd "$repo_dir"
  EVENT_NAME=pull_request \
    SEMGREP_ARGS_FILE="$args_file" \
    PATH="$fake_bin:$PATH" \
    sh "$run_semgrep"
)
test "$(read_baseline_argument)" = "$pull_request_base"

(
  cd "$repo_dir"
  EVENT_NAME=merge_group \
    MERGE_GROUP_BASE_SHA="$base_sha" \
    SEMGREP_ARGS_FILE="$args_file" \
    PATH="$fake_bin:$PATH" \
    sh "$run_semgrep"
)
test "$(read_baseline_argument)" = "$base_sha"

(
  cd "$repo_dir"
  EVENT_NAME=push \
    SEMGREP_ARGS_FILE="$args_file" \
    PATH="$fake_bin:$PATH" \
    sh "$run_semgrep"
)
if grep -Fqx -- "--baseline-commit" "$args_file"; then
  echo "push scans must not use a baseline commit" >&2
  exit 1
fi

if (
  cd "$repo_dir"
  EVENT_NAME=merge_group \
    SEMGREP_ARGS_FILE="$args_file" \
    PATH="$fake_bin:$PATH" \
    sh "$run_semgrep"
); then
  echo "merge_group scans must require a base SHA" >&2
  exit 1
fi

if (
  cd "$repo_dir"
  EVENT_NAME=workflow_dispatch \
    SEMGREP_ARGS_FILE="$args_file" \
    PATH="$fake_bin:$PATH" \
    sh "$run_semgrep"
); then
  echo "unsupported events must fail" >&2
  exit 1
fi

echo "run-semgrep tests passed"
