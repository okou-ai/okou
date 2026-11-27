#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workflow-directory-phone.png workflow-detail-phone.png workflow-detail-wide.png \
  workflow-automation-wide.png workflow-editor-phone.png workflow-editor-wide.png
