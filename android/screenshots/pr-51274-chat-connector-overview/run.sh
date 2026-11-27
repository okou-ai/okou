#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-chat-connector-overview.png phone-chat-connector-accounts.png \
  wide-chat-connector-overview.png wide-chat-connector-accounts.png \
  short-chat-connector-overview.png short-chat-connector-accounts.png
