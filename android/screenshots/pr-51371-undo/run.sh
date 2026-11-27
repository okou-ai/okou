#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-archive-undo.png phone-archive-restored.png phone-archive-rollback.png \
  wide-unread-undo.png wide-unread-restored.png
