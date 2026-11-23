#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  chat-list-drafts-phone.png chat-list-drafts-wide.png chat-list-drafts-wide-keyboard.png
