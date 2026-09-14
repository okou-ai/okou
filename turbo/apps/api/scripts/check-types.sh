#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

deps() {
  pnpm --filter @okouai/pi-agent-runtime run build
}

boundaries() {
  node --test scripts/typecheck-projects.node-test.mjs
  node scripts/prepare-typecheck-tests.mjs
  node scripts/check-typecheck-boundaries.mjs
}

gateways() {
  # Keep native compiler dependency discovery on this public package script.
  pnpm run check-types:gateways
}

core() {
  tsc -p tsconfig.core.json --checkers $(node ../../scripts/tsc-checkers.mjs)
  tsc -p tsconfig.routes.json --checkers $(node ../../scripts/tsc-checkers.mjs)
}

bootstrap() {
  tsc -p tsconfig.bootstrap.json --checkers $(node ../../scripts/tsc-checkers.mjs)
}

tests() {
  node scripts/prepare-typecheck-tests.mjs
  tsc -p .typecheck/tsconfig.tests-0.json --noEmit --checkers $(node ../../scripts/tsc-checkers.mjs)
  tsc -p .typecheck/tsconfig.tests-1.json --noEmit --checkers $(node ../../scripts/tsc-checkers.mjs)
}

bootstrap_wiring() {
  tsc -p tsconfig.bootstrap-wiring.json --noEmit --checkers $(node ../../scripts/tsc-checkers.mjs)
}

# Fixed functions share the public commands without repeated pnpm startup or eval.
case "${1:-all}" in
  all)
    deps
    boundaries
    gateways
    core
    bootstrap
    tests
    bootstrap_wiring
    ;;
  deps) deps ;;
  boundaries) boundaries ;;
  gateways) gateways ;;
  core) core ;;
  bootstrap) bootstrap ;;
  tests) tests ;;
  bootstrap-wiring) bootstrap_wiring ;;
  *)
    printf 'Unknown type-check stage: %s\n' "$1" >&2
    exit 2
    ;;
esac
