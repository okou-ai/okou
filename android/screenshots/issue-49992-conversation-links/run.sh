#!/usr/bin/env bash
set -euo pipefail

scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-phone-inline-links.png 02-phone-message-target.png 03-phone-source-return.png \
  04-wide-inline-links.png 05-wide-message-target.png 06-unavailable-link.png
