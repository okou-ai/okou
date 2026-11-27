#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connectors-loading.png phone-connectors-discover.png phone-connectors-connected.png \
  wide-connectors-details.png wide-connectors-authorization.png \
  phone-chat-connectors.png phone-chat-connectors-refresh-failed.png \
  wide-chat-connectors-checking.png wide-chat-connectors-restored.png
