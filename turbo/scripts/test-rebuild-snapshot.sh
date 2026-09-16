#!/bin/bash

# Test script to rebuild just one or two snapshots
# This helps validate the approach before running the full rebuild

set -e

echo "🧪 Testing snapshot rebuild for migrations 16-17..."
echo ""
echo "This will:"
echo "  1. Create a temporary database"
echo "  2. Apply migrations 0000-0017"
echo "  3. Generate snapshots for 0016 and 0017"
echo "  4. Clean up temporary database"
echo ""
echo "Press Ctrl+C to cancel, or Enter to continue..."
read

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
pnpm tsx scripts/rebuild-snapshots-from-db.ts 16 17

echo ""
echo "✅ Test complete! Check the generated snapshots:"
echo "   - turbo/packages/db/src/migrations/meta/0016_snapshot.json"
echo "   - turbo/packages/db/src/migrations/meta/0017_snapshot.json"
