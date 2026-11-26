#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    attachment-options.png attachment-upload-failed.png attachment-draft.png \
    attachment-sending.png attachment-sent.png
