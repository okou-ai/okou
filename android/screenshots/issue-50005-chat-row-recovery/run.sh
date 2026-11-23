#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  stale-chat-list-sync.png fresh-chat-list-sync.png \
  fresh-chat-list-retry.png chat-list-recovered.png first-chat-list-loading.png first-chat-list-retry.png \
  filtered-pin-menu.png filtered-pin-reordered.png archive-retry-pending.png archive-rollback.png \
  archive-awaiting-confirmation.png archive-after-inconclusive-refresh.png \
  archive-confirmed-on-another-device.png read-awaiting-confirmation.png \
  unread-after-confirmation.png conversation-undo-split.png conversation-undo-compact.png \
  project-delete-rejection-dialog.png project-delete-rejection-list.png
