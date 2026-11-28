#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-chat-saving.png 02-chat-rename-failed.png 03-project-saving.png 04-project-rename-failed.png
