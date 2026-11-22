#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  artifacts-catalog.png artifacts-search-return.png artifacts-preview.png \
  artifacts-preview-failed.png artifacts-wide.png
