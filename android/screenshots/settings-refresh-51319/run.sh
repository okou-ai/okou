#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-settings-after-late-read.png 02-settings-after-save.png \
  03-default-model-fast-on.png 04-default-model-unsupported.png \
  05-default-model-fast-reset.png 06-default-model-auto.png
