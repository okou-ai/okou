#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  filter-menu.png unread-collapsed.png unread-running.png bulk-read.png acknowledged-running.png
