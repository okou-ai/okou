#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  preparing-workspace.png workspace-unavailable.png sign-out-confirmation.png \
  workspace-after-rejected-sign-out.png workspace-recovered.png
