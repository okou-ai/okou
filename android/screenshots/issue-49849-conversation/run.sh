#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-phone.png 02-reading-new-reply.png 03-wide.png 04-short.png 05-new-chat.png \
  06-idle-while-syncing.png 07-running-while-syncing.png \
  08-restored-unread-position.png 09-restored-read-position.png
