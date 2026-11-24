#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-directory.png phone-directory-empty.png phone-directory-refresh-failed.png phone-instructions.png \
  wide-automations.png wide-toggle-readback.png phone-large-text.png
