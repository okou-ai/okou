#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 kms-production-retirement-test.py
