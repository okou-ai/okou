#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" list-initial.png list-regular.png list-refresh-failed.png list-short-offline.png
