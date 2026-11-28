#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-directory.png phone-automations.png wide-workflows.png \
  short-directory.png short-detail-edit.png short-editor-feedback.png short-editor-actions.png
