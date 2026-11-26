#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connectors-discover.png phone-connectors-connected.png \
  wide-connectors-detail.png wide-connector-account.png \
  phone-connectors-first-read-failed.png phone-connectors-refresh-failed.png \
  phone-connector-permission-refresh.png phone-connector-permission-first-read-failed.png \
  phone-connector-accounts-first-read-failed.png phone-connector-accounts-recovered.png \
  wide-connector-accounts-refresh-failed.png
