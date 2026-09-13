# Testing Anti-Patterns

Use [Testing](../testing.md) and the matching application guide as the canonical
setup reference. These patterns explain common sources of false confidence.

## AP-1: Testing Mock Calls Instead of Behavior

An internal callback being invoked does not prove the result is correct. Verify
externally observable state or an HTTP response available through a production
endpoint. For CLI commands, output and exit status are the user interface, so
asserting their content is valid.

## AP-2: Direct Fetch Mocking

Use MSW at the external HTTP boundary instead of `vi.stubGlobal("fetch", ...)`.
Exercise real request construction and contract responses. Platform page tests
register overrides through `context.mocks.api` or the supported
`context.mocks.http` surface; shared setup owns the server lifecycle.

## AP-3: Filesystem Mocking

Use real temporary directories and inspect user-accessible file results.
Mocking `fs` can hide path, encoding, permission, and resource-lifetime problems.
See [shared patterns](patterns.md#real-filesystem).

## AP-4: Mocking Internal Code

Use real internal services and utilities. Check actual ownership: relative
`vi.mock()` imports are a warning sign, and workspace package imports may also
be internal. Mock the external provider instead of bypassing the production
path that uses it. Keep the database real.

## AP-5: Fake Timers

Do not use `vi.useFakeTimers()` or `vi.advanceTimersByTime()` to hide timing and
ownership problems. Platform uses `mockNow(value, context.signal)` for its
application clock. Synchronize on expected rendered content, control state, or
accessible behavior within the normal test timeout, not a delay or internal
state transition.

## AP-6: Partial Internal Mocks

`vi.importActual()` plus replacement methods still bypasses part of the system.
Use real internal code and control only the external dependency. Partial mocks
are not an exception to the ownership boundary.

## AP-7: Testing Implementation Details

Do not assert on query caches, component state, CSS classes, DB rows, or internal
service output when the contract is available through a page or endpoint.
Construct and observe the scenario through the same surface the real caller
uses. See [external behavior](testing-external-behavior.md) for states that
cannot be constructed through a production interface.

## AP-8: Over-Testing

Avoid tests that duplicate existing coverage, re-prove a third-party validator,
or pin static configuration and incidental copy. Test error statuses and
loading/empty states when they establish a meaningful product contract. Rendered
text, disabled controls, and accessible state can be valid evidence of that
contract; internal flags are not a replacement.

Do not add artificial close/reopen or remount stories solely to freeze transient
UI state. Preserve durable persistence, security, payment, cancellation,
ordering, and recovery scenarios.

## AP-9: Console Mocking Without Assertions

Use shared logger mocks for noise and lifecycle control. If logging or CLI
output is the contract, assert its meaningful content. Otherwise verify the
actual page, HTTP, or file outcome instead of adding a console spy with no
purpose.

## AP-10: Direct Component Rendering

Platform view tests enter through the production Router using awaited
`setupPage()`. Configure context-owned mocks first, wait for observable readiness,
perform the interaction, and assert the result. Do not substitute a direct
component render, hook call, or store mutation for the user journey.
See [App testing](app-testing.md).

## AP-11: Testing Service Functions When a Route Exists

API tests use `setupApp()` with the route contract and production endpoint.
Helpers may wrap those API calls; they must not seed DB rows, import services,
or call `initServices()` to skip middleware, auth, parsing, or serialization.
Verify persistence with a follow-up HTTP request an external caller can make.
See [API testing](api-testing.md).

## AP-12: Pinning Diagnostics

In API tests, do not build a `captureDiagnostics`-style harness that switches on
the real telemetry transport, intercepts the ingest endpoint with MSW, and
asserts a level, message, or field per outcome. Those records are internal
implementation, so renaming one outcome breaks cases that protect nothing a
caller can observe, and a log-noise report gets answered with another classifier
instead of a deleted record. Assert the HTTP response and the effect visible in
the next request instead. The logger's own suite and one shared-sanitizer
redaction check are the only exceptions. Where a log record is a surface's own
contract, AP-9 applies. See [external behavior](testing-external-behavior.md).

## AP-13: Requiring Visibility for Content Presence

A completion message can already be in the DOM while its toast's enter effect
is still updating opacity. When the contract is that the message rendered, use
an awaited `findByText` with `toBeInTheDocument()`. An extra `toBeVisible()` or
animation wait couples that assertion to unrelated presentation timing.
Reserve visibility assertions for behavior that specifically shows or hides
content. See [App assertions](app-testing.md#assertions).

## Review Checklist

- Does setup follow a real external entry point?
- Does the assertion verify external observable state or a publicly callable
  HTTP response, including authenticated endpoints?
- Are only external dependencies mocked, with the normal cleanup owner?
- Does synchronization wait for the observable outcome?
- Does a content-presence assertion use `toBeInTheDocument()`, reserving
  `toBeVisible()` for an explicit visibility contract?
- Does the test protect a meaningful contract beyond existing coverage?
