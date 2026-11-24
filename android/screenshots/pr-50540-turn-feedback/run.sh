#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-empty-history-retry.png 02-zero-reply-activity.png 03-one-reply-complete.png \
  04-late-suggestions.png 05-suggestion-in-editor.png 06-expanded-reply-timeline.png \
  07-dark-large-activity.png 08-stop-pending.png 09-stopped-task.png \
  10-cached-history-retry.png 11-failed-task-recovery.png
