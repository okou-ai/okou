---
name: testing
description: Comprehensive testing patterns and anti-patterns for writing and reviewing tests
context: fork
---

# Testing Skill

Use this skill when writing tests, reviewing test code, or investigating test failures.

## Documentation

Read the testing guide and relevant reference based on context:

| Context                                   | Primary                                     | Reference                                                           |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| General                                   | [docs/testing.md](../../../docs/testing.md) | —                                                                   |
| Anti-patterns                             | [docs/testing.md](../../../docs/testing.md) | [Anti-patterns](../../../docs/testing.md#anti-patterns)             |
| Patterns                                  | [docs/testing.md](../../../docs/testing.md) | [Shared patterns](../../../docs/testing.md#shared-patterns)         |
| CLI (`turbo/apps/cli`)                    | [docs/testing.md](../../../docs/testing.md) | [cli-testing.md](../../../docs/cli/cli-testing.md)                  |
| CLI E2E (`e2e/tests/`)                    | [docs/testing.md](../../../docs/testing.md) | [cli-e2e-testing.md](../../../docs/cli/cli-e2e-testing.md)          |
| API (`turbo/apps/api`)                    | [docs/testing.md](../../../docs/testing.md) | [api-testing.md](../../../docs/api/api-testing.md)                  |
| App (`turbo/apps/platform`)               | [docs/testing.md](../../../docs/testing.md) | [app-testing.md](../../../docs/app/app-testing.md)                  |
| Rust (`crates/`)                          | [docs/testing.md](../../../docs/testing.md) | [rust-testing.md](../../../docs/runner/rust-testing.md)             |
| Python addon (`crates/runner/mitm-addon`) | [docs/testing.md](../../../docs/testing.md) | [mitm-addon-testing.md](../../../docs/runner/mitm-addon-testing.md) |

## Key Principles

1. **Integration tests are primary** — test at system entry points
2. **Mock at the boundary** — only mock external services, not internal code
3. **Use real infrastructure** — real database, real filesystem (temp dirs)
4. **Test behavior, not implementation** — verify outcomes, not mock calls
