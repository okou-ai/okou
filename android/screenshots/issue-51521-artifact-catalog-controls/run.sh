#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" artifact-catalog-phone.png artifact-catalog-wide.png artifact-empty-phone.png artifact-empty-wide.png
