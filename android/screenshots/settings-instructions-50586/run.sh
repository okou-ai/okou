#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" 01-instructions-editor.png 02-discard-confirmation.png 03-saving.png 04-reload-confirmation.png
