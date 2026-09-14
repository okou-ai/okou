# API Testing Patterns

## Principle

In the API app (`turbo/apps/api`), route behavior should be covered by
**API route integration tests**. These tests exercise the real Hono app through
`setupApp()`, an explicit route slice, and the route's ts-rest contract, not by
importing route handlers or service functions directly.

Use this guide for endpoints implemented in `apps/api` or promoted to
API-authoritative behavior.

## File Location

Place route tests under the API route test directory:

```text
turbo/apps/api/src/signals/routes/__tests__/
+-- agents.test.ts
```

## Route Test Structure

```typescript
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentsRoutes } from "../agents";

const context = testContext();

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsMainContract);
}

describe("GET /api/agents", () => {
  it("returns an agent created through POST /api/agents", async () => {
    context.mocks.clerk.session("user_api_test", "org_api_test");
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Listed Agent",
          description: "desc",
          sound: "friendly",
        },
      }),
      [201],
    );

    const listed = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(listed.body).toContainEqual(
      expect.objectContaining({
        agentId: created.body.agentId,
        ownerId: "user_api_test",
        displayName: "Listed Agent",
        description: "desc",
        sound: "friendly",
      }),
    );
  });
});
```

Key points:

1. Import the contract from `@okouai/api-contracts` and the matching route array,
   then call it through `setupApp({ context, routes })(contract)`.
2. Use `accept()` to narrow the response type and produce useful failure output.
3. Put `testContext()` at module scope.
4. Use API calls for setup and verification.
5. Mock only auth identity and external services through `context.mocks`.

## What To Test

Route tests should cover user-visible HTTP behavior:

- authentication and organization membership
- validation failures that callers can hit
- permission and no-existence-leak behavior
- success response bodies and status codes
- persisted side effects through follow-up API calls
- external service calls at the boundary, using the centralized mocks

`setupApp()` creates the Hono app with only the declared route slice and validates
ts-rest responses. This keeps tests independent from the production bootstrap
registry while preserving the real route behavior. A route test should fail if
the handler returns a body that no longer matches the contract.

## Mocks

Only mock external services. API tests use the shared mock registry in
`turbo/apps/api/src/__tests__/mocks.ts` and reset it from
`turbo/apps/api/src/__tests__/setup.ts`.

Good examples:

```typescript
context.mocks.clerk.session(userId, orgId);
context.mocks.slack.chat.postMessage.mockResolvedValue({ ok: true });
context.mocks.axiom.query.mockResolvedValue({ buckets: [] });
```

Avoid `vi.mock()` for internal modules such as services, route files, database
schemas, fixture helpers, or ccstate signals. That bypasses the behavior the
route integration test is supposed to cover.

## External Behavior Boundary

API route tests should construct cases through API endpoints and verify results
through API endpoints. The endpoint is the external contract. The database and
service layer are internal implementation.

Do not import DB schemas, write database rows, read database rows for assertions,
or call services from API tests. Those tests couple to table shape, service
boundaries, and internal state transitions instead of the behavior external
callers rely on.

If a case is not constructible through the production API surface, do not add an
API route test that reaches into internals. Add the missing API surface first, or
raise the gap during review.

For the full reasoning, see
[Testing External Behavior](./testing-external-behavior.md).

## Shared Persistent State

Teardown cannot establish correctness for shared persistent state. Another
file or worker can observe, overwrite, or depend on that state before
`afterEach` or `onTestFinished` runs, and a crashed test may not run teardown at
all. A test must therefore be correct while other API tests execute
concurrently, even if its cleanup has not happened yet.

Give every test uniquely owned, explicitly addressable users, organizations,
providers, storage identities, external entities, cache namespaces, and rows.
When a production cron scans a global table, keep production behavior global
but drive correctness through a test-only route whose request names the owned
IDs. Production-global routes may be mounted only by the focused contract
harness for fixed missing/wrong-auth assertions. Do not isolate tests with a
global lock, test ordering, worker serialization, broad clock partitions,
snapshot/restore of shared rows, or residue-tolerant assertions.

Operator-managed usage-pricing identities and the fixed production staff
organization are shared production data. Use `createUsagePricingFixture()` to
map a logical canonical provider to a UUID-owned physical lookup row, and use a
unique organization fixture for entitlement writes. Fixed production
identities remain valid in read-only/hash/auth behavior. Raw pricing mutation
helpers are only for providers already proven UUID-, run-, or fixture-owned.

Cache assertions own their key or namespace. Set and advance mocked time inside
the test that exercises the TTL; never stagger tests with a module- or
describe-scoped counter to outlive another test's cache entry. Process-wide
caches and overrides need an explicit request/test owner and scoped reset
semantics, such as an `AbortSignal` or async-local boundary.

Cleanup is still useful after ownership establishes correctness. It may remove
rows and resources created by that test, and it should terminate or release
test-owned handles, `AbortController`s/signals, MSW handlers, connections,
sockets/streams, detached work, and temporary files. Such cleanup bounds
residue and resource lifetime; it must not delete, overwrite, or restore
pre-existing shared state to make an assertion pass.

## Commands

Run route-focused tests from `turbo`:

```shell
pnpm -F api exec vitest run src/signals/routes/__tests__/agents.test.ts
pnpm -F api lint
pnpm -F api check-types
```

### TypeScript toolchain

`tsc` in every workspace is the TypeScript 7 native compiler, installed as the
`@typescript/native` alias of `typescript@7`. Tools that need the compiler API
(`knip`, `typescript-eslint`, `@typescript-eslint/rule-tester`, the repository
scripts under `scripts/`) resolve `typescript` to the `@typescript/typescript6`
compatibility package, which ships the 6.0 API and a `tsc6` binary. Do not
import from `@typescript/native`; it has no API until TypeScript 7.1.

Every native `tsc` invocation in the API and app type-check scripts passes
`--checkers $(node ../../scripts/tsc-checkers.mjs)`. By default, the helper uses
one checker per 4 GiB of RAM, capped by the CPU count and by 4, so a 2 vCPU /
4 GiB sandbox runs one checker. The GitHub `lint-type-app` and `lint-type-api`
jobs and the Lefthook type check set `TSC_CHECKERS=2` to reduce peak memory
while retaining parallel checking. Set `TSC_CHECKERS` explicitly to override
the machine-sized default for other runs. On macOS with a hard-linked pnpm
store, run `tsc` with `--singleThreaded` until the next TypeScript 7 stable
includes the parallel-loading realpath fix (typescript-go #4262).

Run one Vitest process at a time.

### API type-check projects

The API checks seven programs, one native compiler process at a time. Each
compiler exits before the next starts. The declaration-producing projects use
`composite`, `emitDeclarationOnly` and independent build information. Downstream
projects set `disableSourceOfProjectReferenceRedirect` and consume those `.d.ts`
outputs, keeping upstream implementation graphs out of later checks.

| Project              | Root ownership                                                   | Declaration dependencies          |
| -------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `gateways`           | The explicit SDK gateway files                                   | Pi runtime build                  |
| `core`               | Foundation, services, libraries, mocks and production scripts    | Gateways                          |
| `routes`             | Production files under `src/signals/routes`                      | Gateways, core                    |
| `bootstrap`          | The four production entry/registration modules                   | Gateways, core, routes            |
| `tests-0`, `tests-1` | The canonical test, bench and fixture roots, partitioned by path | Gateways, core, routes            |
| `bootstrap-wiring`   | The dedicated bootstrap wiring test                              | Gateways, core, routes, bootstrap |

`tsconfig.tests.json` is the authoritative test-root manifest; it is not an
additional checked program. `scripts/prepare-typecheck-tests.mjs` parses it with
the installed TypeScript compiler API, normalizes package-relative paths to
`/`, sorts them, and assigns each root with `sha256(path)[0] % 2`. It writes
`.typecheck/tsconfig.tests-0.json` and `tsconfig.tests-1.json` with exact `files`,
`include: []`, package-root `rootDir`, rebased explicit project references and
separate `tests-0.tsbuildinfo` / `tests-1.tsbuildinfo`. References do not inherit
through `extends`. Unchanged configs are not rewritten; additions, deletions and
renames regenerate membership without maintaining lists by hand.

The Node fixture suite uses the `.node-test.mjs` suffix so Vitest does not
collect `node:test` registrations as an empty Vitest suite. It still runs on
every boundary check through the explicit `node --test` command.

The boundary gate runs small Node temporary-file regression tests, prepares the
test configs, then checks the seven actual root sets against the complete API
manifest. It also checks production JSON ownership across core and routes,
rejects stale or modified generated test configs, and retains the import and
Drizzle guards. JSON needs explicit include patterns in composite projects;
`**/*` alone does not preserve it. Root counts are derived from current sources,
never pinned to a historical count.

From `turbo`, the public commands remain:

```shell
# Pi declarations -> regression tests/preparation/boundaries -> gateways ->
# foundation -> routes -> bootstrap -> test 0 -> test 1 -> bootstrap wiring
TSC_CHECKERS=2 pnpm --filter api run check-types

# Standalone aggregate core: prepare both declaration prerequisites first.
TSC_CHECKERS=2 pnpm --filter api run check-types:deps
TSC_CHECKERS=2 pnpm --filter api run check-types:gateways
TSC_CHECKERS=2 pnpm --filter api run check-types:core

# Standalone tests: core includes routes; run it after the prerequisites above.
# This entrypoint always refreshes the manifests, even without the boundary gate.
TSC_CHECKERS=2 pnpm --filter api run check-types:tests
```

Incremental runs reuse per-project build information but still refresh test
membership and run every compiler in dependency order. After upstream source or
declaration changes, rerun the aggregate command or rebuild the standalone
command's prerequisites. Missing upstream outputs mean missing prerequisites,
not a downstream type error. To reset all API artifacts, remove
`apps/api/.typecheck`; this removes declarations, generated manifests and build
information together. Do not compile a generated test config directly after
changing membership: use `check-types:tests`.

### Constrained memory measurements

Compare the baseline and candidate on identical production/test sources and a
locked `pnpm install --frozen-lockfile`. Record exact base/candidate SHAs,
lockfile hash, Node/pnpm/compiler versions, CPU quota, `memory.max`, swap state,
command, exit status and before/after `memory.events`. Use the issue's resource
limits (`memory.max <= 3996565504`, two vCPU equivalent, no swap),
`TSC_CHECKERS=2` and the existing outer Turbo concurrency of one.

Measure these three subjects separately, serially:

1. Standalone API: remove `apps/api/.typecheck` and
   `packages/pi-agent-runtime/dist`, then run the complete API command above.
2. Aggregate core: prepare Pi and gateway declarations first, then remove
   `.typecheck/core`, `.typecheck/routes` and their two `.tsbuildinfo` files before
   running `check-types:core`. Keep prerequisite preparation outside this sample.
3. Full cold repository: remove workspace-local `.typecheck`, `.tsbuildinfo` and
   `.turbo` outputs, plus Pi `dist`, then run
   `TURBO_FORCE=true TSC_CHECKERS=2 pnpm check-types`. Verify zero cache hits.

Use `scripts/measure-memory.mjs` (250 ms sampling) around the complete command,
including its descendant processes, and retain logs and JSON results. API and
full measurements include the generator, boundary guard and Node regression
tests. Record a checkpoint before any resource guard or timeout and ensure all
descendants have exited before starting another subject. An OOM, timeout or
protective stop is censored evidence: report sampled time and RSS as lower
bounds, never as a completed baseline. Diagnose an OOM before any further run.

The acceptance targets are peak process-tree RSS at most 2858.6 MiB for each
subject and a full cold wall time at most 300 seconds, with no OOM event delta.
Also validate clean/incremental checks, source and declaration edits, file
addition/deletion/rename, and representative seeded errors across the declaration
boundary and in both test groups. Inspect compiler `--listFilesOnly` output to
confirm downstream programs consume upstream declarations.
