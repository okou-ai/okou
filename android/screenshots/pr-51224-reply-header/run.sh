#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  00-queued.png 01-preparing.png 02-replying.png 03-reduced-motion.png 04-completed.png 05-reply-menu.png
