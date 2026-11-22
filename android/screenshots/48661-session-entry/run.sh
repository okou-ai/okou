#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  restoring.png preparing.png choose-workspace.png no-workspace.png \
  access-removed.png unavailable.png signing-out.png compact-dark.png
