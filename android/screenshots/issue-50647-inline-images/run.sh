#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-inline-image.png 02-image-pressed.png 03-original-preview.png \
    04-earlier-reply.png 05-image-states.png 06-table-large-text.png
