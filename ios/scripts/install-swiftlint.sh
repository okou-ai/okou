#!/usr/bin/env bash
# Build pinned SwiftLint with native rules. --path-only is offline.
# Build requirements: Python 3, Git and Swift. Stdout is the verified binary path.
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 "$script_dir/../Tools/SwiftLint/build.py" "$@"
