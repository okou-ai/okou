#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(id -u)" -eq 0 ]; then
  python3 "${script_dir}/prepare-runner-wss-test.py"
else
  sudo python3 "${script_dir}/prepare-runner-wss-test.py"
fi
