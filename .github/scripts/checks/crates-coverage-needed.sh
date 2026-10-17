#!/usr/bin/env bash
# Usage: bash crates-coverage-needed.sh <base-ref>
# Compare the supplied commit with HEAD from any working directory. Requires
# Git; prints true/false on success and exits nonzero on invalid input/diff.
# Keep generic CI/native selection separate from full workspace coverage.
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "usage: crates-coverage-needed.sh <base-ref>" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
base=$(git -C "$repo_root" rev-parse --verify --end-of-options "${1}^{commit}")
changed_files=$(mktemp)
trap 'rm -f "$changed_files"' EXIT
# Include both sides of renames; retain whitespace/newlines in Git paths.
git -C "$repo_root" diff --no-renames --name-only -z "$base" HEAD -- > "$changed_files"

coverage_needed=false
while IFS= read -r -d '' path; do
  case "$path" in
    # These exact tests validate web/browser workflows and run independently
    # in Security's workflow-script shards. No directory-wide test exemption:
    # unknown or newly shared scripts must still require coverage.
    .github/scripts/tests/clerk-test-resource-workflow-test.sh | \
    .github/scripts/tests/app-preview-ingress-workflow-test.sh | \
    .github/scripts/tests/turbo-playwright-runner-workflow-test.sh)
      continue
      ;;
    crates/* | rust-toolchain | rust-toolchain.toml | .cargo/* | \
    docker/toolchain/* | scripts/crate-changed.sh | \
    .github/workflows/crates.yml | .github/workflows/runner-image.yml | \
    .github/workflows/runner-image-architecture.yml | \
    .github/actions/setup-aws-cli/* | .github/actions/setup-r2-sccache/* | \
    .github/actions/setup-ssh-tunnel/* | .github/actions/provision/* | \
    .github/actions/report-memory-peak/* | .github/scripts/* | ansible/*)
      coverage_needed=true
      break
      ;;
  esac
done < "$changed_files"

printf '%s\n' "$coverage_needed"
