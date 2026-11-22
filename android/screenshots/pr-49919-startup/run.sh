#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  startup-loading.png startup-cache.png startup-settings-preparing.png \
  startup-settings.png startup-settings-cache.png startup-synced.png
