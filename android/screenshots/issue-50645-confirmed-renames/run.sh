#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    phone-chat-saving.png phone-chat-confirmed.png \
    wide-project-saving.png wide-project-confirmed.png wide-project-rejected.png
