#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workflow-phone-loading.png workflow-phone-detail.png \
  workflow-wide-automations.png workflow-wide-pausing.png workflow-wide-editor.png
