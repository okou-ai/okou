#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  move-menu.png conversation-move-menu.png move-destination.png moved-chat.png \
  project-delete.png deletion-awaiting-chat-readback.png regrouped-chats.png \
  move-reconciled-after-delete.png \
  late-move-after-deletion.png
