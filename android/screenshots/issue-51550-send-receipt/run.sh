#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" 01-new-sending.png 02-new-queued-before-history.png 03-existing-sending.png 04-existing-queued-before-history.png
