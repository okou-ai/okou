#!/usr/bin/env bash
set -euo pipefail

scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-phone-search.png 02-phone-restored-search.png 03-wide-search.png 04-wide-result.png
