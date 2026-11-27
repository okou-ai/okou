#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  artifact-thumbnail-original-phone.png artifact-thumbnail-pending-phone.png \
  artifact-thumbnail-replaced-phone.png artifact-thumbnail-pending-wide.png \
  artifact-thumbnail-replaced-wide.png
