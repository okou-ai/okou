#!/usr/bin/env bash
set -euo pipefail

scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  00-inbox-running.png 01-filter-menu.png 02-unread-filter.png 03-read-all-complete.png 04-wide-archived.png \
  05-update-overflow.png
