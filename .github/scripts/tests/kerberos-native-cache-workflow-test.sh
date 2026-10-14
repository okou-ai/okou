#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
KERBEROS_CACHE_REPO_ROOT="$repo_root" yq -o=json -n '{
  "crates": load(strenv(KERBEROS_CACHE_REPO_ROOT) + "/.github/workflows/crates.yml"),
  "runner-architecture": load(strenv(KERBEROS_CACHE_REPO_ROOT) + "/.github/workflows/runner-image-architecture.yml"),
  "runner-image": load(strenv(KERBEROS_CACHE_REPO_ROOT) + "/.github/workflows/runner-image.yml"),
  "release": load(strenv(KERBEROS_CACHE_REPO_ROOT) + "/.github/workflows/release-please.yml")
}' | \
  python3 "$repo_root/.github/scripts/tests/kerberos-native-cache-workflow-test.py"
