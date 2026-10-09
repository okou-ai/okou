# Testing Patterns

Use [Testing](testing.md) for strategy and [external behavior](testing-external-behavior.md)
for setup and assertion boundaries. This page covers shared ownership patterns;
application guides own their executable examples.

## Production Entry Points

| Surface  | Setup and assertions                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| API      | [Hono and ts-rest route clients](api/api-testing.md); create and verify state through production endpoints   |
| Platform | [Page setup](app/app-testing.md); await `setupPage`, act through controls, then assert observable page state |
| CLI      | [Command parsing](cli-testing.md); assert output, exit status, and user-accessible files                     |

A helper may wrap an API call or page interaction. It must not hide direct DB
writes, service calls, or store mutation that bypass the external interface.
Use the owning guide for cases with no externally reachable setup path.

## External HTTP and Other Mocks

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

## Real Filesystem

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

## Persistent and Runtime State

- Use unique users/organizations for independent database state. Keep the real
  database under the real API path.
- `testContext()` owns runtime state and mocks, not database rollback. For a
  fixed or quota-limited identity, register all created resources for teardown
  through production APIs.
- Set environment through `vi.stubEnv()` where needed and use the package's
  existing reset lifecycle (`vi.unstubAllEnvs()` when no shared owner exists).
  Do not replace the entire `process.env` object or stub unrelated variables.
- Let centralized setup reset mocks. Avoid redundant test-local reset hooks.
- Use the application's signal-owned clock override for time-dependent
  behavior. Wait for a meaningful observable result; do not advance fake timers
  or insert delays to make an asynchronous assertion pass.
- Await owned work. Leave detached cleanup to shared teardown and fix the
  missing ownership or synchronization if work races a test.

## Updating an Existing Test

Identify the user contract first, then replace internal fixtures and assertions
with production entry points and observable outcomes. Preserve meaningful
security, payment, ordering, cancellation, persistence, and recovery coverage.
Run the affected tests after the change; a shorter test is useful only when it
still protects the intended contract.
