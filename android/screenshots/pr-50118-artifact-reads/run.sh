#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    artifacts-phone-catalog.png \
    chat-resources-phone-sync.png \
    chat-resources-phone-refresh-error.png \
    chat-resources-wide-page-error.png \
    artifacts-wide-first-read-error.png \
    artifacts-wide-access-denied.png
