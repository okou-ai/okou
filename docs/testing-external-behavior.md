# Testing External Behavior

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

## Platform

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

## API

In `turbo/apps/api`, the external user interface is the API endpoint.

API tests must construct, drive, and observe cases through production interfaces
available to the real caller. Trace the whole chain through shared fixtures and
nested helpers; a public final response cannot validate privately seeded state.

That means:

1. When setting up state, call the real user-accessible API that exists in
   production. An operator cron requiring `CRON_SECRET` is not that interface.
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

## Cases Without Public Construction

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
or private fixture. Batch 005 retains those vectors there while removing a
redundant API wrapper. This does not authorize relocating API service tests or
privately constructed business scenarios into a library package.

## Infrastructure and External Providers

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

## Lint

API test files should not import DB schema, API service files, or the logger.

This lint rule is not about making code look tidy. It is a reminder that the
test is crossing the external behavior boundary and starting to control internal
implementation. Go back to the endpoint first and see whether the case can be
constructed with the real API.

API tests should not reach the same diagnostics through the test mocks either. A
`no-restricted-syntax` rule in `turbo/apps/api/eslint.config.mjs` rejects
`axiomLogging`, `sdkIngest`, and `useRealTelemetry` member access in API tests.
The four suites that own the logger, its Axiom transport, the telemetry SDK
client, and the app factory's log wiring are exempt, because there the logger is
the subject rather than a diagnostic.

The files that still read those mocks are listed in
`apiTestDiagnosticsBaseline`. That list may only shrink: a test leaves it by
asserting HTTP responses and effects instead, and the list is deleted once it is
empty. Never add a file to it.
