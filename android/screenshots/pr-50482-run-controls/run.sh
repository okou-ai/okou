#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-stop-pending.png 02-withdraw-pending.png 03-stop-failed.png \
    04-withdraw-failed-conversation.png 05-withdraw-failed-queue.png 06-wide-stop-failed.png
