#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  00-tools-entry.png 01-directory.png 02-image-model-picker.png 03-image-generation-disabled.png 04-image-model-save-failed.png
