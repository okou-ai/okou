#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-default-model-fast.png \
    02-reasoning-effort-menu.png \
    03-default-model-auto.png \
    04-model-picker-short-window.png \
    05-image-model-saving.png \
    06-image-model-rolled-back.png \
    07-image-model-confirmed-choice.png \
    08-chat-model-save-failure-picker.png \
    09-chat-model-save-failure-conversation.png \
    10-image-model-failure-open-picker.png
