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
In shared PostgreSQL, drive cron behavior through a scoped test route whose
request names the owned IDs. Cases that exercise successful global writes use
an isolated database as described below. Keep production behavior global; do
not change its schema or filtering solely for test isolation. Do not isolate tests with a
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

### Case-owned Database Selection

All API suites run in one `api` project with one shared setup. Files execute in
parallel; cases within each file execute serially. Database choice belongs to
the case, not to its filename, a Vitest project, tags, or metadata.

Ordinary cases use native PostgreSQL. `setupApp({ context, routes })` stays
synchronous and returns the contract-client factory. Cases that write global
state, such as publishing a connector or official workflow catalog or changing
canonical model pricing, initialize an isolated PGlite through `setupApp`:

```typescript
const context = testContext();

it("lists the current catalog", async () => {
  const client = setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
  await accept(client.list({ headers: authHeaders() }), [200]);
});

it("publishes a replacement catalog", async () => {
  const app = await setupApp({
    context,
    routes: cronConnectorCatalogRoutes,
    isolatePg: true,
  });
  // Prepare the external catalog through context.mocks, then call its route.
  const client = app(cronConnectorCatalogContract);
  await accept(client.sync({ headers: cronHeaders() }), [200]);
});
```

Call and await isolated setup before any fixture, service, or request accesses
the database. Switching after shared PostgreSQL was accessed throws. Repeated
isolated setup in one case reuses its database. Later ordinary `setupApp` calls
inherit the case's database; omitting `isolatePg` never switches an isolated case
back to shared PostgreSQL. The same binding covers direct fixture writes,
services, HTTP requests, and their asynchronous background work.

Select isolation in the case's first real API request or API fixture operation,
and use the returned client. Do not initialize it with an unused client, an
empty route slice, or a database cleanup action. Each case receives a separate
engine; keep `testContext()` at module or describe scope.

An isolated database is discarded after the case. Do not enumerate and delete
its rows in teardown, clear catalogs before starting, or republish an obsolete
catalog just to delete its accounts. Keep business deletion assertions and
cleanup that stops background work, releases external resources, or restores
external mocks. Shared PostgreSQL fixtures still own and clean up their rows.

`src/__tests__/global-setup.ts` seeds the shared PostgreSQL pricing and complete
fixed connector catalog once per run. It also migrates and seeds one PGlite,
saves a checkpointed immutable snapshot, and provides its path to workers.
The fixture caches the unpacked files for subsequent cases. Each isolated case
creates a fresh engine and memory filesystem with its own writable copies; cases do not
repeat gzip/tar decoding, replay migrations, or reseed their database. Shared
fixture installation uses `ifAbsent: true` and must never replace an existing
catalog pointer.

`src/__tests__/external-setup.ts` restores the fixed source and provider
configuration and installs a fresh KMS mock before each case. The mock remains
available through finished callbacks and is cleared after the file. Shared
PostgreSQL cases may read the seeded catalog but must not rotate, mutate, or
delete its authority. Readers use a
current pointer keyed only by schema version; changing the S3 bucket does not
isolate that pointer. Catalog-generation and publisher cases therefore use
`isolatePg: true` and publish their prerequisites into their own databases.
Users, organizations, accounts, credential storage, and encrypted values still
use explicit case ownership.

Catalog tests assert API-visible publication, discovery, account, and runner
compatibility behavior. They do not assert SQL counts or text, attach engine
loggers, or corrupt database entries and constraints to test infrastructure
failure recovery.

Cases in one file execute serially. `setupApp` selects the current case's database
without an async-local scope or a database `aroundEach` wrapper. `testContext`
registers final disposal before user cleanup callbacks. Foreground work is
aborted before API-based cleanup, which receives a live signal. Final disposal
runs after those callbacks, aborts cleanup work, drains tracked detached and
`waitUntil` work, and closes the isolated engine, including initialization that
was still pending when a case failed. Background work must remain tracked and
finish within its case; database selection does not identify untracked work
that leaks into a later case. Services, routes, fixture writers, and SQL remain
real; only the centralized database transport selects the current database.

`api/no-test-database-binding` confines PGlite engine imports and construction to
`src/test-fixtures/pglite-database.ts`. Case-local database mocks and service
mocks remain forbidden. The harness preserves node-postgres int8/numeric text
decoding through PGlite's driver parsers, without rewriting query results or
weakening schemas.

PGlite has a single PostgreSQL session. Keep contracts that require the native
PostgreSQL protocol, such as query cancellation, on native PostgreSQL. For cases
that write global state, use PGlite and assert business-visible transaction
outcomes: a prepared Run retains its captured catalog, while a later Run uses
the newly published catalog. Do not preserve a multi-connection lock-state
assertion just to retain the previous test mechanism. Never hold advisory locks,
inspect `pg_locks`, or install transaction barriers or internal admission gates
to construct an API scenario. Exercise requests and assert their responses and
subsequent user-visible state; do not redirect outside queries into an active
transaction or increase timeouts to make an incompatible test pass.

Drive the real compaction worker through `compactUsageForTest(orgId, signal)` with an explicit
test-owned organization. Never substitute a successful global sweep over
another test's rows or add lock-waiter observations or pause points. X-resource
retention tests use the resource-ID-scoped test route to construct historical rows and a
request-scoped database clock; never invoke a successful production-global
cleanup in a shared test database.

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

The API checks ten programs, one native compiler process at a time. Each
compiler exits before the next starts. The declaration-producing projects use
`composite`, `emitDeclarationOnly` and independent build information. Downstream
projects set `disableSourceOfProjectReferenceRedirect` and consume those `.d.ts`
outputs, keeping upstream implementation graphs out of later checks.

The public entrypoints use fixed stage functions in `scripts/check-types.sh`.
The aggregate calls them synchronously in the package environment and stops on
the first nonzero exit or signal. This avoids launching a new pnpm process for
every stage. Commands have one definition; dispatch never evaluates command text
from configuration or arguments.

| Project                         | Root ownership                                                                              | Declaration dependencies                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `gateways`                      | The explicit SDK gateway files                                                              | Pi runtime build                                         |
| `foundation`                    | The explicit database, billing, artifact and remote-access dependency closure               | Gateways                                                 |
| `admission`                     | The explicit execution admission, queued-launch and integration callback dependency closure | Gateways, foundation                                     |
| `core`                          | Remaining services, libraries, mocks and production scripts                                 | Gateways, foundation, admission                          |
| `routes`                        | Production files under `src/signals/routes`                                                 | Gateways, foundation, admission, core                    |
| `bootstrap`                     | The four production entry/registration modules                                              | Gateways, foundation, admission, core, routes            |
| `tests-0`, `tests-1`, `tests-2` | The canonical test, bench and fixture roots, partitioned by path                            | Gateways, foundation, admission, core, routes            |
| `bootstrap-wiring`              | The dedicated bootstrap wiring test                                                         | Gateways, foundation, admission, core, routes, bootstrap |

`tsconfig.tests.json` is the authoritative test-root manifest; it is not an
additional checked program. `scripts/prepare-typecheck-tests.mjs` parses it with
the installed TypeScript compiler API, normalizes package-relative paths to
`/`, sorts them, and assigns each root with `sha256(path)[0] % 3`. It writes
`.typecheck/tsconfig.tests-{0,1,2}.json` with exact `files`,
`include: []`, package-root `rootDir`, rebased explicit project references and
separate `tests-{0,1,2}.tsbuildinfo` files. References do not inherit
through `extends`. Unchanged configs are not rewritten; additions, deletions and
renames regenerate membership without maintaining lists by hand.

The Node fixture suite uses the `.node-test.mjs` suffix so Vitest does not
collect `node:test` registrations as an empty Vitest suite. It still runs on
every boundary check through the explicit `node --test` command.

The boundary gate runs small Node temporary-file regression tests, prepares the
test configs, then checks the ten actual root sets against the complete API
manifest. It also checks production JSON ownership across foundation, admission,
core and routes, rejects stale or modified generated test configs, and retains the
import and Drizzle guards. Foundation imports may reach only its own roots and
gateways; admission imports may additionally reach foundation. Imports of downstream
implementations, including type-only imports, re-exports and dynamic imports, fail
the gate. New dependencies must preserve these declaration boundaries, not silently
reload core implementations. JSON needs explicit include patterns in composite projects;
`**/*` alone does not preserve it. Root counts are derived from current sources,
never pinned to a historical count.

From `turbo`, the public commands remain:

```shell
# Pi declarations -> regression tests/preparation/boundaries -> gateways ->
# foundation -> admission -> core -> routes -> bootstrap -> tests 0/1/2 -> bootstrap wiring
TSC_CHECKERS=2 pnpm --filter api run check-types

# Standalone aggregate core: prepare Pi and gateway prerequisites first.
# This command checks foundation, admission, core and routes in order.
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
   `.typecheck/foundation`, `.typecheck/admission`, `.typecheck/core`,
   `.typecheck/routes` and their four `.tsbuildinfo` files before running `check-types:core`. Keep prerequisite
   preparation outside this sample.
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
boundary and in all three test groups. Inspect compiler `--listFilesOnly` output to
confirm downstream programs consume upstream declarations.
