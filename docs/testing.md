# Testing at Okou

Test the contract an external user or caller relies on. Provide context through
the production entry point and verify externally observable state or an HTTP
response available through a production endpoint. Internal implementation
changes should not break a test when that contract is preserved.

## Choose the Boundary

- **Platform:** boot the real Router with `setupPage`, interact with the page,
  and assert rendered content, controls, navigation, and downloads. Default to
  `toBeInTheDocument()` for content presence; use `toBeVisible()` only when
  visibility itself is the contract. See [App assertions](app/app-testing.md#assertions).
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
[external behavior guide](testing.md#external-behavior) defines the
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
- Wait for the observable result, not elapsed time or an internal cache update.
  Follow the matching surface guide for clock controls and timing rules.
- In TypeScript packages that enable it, `ccstate/no-test-delay` detects real
  timer imports (including renamed Node timer imports), Vitest fake-timer calls,
  and elapsed wall-clock assertions.
  A deliberate exception must name one exact test file, the affected pattern
  kinds, and a reason in that package's ESLint configuration. Keep exceptions
  narrower than a whole test directory and remove them with the owning test.
- Global teardown owns detached work. Do not manually call `clearAllDetached()`
  in a test body. Repair missing awaits, cancellation ownership, or observable
  synchronization when a test races its background work.

## Guides

Read only the guides matching the work:

| Surface                  | Guide                                             |
| ------------------------ | ------------------------------------------------- |
| Shared setup and cleanup | [Patterns](testing.md#shared-patterns)            |
| Common mistakes          | [Anti-patterns](testing.md#anti-patterns)         |
| External assertions      | [External behavior](testing.md#external-behavior) |
| API routes               | [API testing](api/api-testing.md)                 |
| Platform pages           | [App testing](app/app-testing.md)                 |
| CLI commands             | [CLI testing](cli/cli-testing.md)                 |
| CLI deployed E2E         | [CLI E2E](cli/cli-e2e-testing.md)                 |
| Desktop                  | [Desktop testing](desktop/desktop-testing.md)     |
| Rust                     | [Rust testing](runner/rust-testing.md)            |
| Python addon             | [Addon testing](runner/mitm-addon-testing.md)     |

Select verification from the changed surface and consumers, as described in
[the project guidelines](../CLAUDE.md#development-and-verification). Run one
Vitest process at a time. Do not run unrelated suites or repeat passed checks
without a new change, failure, or unresolved concern.

## CI Duration Warning

The root Vitest CI reporter emits a GitHub warning when one test
file spends 30 seconds or more executing tests. The budget measures accumulated test time
inside the file, separate from environment and transform overhead. Investigate
fixed sleeps, broad fixtures, and repeated real deadlines when a warning
appears. Keep real database and process deadline tests when their timing is the
contract under test; the warning does not fail the run.

## External Behavior

This practice is about the test boundary.

Tests should not control internal implementation. Tests should give the system
the same context an external user can provide, then verify externally observable
state or an HTTP response available through a production endpoint. Authenticated
endpoints are external interfaces too; public accessibility does not mean
anonymous access.

This is the same context / control distinction we use elsewhere. A control-style
test says: to exercise this case, directly set the internal state to the shape I
want. A context-style test says: if a real user can bring the system into this
state, the test should do it the same way.

The context-style test is more solid because external interfaces are stable.
Internal implementation is not stable. Tables change, services split, caches
move, and state machines get represented differently. As long as external
behavior is unchanged, those implementation changes should not break tests.

### Platform

In `turbo/apps/platform`, the external user interface is the page.

So tests should construct cases through page interactions and verify results
through the page.

For example:

1. If a user clicks a button, the test clicks the button.
2. If a user types into an input, the test types into the input.
3. If a user can see a toast, list, URL, or dialog, the test asserts on that
   surface.

For rendered content, default to `toBeInTheDocument()` as described in
[App assertions](app/app-testing.md#assertions). Use `toBeVisible()` when showing or
hiding content is itself the contract.

Do not render an internal component just because it is convenient. Do not mutate
the store directly. Do not call hooks directly. Do not assert on query cache,
component state, CSS classes, or whether an internal callback was called.

Those things may be today's implementation, but they are not the user's
interface. Testing them freezes the implementation. Later, a refactor fails the
test even though the product still works.

### API

In `turbo/apps/api`, the external user interface is the API endpoint.

API tests must construct, drive, and observe cases through production interfaces
available to the real caller. Trace the whole chain through shared fixtures and
nested helpers; a public final response cannot validate privately seeded state.

That means:

1. When setting up state, call the real user-accessible API that exists in
   production. An operator cron requiring `CRON_SECRET` is not a user
   interface; it is covered only as an explicitly scoped system boundary, as
   described in [the API guide](api/api-testing.md#external-behavior-boundary).
2. When verifying results, call an API that an external user can call and
   assert its status, headers, body, or effects observable in a later request.
3. Auth, validation, serialization, idempotency, permissions, and
   no-existence-leak behavior should all be exercised through the endpoint.
4. Webhook providers, runners, sandboxes, and integrations are external callers
   too. Use the production endpoint appropriate to that actor and mock only its
   external dependencies. Thin API helpers must preserve that boundary.

An external storage mock does not authorize inventing application-owned records.
Returning S3 unavailability for an upload created through the normal API is a
provider failure; injecting an artifact alias with invented target identities
to force a collision is private application-state construction. Observe share
publication and revocation through the resulting access and catalog responses.
External byte transfers and emitted documents consumed by another production
component can still be meaningful boundary effects.

The observer must also be a real surviving caller. After a verified account
deletion, mocking the deleted session back into existence does not establish a
public observation path. Unrelated owners can still verify their own files; that
proves isolation, not the erased owner's physical row deletion. Likewise, an
overlapping request may use a caller-supplied ID or an already returned ID, not
one learned only by inspecting an internal write.

For API tests, the database is not the external interface. DB schema is internal
implementation.

Directly inserting, updating, or deleting DB rows tells the test about an
internal implementation detail instead of describing user behavior. Directly
selecting DB rows for assertions verifies the internal write path instead of the
result an external user can observe.

Services are not the external interface either. Calling a service to construct a
case, or asserting on a service return value, bypasses the route, middleware,
contract, auth, and request parsing. That test can pass while the real API is
still broken.

Log records are not the external interface either. Messages, levels, fields, and
telemetry ingestion are internal implementation that any refactor may rename or
drop. API tests must not enable the real Axiom transport, intercept the ingest
endpoint, or assert on logger calls. The two exceptions, which must be stated as
exceptions, are the logger's own suite and one redaction test proving a shared
sanitizer keeps secrets out of records.

For the API project, business-row mutation or inspection, direct service or
worker execution, and service return values all cross the internal boundary.
Moving a test HTTP operation into an exported fixture function preserves the
same problem, even if that function has no direct DB import. Follow the
commands it invokes. A helper may wrap genuine authenticated API calls; its
name is not evidence that its setup is public. A test-only transport probe
that exposes arbitrary methods, a cancellation toggle, or raw service results
is also private execution. Prefer the real OAuth lifecycle and its externally
observable discovery or callback result; do not preserve the probe by moving
its handler into a helper.

### Cases Without Public Construction

Evaluate the scenario before choosing a replacement helper:

1. Identify the real caller, trigger, and useful observable guarantee. Decide
   whether the case protects that behavior or manufactures an unlikely internal
   race, intermediate state, or implementation detail.
2. Delete unjustified coverage and its unused support. For valuable behavior,
   construct the complete lifecycle through existing normal user APIs or genuine
   provider webhooks and authenticated Runner requests.
3. If those interfaces cannot construct the case, reconsider its value and
   remove the unsupported coverage. A valuable label or an old regression does
   not authorize private setup, execution, or observation.

Delete cases whose decisive state or behavior cannot be constructed or driven
through the user-accessible production boundary. Do not replace a retired test
endpoint with a DB helper or private worker driver, relocate the case to another
test layer, or add a product API solely to preserve it.

Fabricated legacy rows, DB fault triggers, notification-free state swaps,
precise internal sweep counts, and operator-only cron execution are not public
scenarios. Financial, security, clock, history, and recovery concerns do not
automatically justify private construction. Preserve the real public security
and failure behavior where it can be exercised through the actual endpoint.

These are not reasons to bypass the boundary:

1. API setup is verbose.
2. Page setup takes several interactions.
3. An existing helper can write the DB directly.
4. Calling the service is faster.

If a state can be constructed through a real endpoint or page interaction, use
that path.

For a mixed case, keep independently public phases with meaningful assertions
and remove private-only phases. For a parameterized declaration, assess each
branch; removing one unsupported branch need not delete the whole declaration.
Record exact names, dependencies, decisions, lost and retained coverage, and
support code removed. If the real caller's boundary is ambiguous, identify the
specific production entry point and authorization chain for review; do not
grant a blanket fixture exception.

Record implementation decisions and evidence in the owning issue or PR, not a
new document under `docs/`. Inventory-item progress and test-declaration or
parameter-branch changes are different measures; neither endpoint removal nor
helper renaming establishes compliance by itself.

A genuine shared-library protocol can have its own boundary. For example,
`piMemoryPhase2SelectionDigest` is exported by `@okouai/pi-agent-runtime/api`
and consumed by both API maintenance and runtime filesystem code. Its owning
package tests the fixed byte-encoding vectors without an API database, worker
or private fixture. This does not authorize relocating API service tests or
privately constructed business scenarios into a library package.

### Infrastructure and External Providers

Basic app construction, test identity setup at the Clerk boundary, database
isolation, and resource teardown are test infrastructure. They do not by
themselves fabricate application state. A fixture that seeds business rows or
forces an internal worker still violates the boundary inside that infrastructure.

Signed integration webhooks and authenticated Runner requests can represent
real production callers. Exercise their genuine protocol and authorization
instead of using a private shortcut. Mocking an external provider such as Clerk,
S3, Resend, or Stripe is valid when the real internal application path remains
in use. The logger-specific exceptions stated above concern the logger's own
contract, not a waiver for constructing private business scenarios.

### Lint

API test lint enforces this boundary: no DB, driver, service or internal signal
imports, no test-only endpoints, no logger or telemetry observation, only
allowlisted boundary controls, and no new credential forging. The rules, their
exact-file exception policy and the stale-entry guard are documented in
[API test boundary lint](api/api-testing.md#test-boundary-lint); every
diagnostic links to its section there.

This lint rule is not about making code look tidy. It is a reminder that the
test is crossing the external behavior boundary and starting to control internal
implementation. Go back to the endpoint first and see whether the case can be
constructed with the real API.

## Shared Patterns

These shared ownership patterns apply across surfaces. Application guides own
their executable examples; follow [external behavior](#external-behavior) for
setup and assertion boundaries.

### Production Entry Points

| Surface  | Setup and assertions                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| API      | [Hono and ts-rest route clients](api/api-testing.md); create and verify state through production endpoints   |
| Platform | [Page setup](app/app-testing.md); await `setupPage`, act through controls, then assert observable page state |
| CLI      | [Command parsing](cli/cli-testing.md); assert output, exit status, and user-accessible files                 |

A helper may wrap an API call or page interaction. It must not hide direct DB
writes, service calls, or store mutation that bypass the external interface.
Use the owning guide for cases with no externally reachable setup path.

### External HTTP and Other Mocks

Use MSW for external HTTP. Match real request URLs, headers, bodies, statuses,
and response schemas. Missing handlers should fail the test. Do not replace
`fetch` or test an internal service in place of its public route.

API and Platform test contexts own centralized mocks. For Platform, configure
`context.mocks.api` for a typed contract or `context.mocks.http` where the guide
permits raw HTTP; do not import the global MSW server or use `server.use()` in
page tests. Use the context-owned browser, auth, upload, and realtime mocks too.
Other packages follow their own shared MSW setup and teardown.

Mock third-party dependencies only. An npm-style import can still name an
internal workspace package, so inspect ownership instead of using path syntax
as the entire decision. Reuse existing external mock helpers when appropriate;
do not add wrappers used only to conceal internal coupling.

### Real Filesystem

Create a unique temporary directory for the test lifetime and remove it during
teardown. Invoke the real command or public file operation and inspect the
resulting files as a caller would. Do not mock `fs` to verify file behavior.

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "okou-test-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
```

### Persistent and Runtime State

- Use unique users/organizations for independent database state. Keep the real
  database under the real API path.
- `testContext()` owns runtime state and mocks, not database rollback. For a
  fixed or quota-limited identity, register all created resources for teardown
  through production APIs.
- Set environment through `vi.stubEnv()` where needed and use the package's
  existing reset lifecycle (`vi.unstubAllEnvs()` when no shared owner exists).
  Do not replace the entire `process.env` object or stub unrelated variables.
- Let centralized setup reset mocks. Avoid redundant test-local reset hooks.
- Follow the owning surface's clock controls for time-dependent behavior. Wait
  for a meaningful observable result; do not insert delays to make an
  asynchronous assertion pass.
- Await owned work. Leave detached cleanup to shared teardown and fix the
  missing ownership or synchronization if work races a test.

### Updating an Existing Test

Identify the user contract first, then replace internal fixtures and assertions
with production entry points and observable outcomes. Preserve meaningful
security, payment, ordering, cancellation, persistence, and recovery coverage.
Run the affected tests after the change; a shorter test is useful only when it
still protects the intended contract.

## Anti-Patterns

These patterns explain common sources of false confidence. Use the matching
application guide for executable setup and [shared patterns](#shared-patterns)
for common ownership rules.

### AP-1: Testing Mock Calls Instead of Behavior

An internal callback being invoked does not prove the result is correct. Verify
externally observable state or an HTTP response available through a production
endpoint. For CLI commands, output and exit status are the user interface, so
asserting their content is valid.

### AP-2: Direct Fetch Mocking

Use MSW at the external HTTP boundary instead of `vi.stubGlobal("fetch", ...)`.
Exercise real request construction and contract responses. Platform page tests
register overrides through `context.mocks.api` or the supported
`context.mocks.http` surface; shared setup owns the server lifecycle.

### AP-3: Filesystem Mocking

Use real temporary directories and inspect user-accessible file results.
Mocking `fs` can hide path, encoding, permission, and resource-lifetime problems.
See [shared patterns](testing.md#real-filesystem).

### AP-4: Mocking Internal Code

Use real internal services and utilities. Check actual ownership: relative
`vi.mock()` imports are a warning sign, and workspace package imports may also
be internal. Mock the external provider instead of bypassing the production
path that uses it. Keep the database real.

### AP-5: Partial Internal Mocks

`vi.importActual()` plus replacement methods still bypasses part of the system.
Use real internal code and control only the external dependency. Partial mocks
are not an exception to the ownership boundary.

### AP-6: Testing Implementation Details

Do not assert on query caches, component state, CSS classes, DB rows, or internal
service output when the contract is available through a page or endpoint.
Construct and observe the scenario through the same surface the real caller
uses. See [external behavior](testing.md#external-behavior) for states that
cannot be constructed through a production interface.

### AP-7: Over-Testing

Avoid tests that duplicate existing coverage, re-prove a third-party validator,
or pin static configuration and incidental copy. Test error statuses and
loading/empty states when they establish a meaningful product contract. Rendered
text, disabled controls, and accessible state can be valid evidence of that
contract; internal flags are not a replacement.

Do not add artificial close/reopen or remount stories solely to freeze transient
UI state. Preserve durable persistence, security, payment, cancellation,
ordering, and recovery scenarios.

### AP-8: Console Mocking Without Assertions

Use shared logger mocks for noise and lifecycle control. If logging or CLI
output is the contract, assert its meaningful content. Otherwise verify the
actual page, HTTP, or file outcome instead of adding a console spy with no
purpose.

### AP-9: Direct Component Rendering

Platform view tests enter through the production Router using awaited
`setupPage()`. Configure context-owned mocks first, wait for observable readiness,
perform the interaction, and assert the result. Do not substitute a direct
component render, hook call, or store mutation for the user journey.
See [App testing](app/app-testing.md).

### AP-10: Testing Service Functions When a Route Exists

API tests use `setupApp()` with the route contract and production endpoint.
Helpers may wrap those API calls; they must not seed DB rows, import services,
or call `initServices()` to skip middleware, auth, parsing, or serialization.
Verify persistence with a follow-up HTTP request an external caller can make.
See [API testing](api/api-testing.md).

### AP-11: Pinning Diagnostics

In API tests, do not build a `captureDiagnostics`-style harness that switches on
the real telemetry transport, intercepts the ingest endpoint with MSW, and
asserts a level, message, or field per outcome. Those records are internal
implementation, so renaming one outcome breaks cases that protect nothing a
caller can observe, and a log-noise report gets answered with another classifier
instead of a deleted record. Assert the HTTP response and the effect visible in
the next request instead. The logger's own suite and one shared-sanitizer
redaction check are the only exceptions. Where a log record is a surface's own
contract, AP-8 applies. See [external behavior](testing.md#external-behavior).

### AP-12: Requiring Visibility for Content Presence

A completion message can already be in the DOM while its toast's enter effect
is still updating opacity. When the contract is that the message rendered, use
an awaited `findByText` with `toBeInTheDocument()`. An extra `toBeVisible()` or
animation wait couples that assertion to unrelated presentation timing.
Reserve visibility assertions for behavior that specifically shows or hides
content. See [App assertions](app/app-testing.md#assertions).

### Review Checklist

- Does setup follow a real external entry point?
- Does the assertion verify external observable state or a publicly callable
  HTTP response, including authenticated endpoints?
- Are only external dependencies mocked, with the normal cleanup owner?
- Does synchronization wait for the observable outcome?
- Does a content-presence assertion use `toBeInTheDocument()`, reserving
  `toBeVisible()` for an explicit visibility contract?
- Does the test protect a meaningful contract beyond existing coverage?
