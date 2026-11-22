#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    artifacts-chat-list-entry.png artifacts-catalog.png artifacts-search.png artifacts-preview.png artifacts-wide.png
