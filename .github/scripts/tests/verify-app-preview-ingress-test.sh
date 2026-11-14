#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
node --test "${repo_root}/.github/scripts/__tests__/verify-app-preview-ingress.test.mjs"
