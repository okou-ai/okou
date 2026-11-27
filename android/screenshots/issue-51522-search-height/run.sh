#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" home-phone.png search-phone.png home-wide.png search-wide.png home-phone-large.png search-phone-large.png home-wide-large.png search-wide-large.png
