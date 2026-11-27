#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-detail-loading.png phone-detail.png phone-history-loading.png phone-history.png \
  wide-directory-loading.png wide-directory.png wide-detail-loading.png wide-detail.png \
  wide-history-loading.png wide-history.png
