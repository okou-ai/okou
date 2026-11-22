#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  chat-list-connectors.png directory-loading.png discover.png connected.png wide-detail.png \
  account-panel-phone.png account-panel.png account-panel-off.png account-panel-offline.png account-removed.png disconnect-confirmation.png \
  permissions.png authorization.png rename.png chat-list-connectors-wide.png chat-list-connectors-large-text.png \
  account-panel-dark.png account-panel-dark-off.png \
  directory-uncached-offline.png detail-accounts-uncached-offline.png permissions-uncached-offline.png detail-cached-offline.png \
  connected-email-category-wide.png offline-cached-search.png offline-revisited-account-detail.png offline-revisited-permissions.png \
  unavailable-catalog-detail.png connected-empty-category-offline.png
