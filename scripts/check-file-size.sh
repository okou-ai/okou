#!/usr/bin/env bash
#
# Pre-commit hook to check file sizes
# Usage: check-file-size.sh [files...]
#
set -euo pipefail

# Configuration
LIMIT_BYTES=${FILE_SIZE_LIMIT:-1048576}  # Default 1MB

# Drizzle regenerates one complete schema snapshot per migration. It is
# generated metadata that must never be hand-edited, reformatted or compressed,
# and it grows monotonically with the schema, so it gets its own explicit
# ceiling instead of the ordinary source limit. Only files matching the exact
# generated-snapshot path qualify; `_journal.json` and everything else in that
# directory keep the ordinary limit.
SNAPSHOT_LIMIT_BYTES=${DRIZZLE_SNAPSHOT_FILE_SIZE_LIMIT:-4194304}  # Default 4MB

# Allow override via environment variable
if [ "${ALLOW_LARGE_FILES:-}" = "1" ]; then
  echo "ALLOW_LARGE_FILES=1: Skipping file size check"
  exit 0
fi

# Check if any files provided
if [ $# -eq 0 ]; then
  exit 0
fi

failed=0
checked=0

for file in "$@"; do
  # Skip if file doesn't exist (deleted files)
  if [ ! -f "$file" ]; then
    continue
  fi

  # Get file size (portable across Linux/macOS)
  size=$(wc -c < "$file" | tr -d ' ')
  checked=$((checked + 1))

  # Select the limit in the current shell. Command substitution would add one
  # subprocess per input file and make full-tree checks unnecessarily slow.
  case "$file" in
    */packages/db/src/migrations/meta/[0-9][0-9][0-9][0-9]_snapshot.json | \
      packages/db/src/migrations/meta/[0-9][0-9][0-9][0-9]_snapshot.json)
      limit=$SNAPSHOT_LIMIT_BYTES
      ;;
    *)
      limit=$LIMIT_BYTES
      ;;
  esac

  if [ "$size" -gt "$limit" ]; then
    size_mb=$(awk "BEGIN {printf \"%.2f\", $size / 1048576}")
    limit_mb=$(awk "BEGIN {printf \"%.0f\", $limit / 1048576}")
    echo "ERROR: $file is ${size_mb}MB (limit: ${limit_mb}MB)"
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  echo ""
  echo "Suggestions:"
  echo "  - Compress images: pngquant, jpegoptim, svgo"
  echo "  - Use Git LFS for large binary files"
  echo "  - Override: ALLOW_LARGE_FILES=1 git commit -m '...'"
  exit 1
fi

exit 0
