#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connectors-discover.png phone-connectors-connected.png \
  phone-connector-code-checking.png wide-connector-code-rejected.png
