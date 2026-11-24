#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  proactive-entry.png proactive-loading.png proactive-normal.png proactive-partial.png \
  proactive-choices.png proactive-enabled.png proactive-rollback.png \
  proactive-timezone.png proactive-timezone-picker.png proactive-timezone-return.png \
  proactive-timezone-rejected.png proactive-timezone-schedule-failed.png \
  proactive-timezone-suggestions-return.png proactive-timezone-eligibility-return.png \
  proactive-dark-large-type.png region-timezone-picker.png region-timezone-medium.png \
  region-timezone-wide.png settings-model-medium.png settings-model-fast-on.png \
  region-timezone-short-open.png region-timezone-short.png \
  workflow-long-title-open.png workflow-long-title-actions.png
