#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" image-loading-phone.png image-unavailable-phone.png image-loading-wide.png image-ready-wide.png
