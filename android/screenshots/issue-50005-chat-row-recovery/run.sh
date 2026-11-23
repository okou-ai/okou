#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  filtered-pin-menu.png filtered-pin-reordered.png archive-retry-pending.png archive-rollback.png \
  archive-awaiting-confirmation.png archive-confirmed-on-another-device.png \
  read-awaiting-confirmation.png unread-after-confirmation.png
