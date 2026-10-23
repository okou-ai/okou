#!/usr/bin/env bash
set -e

# Prepare development environment for running `pnpm dev` in turbo directory
# Usage: ./scripts/prepare.sh

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TURBO_DIR="$PROJECT_ROOT/turbo"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "  Okou Development Environment Setup"
echo "========================================"
echo ""

# Track if any step failed
FAILED=0

# -----------------------------------------------------------------------------
# 1. Check the supported Node.js security patch floors before accessing secrets
# -----------------------------------------------------------------------------
echo "1. Checking Node.js version..."
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}   Error: Node.js is not installed${NC}"
  echo "   Install the version in .node-version from: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v)
NODE_SUPPORTED=false
if [[ "$NODE_VERSION" =~ ^v(22|24|26)\.([0-9]+)\.([0-9]+)$ ]]; then
  NODE_MAJOR=${BASH_REMATCH[1]}
  NODE_MINOR=${BASH_REMATCH[2]}
  NODE_PATCH=${BASH_REMATCH[3]}
  case "$NODE_MAJOR" in
    22) MIN_MINOR=23; MIN_PATCH=4 ;;
    24) MIN_MINOR=22; MIN_PATCH=1 ;;
    26) MIN_MINOR=12; MIN_PATCH=1 ;;
  esac
  if (( NODE_MINOR > MIN_MINOR || (NODE_MINOR == MIN_MINOR && NODE_PATCH >= MIN_PATCH) )); then
    NODE_SUPPORTED=true
  fi
fi
if [[ "$NODE_SUPPORTED" != true ]]; then
  echo -e "${RED}   Error: Node.js requires 22.23.4+, 24.22.1+, or 26.12.1+ within those major versions (current: $NODE_VERSION)${NC}"
  echo "   Install the version in .node-version before continuing setup."
  exit 1
fi
echo -e "${GREEN}   Node.js $NODE_VERSION${NC}"

# -----------------------------------------------------------------------------
# 2. Check pnpm
# -----------------------------------------------------------------------------
echo "2. Checking pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
  echo -e "${RED}   Error: pnpm is not installed${NC}"
  echo "   Install pnpm: npm install -g pnpm@10.15.0"
  FAILED=1
else
  echo -e "${GREEN}   pnpm $(pnpm -v)${NC}"
fi

# -----------------------------------------------------------------------------
# 3. Check PostgreSQL service
# -----------------------------------------------------------------------------
echo "3. Checking PostgreSQL..."
if command -v pg_isready >/dev/null 2>&1; then
  if pg_isready -q 2>/dev/null; then
    echo -e "${GREEN}   PostgreSQL is running${NC}"
  else
    echo -e "${YELLOW}   Starting PostgreSQL...${NC}"
    if command -v sudo >/dev/null 2>&1; then
      if ! sudo service postgresql start; then
        echo -e "${RED}   Error: Failed to start PostgreSQL service${NC}"
        echo "   Please start PostgreSQL manually"
        FAILED=1
      fi
    fi
    # Wait for PostgreSQL to be ready (max 10 seconds)
    RETRIES=10
    while [ $RETRIES -gt 0 ]; do
      if pg_isready -q 2>/dev/null; then
        echo -e "${GREEN}   PostgreSQL started${NC}"
        break
      fi
      RETRIES=$((RETRIES - 1))
      sleep 1
    done
    if [ $RETRIES -eq 0 ]; then
      echo -e "${RED}   Error: PostgreSQL not ready after 10 seconds${NC}"
      echo "   Please start PostgreSQL manually"
      FAILED=1
    fi
  fi
else
  echo -e "${YELLOW}   Warning: pg_isready not found, skipping PostgreSQL check${NC}"
  echo "   Make sure PostgreSQL is running on localhost:5432"
fi

# -----------------------------------------------------------------------------
# 4. Check DATABASE_URL environment variable
# -----------------------------------------------------------------------------
echo "4. Checking DATABASE_URL..."
if [ -z "$DATABASE_URL" ]; then
  echo -e "${RED}   Error: DATABASE_URL not set${NC}"
  echo "   Please set DATABASE_URL environment variable"
  echo "   Example: export DATABASE_URL=\"postgresql://postgres:postgres@localhost:5432/postgres\""
  FAILED=1
else
  echo -e "${GREEN}   DATABASE_URL is set${NC}"
fi

# -----------------------------------------------------------------------------
# 5. Check .env.local files
# -----------------------------------------------------------------------------
echo "5. Syncing environment files..."
if "$SCRIPT_DIR/sync-env.sh"; then
  echo -e "${GREEN}   Environment files synced${NC}"
else
  echo -e "${RED}   Error: sync-env.sh failed${NC}"
  echo "   Options:"
  echo "   - Run manually: ./scripts/sync-env.sh (requires 1Password CLI)"
  echo "   - Or manually create .env.local files from .env.local.tpl templates"
  FAILED=1
fi

# -----------------------------------------------------------------------------
# 7. Install dependencies
# -----------------------------------------------------------------------------
echo "7. Installing dependencies..."
cd "$TURBO_DIR"
if pnpm install; then
  echo -e "${GREEN}   Dependencies installed${NC}"
else
  echo -e "${RED}   Error: Failed to install dependencies${NC}"
  FAILED=1
fi

# -----------------------------------------------------------------------------
# 8. Run database migrations
# -----------------------------------------------------------------------------
echo "8. Running database migrations..."
cd "$TURBO_DIR"
if pnpm --filter @okouai/db db:migrate; then
  echo -e "${GREEN}   Database migrations complete${NC}"
else
  echo -e "${RED}   Error: Database migrations failed${NC}"
  echo "   Make sure PostgreSQL is running and DATABASE_URL is correct"
  FAILED=1
fi

# -----------------------------------------------------------------------------
# 9. Seed development data
# -----------------------------------------------------------------------------
echo "9. Seeding development data..."
cd "$TURBO_DIR"
if pnpm --filter api db:dev-seed; then
  echo -e "${GREEN}   Development seed complete${NC}"
else
  echo -e "${RED}   Error: Development seed failed${NC}"
  FAILED=1
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "========================================"
if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}  Setup complete!${NC}"
  echo "========================================"
  echo ""
  echo "You can now run:"
  echo "  cd turbo && pnpm dev"
  echo ""
else
  echo -e "${RED}  Setup failed!${NC}"
  echo "========================================"
  echo ""
  echo "Please fix the errors above and try again."
  exit 1
fi
