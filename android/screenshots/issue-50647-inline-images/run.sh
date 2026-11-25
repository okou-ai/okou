#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-inline-image.png 02-image-pressed.png 03-original-preview.png \
    04-earlier-reply.png 05-image-states.png 06-table-large-text.png \
    07-actions-idle.png 08-work-summary-ripple.png 09-suggestion-ripple.png \
    10-revoked-thumbnail.png 11-activity-single-line.png \
    12-stop-in-toolbar.png 13-stop-pending.png
