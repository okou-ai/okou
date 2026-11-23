#!/usr/bin/env bash
set -euo pipefail

scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-sending.png 02-automatic-check.png 03-queued.png 04-delivered.png
