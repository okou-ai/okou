#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" catalog-phone.png preview-wide.png unavailable-phone.png video-phone.png chat-preview-phone.png
