#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  checking-default-dark.png progress-default-dark.png required-progress-default-dark.png \
  checking-golden-hour-light.png progress-golden-hour-light.png required-progress-golden-hour-light.png
