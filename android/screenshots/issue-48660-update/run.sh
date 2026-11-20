#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  details-checking.png details-check-failed.png details-up-to-date.png \
  toolbar-available.png settings-available.png details-available.png \
  toolbar-progress.png details-progress.png settings-progress.png \
  install-permission.png android-installer.png toolbar-ready.png settings-ready.png update-required.png
