#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  discover-phone.png \
  rename-ready-phone.png \
  rename-network-failure-phone.png \
  rename-unconfirmed-phone.png \
  disconnect-impact-network-failure-phone.png \
  disconnect-confirmation-phone.png \
  device-authorization-phone.png \
  authorization-short-large-text.png \
  directory-detail-wide.png \
  account-panel-network-advisory-wide.png \
  account-panel-network-failure-wide.png \
  cached-category-phone.png \
  cached-service-phone.png
