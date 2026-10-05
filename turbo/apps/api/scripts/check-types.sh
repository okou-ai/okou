#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

deps() {
  printf '%s\n' 'Type check phase: Pi declarations'
  pnpm --filter @okouai/pi-agent-runtime run build
}

boundaries() {
  printf '%s\n' 'Type check phase: boundaries'
  node --test scripts/typecheck-projects.node-test.mjs
  node scripts/prepare-typecheck-tests.mjs
  node scripts/check-typecheck-boundaries.mjs
}

gateways() {
  # Keep native compiler dependency discovery on this public package script.
  printf '%s\n' 'Type check phase: gateways'
  pnpm run check-types:gateways
}

foundation() {
  printf '%s\n' 'Type check phase: foundation'
  tsc -p tsconfig.foundation.json --checkers $(node ../../scripts/tsc-checkers.mjs)
}

admission() {
  printf '%s\n' 'Type check phase: admission'
  tsc -p tsconfig.admission.json --checkers $(node ../../scripts/tsc-checkers.mjs)
}

core() {
  foundation
  admission
  printf '%s\n' 'Type check phase: core'
  tsc -p tsconfig.core.json --checkers $(node ../../scripts/tsc-checkers.mjs)
  printf '%s\n' 'Type check phase: routes'
  tsc -p tsconfig.routes.json --checkers $(node ../../scripts/tsc-checkers.mjs)
}

bootstrap() {
  printf '%s\n' 'Type check phase: bootstrap'
  tsc -p tsconfig.bootstrap.json --checkers $(node ../../scripts/tsc-checkers.mjs)
}

tests() {
  node scripts/prepare-typecheck-tests.mjs
  printf '%s\n' 'Type check phase: tests-0'
  tsc -p .typecheck/tsconfig.tests-0.json --noEmit --checkers $(node ../../scripts/tsc-checkers.mjs)
  printf '%s\n' 'Type check phase: tests-1'
  tsc -p .typecheck/tsconfig.tests-1.json --noEmit --checkers $(node ../../scripts/tsc-checkers.mjs)
  printf '%s\n' 'Type check phase: tests-2'
  tsc -p .typecheck/tsconfig.tests-2.json --noEmit --checkers $(node ../../scripts/tsc-checkers.mjs)
}

bootstrap_wiring() {
  printf '%s\n' 'Type check phase: bootstrap-wiring'
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
  foundation) foundation ;;
  admission) admission ;;
  core) core ;;
  bootstrap) bootstrap ;;
  tests) tests ;;
  bootstrap-wiring) bootstrap_wiring ;;
  *)
    printf 'Unknown type-check stage: %s\n' "$1" >&2
    exit 2
    ;;
esac
