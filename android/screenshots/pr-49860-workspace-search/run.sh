#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    search-recent.png search-grouped.png search-empty.png search-message.png \
    search-workflow.png search-draft.png search-artifact.png search-offline.png search-wide.png
