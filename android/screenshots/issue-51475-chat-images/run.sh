#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-draft-image.png 02-short-draft-image.png 03-sent-image.png \
  04-image-unavailable.png 05-wide-image.png 06-share-access-lost.png
