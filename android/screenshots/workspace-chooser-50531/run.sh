#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  00-settings.png 01-workspace-chooser.png 02-workspace-switching.png 03-workspace-switch-failed.png
