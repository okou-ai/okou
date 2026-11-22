#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workflows-chat-list-entry.png \
  workflows-phone-list.png workflows-phone-instructions.png workflows-phone-edit.png \
  workflows-phone-automations.png workflows-phone-history.png \
  workflows-phone-draft.png workflows-wide-automations.png workflows-short-large-text.png
