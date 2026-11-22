#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-chat-list.png offline-move-picker.png offline-undo.png recovered-undo.png partial-bulk-read.png chat-delete.png \
  project-delete-pending.png project-delete-offline.png wide-chat-list.png compact-project-delete.png
