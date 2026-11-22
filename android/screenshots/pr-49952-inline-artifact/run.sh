#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    chat-artifact-card.png chat-inline-artifact-preview.png chat-artifact-card-wide.png
