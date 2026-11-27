#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" artifact-return-focus-phone.png artifact-return-focus-wide.png artifact-preview-phone.png artifact-preview-wide.png artifact-image-toolbar-phone.png artifact-image-toolbar-wide.png
