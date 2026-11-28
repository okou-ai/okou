#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-default-model-retrying.png \
    02-default-model-rolled-back.png \
    03-morning-brief-retrying.png \
    04-morning-brief-rolled-back.png
