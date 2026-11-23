#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-stopping.png 02-stop-needs-check.png 03-checking-stop.png 04-stop-retry.png \
    05-preparing-to-continue.png 06-withdrawing.png 07-withdraw-needs-check.png \
    08-skipping.png 09-short-stopping.png
