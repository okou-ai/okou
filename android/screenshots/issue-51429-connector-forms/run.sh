#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connector-rename.png wide-connector-authorization.png \
  short-connector-rename.png short-connector-authorization.png
