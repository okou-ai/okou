#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-settings-default-model.png 02-default-model-fast.png \
  03-default-model-auto.png 04-default-model-offline.png 05-default-model-keyboard.png \
  06-default-model-fast-dark.png 07-default-model-short-window.png \
  08-settings-default-model-cold-offline.png
