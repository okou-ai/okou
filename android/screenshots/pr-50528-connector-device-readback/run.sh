#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-device-authorization-unconfirmed.png phone-device-authorization-denied.png \
  wide-device-authorization-unconfirmed.png wide-device-authorization-confirmed.png
