#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" chat-list-connectors.png discover.png connected.png wide-detail.png account-panel.png account-panel-offline.png permissions.png authorization.png chat-list-connectors-wide.png chat-list-connectors-large-text.png
