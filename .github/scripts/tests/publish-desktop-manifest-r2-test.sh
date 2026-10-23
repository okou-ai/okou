#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --test "$script_dir/desktop-manifest-r2-publication.test.mjs"
