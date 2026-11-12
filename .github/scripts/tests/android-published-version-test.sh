#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
node --test "$root/.github/scripts/tests/android-published-version.test.mjs"
