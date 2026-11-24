#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  chat-rename-phone-rejected.png chat-rename-phone-unknown.png \
  project-rename-wide-rejected.png chat-delete-phone-rejected.png
