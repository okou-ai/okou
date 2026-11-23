#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  preparing.png choose-workspace.png no-workspace.png \
  access-removed.png checking.png check-failed.png selection-failed.png unavailable.png sign-out-confirmation.png signing-out.png compact-dark.png
