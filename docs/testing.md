# Testing at Okou

Test the contract an external user or caller relies on. Provide context through
the production entry point and verify externally observable state or an HTTP
response available through a production endpoint. Internal implementation
changes should not break a test when that contract is preserved.

## Choose the Boundary

- **Platform:** boot the real Router with `setupPage`, interact with the page,
  and assert rendered content, controls, navigation, and downloads. Default to
  `toBeInTheDocument()` for content presence; use `toBeVisible()` only when
  visibility itself is the contract. See [App assertions](testing/app-testing.md#assertions).
- **API:** call production endpoints for setup and verification. Assert HTTP
  responses, including status, headers, bodies, and effects observable through
  subsequent requests. Exercise auth, validation, serialization, permissions,
  idempotency, and existence-leak protection through those endpoints.
- **CLI:** invoke the command parser and assert output, exit status, or the
  resulting user-accessible files.
- **Desktop, Runner, and addon:** use the production boundary described in the
  matching guide below, including IPC, protocols, and process outcomes.

Do not substitute component state, query caches, database rows, service return
values, or internal callback counts for these outcomes. The
[external behavior guide](testing/testing-external-behavior.md) defines the
boundary and the treatment of states impossible to construct through it.

## Coverage

Prefer integration coverage through real entry points. Add tests for new
behavior and regressions where they provide confidence beyond existing checks.
Keep cases focused on meaningful business, security, cancellation, recovery,
and compatibility contracts. Avoid duplicate cases that merely exercise a
library, restate static configuration, or pin incidental implementation. In API
tests log records are incidental implementation: outside the logger's own suite
and one redaction check, do not assert on log levels, messages, or fields.

Use expensive deployed E2E runs for representative happy paths. Exercise error
and edge cases in controlled integration tests. Follow each surface's guide
for contracts that specifically require deployed or native verification.

Changes to requests, Runner protocols, queue payloads, or persisted state must
cover the old/new combinations that can coexist during rollout. Follow
[deployment compatibility](deployment-compatibility.md); those boundaries
remain part of the runtime contract.

## Dependencies and Ownership

- Mock external services at their boundary. Use MSW for HTTP rather than
  replacing `fetch`; return realistic contract responses and fail on unhandled
  requests. Package guides define handler registration and cleanup.
- Use real internal code, the real database, and real temporary files. A
  relative import in `vi.mock()` is a warning sign, not a substitute for checking
  who owns the dependency; workspace packages can also be internal.
- API and Platform tests use their centralized `testContext()` and
  `context.mocks` lifetimes. Platform page tests must not import the global MSW
  server or call `server.use()`.
- `testContext()` cleans runtime state and mocks; it does not roll back database
  rows. Use unique identities. For fixed or quota-limited identities, register
  created resources for teardown through production APIs.
- Avoid fake timers. Platform time overrides use `mockNow(value, context.signal)`.
  Wait for the observable result, not elapsed time or an internal cache update.
- Global teardown owns detached work. Do not manually call `clearAllDetached()`
  in a test body. Repair missing awaits, cancellation ownership, or observable
  synchronization when a test races its background work.

## Guides

Read only the guides matching the work:

| Surface                  | Guide                                                     |
| ------------------------ | --------------------------------------------------------- |
| Shared setup and cleanup | [Patterns](testing/patterns.md)                           |
| Common mistakes          | [Anti-patterns](testing/anti-patterns.md)                 |
| External assertions      | [External behavior](testing/testing-external-behavior.md) |
| API routes               | [API testing](testing/api-testing.md)                     |
| Platform pages           | [App testing](testing/app-testing.md)                     |
| CLI commands             | [CLI testing](testing/cli-testing.md)                     |
| CLI deployed E2E         | [CLI E2E](testing/cli-e2e-testing.md)                     |
| Desktop                  | [Desktop testing](testing/desktop-testing.md)             |
| Rust                     | [Rust testing](testing/rust-testing.md)                   |
| Python addon             | [Addon testing](testing/mitm-addon-testing.md)            |

Select verification from the changed surface and consumers, as described in
[the project guidelines](../CLAUDE.md#development-and-verification). Run one
Vitest process at a time. Do not run unrelated suites or repeat passed checks
without a new change, failure, or unresolved concern.
