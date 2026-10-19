#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
timeout --kill-after=2s 20s python3 "$script_dir/cloudflare-ssh-tcp-test.py"
