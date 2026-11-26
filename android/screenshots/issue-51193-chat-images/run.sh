#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  chat-image-before-sleep.png chat-image-after-wake.png chat-image-from-disk.png \
  sent-single-image.png sent-image-gallery.png
