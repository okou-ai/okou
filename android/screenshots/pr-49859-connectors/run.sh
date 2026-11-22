#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  chat-list-connectors.png directory-loading.png discover.png connected.png wide-detail.png \
  account-panel-phone.png account-panel.png account-panel-off.png account-panel-offline.png account-removed.png disconnect-confirmation.png \
  permissions.png authorization.png chat-list-connectors-wide.png chat-list-connectors-large-text.png \
  account-panel-dark.png account-panel-dark-off.png
