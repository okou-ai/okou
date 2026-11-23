#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  intermediate-connector-long-permissions.png wide-connector-permissions-panel.png \
  short-connector-authorization-panel.png
