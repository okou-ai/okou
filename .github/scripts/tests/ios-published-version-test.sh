#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
node --test "$root/.github/scripts/tests/ios-published-version.test.mjs"
