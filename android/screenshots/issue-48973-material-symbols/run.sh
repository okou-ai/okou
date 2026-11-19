#!/usr/bin/env bash
set -euo pipefail

scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-chat-toolbar.png 02-chat-menu.png 03-settings.png 04-palette.png \
  05-composer.png 06-update-overflow.png 07-update-large-text.png
