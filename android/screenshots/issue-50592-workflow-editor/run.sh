#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-keyboard-focus.png phone-schedule.png phone-timezone.png phone-calendar.png phone-gmail.png wide-timezone.png
