#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  unread-loading.png unread-retrying.png unread-recovered.png \
  chat-list-retained-dependencies.png project-expansion-save-unavailable.png
