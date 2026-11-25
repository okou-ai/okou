#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" catalog-today-phone.png catalog-yesterday-phone.png catalog-preview-yesterday-wide.png
