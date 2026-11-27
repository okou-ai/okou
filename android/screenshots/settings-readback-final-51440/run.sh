#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-confirmed-off.png 02-stale-readback.png 03-unconfirmed.png 04-confirmed-on.png \
  05-proactive-unconfirmed.png 06-default-model-unconfirmed.png
