#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-workflow-instructions.png phone-name-validation.png \
  wide-workflow-instructions.png wide-calendar-automation.png
