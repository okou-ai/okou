#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  proactive-entry.png proactive-loading.png proactive-normal.png proactive-partial.png \
  proactive-choices.png proactive-enabled.png proactive-rollback.png \
  proactive-timezone.png proactive-dark-large-type.png
