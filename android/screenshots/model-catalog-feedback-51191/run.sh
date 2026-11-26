#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" 01-model-catalog-loaded.png 02-model-catalog-refresh-failed.png 03-settings-catalog-refresh-failed.png
