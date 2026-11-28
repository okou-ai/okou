#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" artifact-file-feedback-phone.png artifact-file-feedback-wide.png artifact-image-feedback-phone.png artifact-image-feedback-wide.png
