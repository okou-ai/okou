#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  artifact-catalog-loading-phone.png artifact-catalog-phone.png \
  artifact-website-loading-wide.png artifact-website-failed-wide.png artifact-document-wide.png \
  artifact-website-ready-wide.png
