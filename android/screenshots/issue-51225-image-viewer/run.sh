#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  artifact-image-phone-fit.png artifact-image-phone-zoomed.png \
  artifact-image-wide-pane.png artifact-image-wide-expanded.png
