#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  failure-before-reply.png stopped-before-reply.png failure-after-reply.png \
  recovery-account-details.png recovery-account-details-large-text.png recovery-options-unavailable.png
