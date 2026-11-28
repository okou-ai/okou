#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-picker-light.png 02-home-uploaded-light.png 03-home-chooser-light.png \
  04-home-default-dark.png 05-settings-default-dark.png 06-settings-chooser-dark.png \
  07-settings-uploaded-light.png
