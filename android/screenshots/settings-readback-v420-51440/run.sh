#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-confirmed-off.png 02-stale-readback.png 03-rolled-back.png 04-confirmed-on.png \
  05-proactive-checking.png 06-proactive-rolled-back.png \
  07-default-model-checking.png 08-default-model-rolled-back.png
