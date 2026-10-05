# Sandbox storage commit initial receipt READ ownership

Related to #37513. D10 is the independent initial storage receipt READ slice
approved from D9 section 10. Full D9 preparation maintenance closure and D7
cancellation-redrive identity ownership remain deferred. This is not whole
storage, checkpoint, Db/Tx, or exactly-once closure.

## Scope and integration

Design baseline: `b190ff107eb5d387ee9b4eab6b42136b335a720d`. Authoring main:
`52fbc351e258b79ac0e9a104a46247d695ac959e`. The two production files had zero
upstream delta between these revisions; the branch fast-forwarded normally
while preserving its bounded uncommitted service work.

Only `storage-write.service.ts`, `webhooks-agent-storage.ts`, and this document
change. The old `commitStorageUploadForAuth$` global command is replaced, not
wrapped for compatibility. Its only production consumer was `commitStorage$`.
`createSandboxStorageCommit(args: CommitStorageInput)` exposes only `{ commit$ }`.
The command receives only the caller's final positional `AbortSignal`.

The existing commit-input projection and maintenance binding conditions are
unchanged. They now derive synchronously from verified, validated plain request
values during graph construction. This constructs no query, provider, clock,
HMAC, additional parser, accessor transport, state slot, or manual cache.
The private receipt computed is constructed only for an existing valid binding
and obtains `get(db$)` locally. No internal node is injected into another owner.

The route's request computed awaits its existing validated body source and
constructs an inert authorization node only for a valid body. The route then
keeps body await -> original abort check -> bad-body return -> first synchronous
authorization consumption. Sandbox verification occurs once, inside that sync
node, before immediately constructing the service graph. There is no async
authentication gap. The exact input spread order remains
`{ auth: { tokenType: "sandbox", userId, orgId, runId }, ...body }`.
The prepare handler's bytes remain equal to the original baseline.

## SQL contract and query counts

The private initial receipt query retains the original helper's `.select()` on
the official `piMemoryPhase2Checkpoints` table. Its ten ordered fields are:
`runId`, `memoryStorageId`, `orgId`, `userId`, `leaseToken`, `claimedRevision`,
`claimedBaseVersionId`, `selectionDigest`, `versionId`, `createdAt`.

It retains eight ordered equality predicates and LIMIT 1, with no ORDER BY,
lock, new guard, or predicate. Ordered bindings are
`[runId, memoryStorageId, orgId, userId, leaseToken, claimedRevision,
claimedBaseVersionId, selectionDigest, 1]`. The three UUID identities, text
owner identities, integer revision, three varchar hashes, and timestamp retain
the official schema's encoder/decoder ownership. All fields remain non-null;
missing row remains `undefined`. No NULL coercion or fabricated version/date is
added. Schema constraints, Run primary key and storage-owner FK are unchanged.

A repository-external offline audit extracts the actual old helper and new
private computed query expressions using installed TypeScript, builds both
through the real installed public ESM Drizzle mock builder and official schema,
and compares generated SQL, ordered bindings, every selected schema object and
encoder/decoder provenance. It also exercises the existing timestamp decoder.
It connects to no database and executes no SQL. This is serialization and
schema evidence, not runtime query, plan, race, or public acceptance evidence.

| Original branch                                       | Mounted SELECTs | Initial receipt SELECTs |
| ----------------------------------------------------- | --------------: | ----------------------: |
| Missing Run or missing writeback mount                |               1 |                       0 |
| Mount exists but its authoritative Storage is missing |               2 |                       0 |
| Mounted success, binding absent                       |               2 |                       0 |
| Mounted success, binding present                      |               2 |                       1 |

The absent-binding branch remains immediate `undefined`: no extra await or
provider access is introduced there. The bound branch awaits the private source
only at the original conditional receipt position. The existing post-receipt
abort check is retained in both branches.

A receipt replay mismatch still returns 404 before a version READ; a matching
receipt still reads its version once, checks abort, returns the original missing
version 404 or deduplicated response, and does not enter the ordinary commit.
No-receipt terminal retries still read version once and conditionally lineage
once, with their original checks and 404 behavior. All ordinary commit and
transaction query counts remain branch-dependent and unchanged.

## Provider, lifecycle, and transaction ledger

The command first calls `set(writeDb$)`, then awaits the actual mounted helper
with the same signal, checks abort, and returns mounted errors before consuming
the initial receipt computed. Both provider nodes call the same lazy singleton
Drizzle/Pool provider in `lib/db.ts`; no replica or independent connection is
introduced. Original writer initialization and errors still precede mounted
queries and receipt access. The moved plain projection has no clock, query,
parser, or error-changing getter for the validated request objects.

Keep mounted read -> abort -> mounted error -> conditional receipt -> abort ->
receipt version/hash replay handling -> terminal status/version/lineage handling
-> existing generic commit -> original response conversion. Computeds capture no
signal. The finite receipt query remains uncancellable as before; the command
owns the post-await abort check. The request wrapper adds graph derivation, not
proof of exact body-resolution/auth-expiry microtask behavior.

Target READ transactions: zero. Transactions removed, combined, moved, added:
**zero**. The receipt producer and all genuine independent observers retain their
existing helper and temporal ownership:

- `guardPiMemoryPhase2MaintenancePublication`: callback/receipt/current job
  observations and the next-statement receipt recheck after job-lock waiting;
- `committedMaintenanceResponse`: receipt observation inside the generic Tx;
- `recordAndSettleMaintenanceCheckpoint`: receipt INSERT and settlement/fence;
- locked mounted Run, Storage, version and terminal persisted-state observations;
- terminal maintenance observers in other unchanged modules.

None consumes the cached initial receipt. Ordinary HEAD writes, active-Run
fences, no-diff acknowledgement without restoring base as HEAD, claimed-base
logic, lineage, slot, summary/index projection, external I/O, and weak receipt
semantics are unchanged. No new lock, CAS, lease-ownership guarantee, retry,
timeout, receipt protocol, outbox, or exactly-once claim is added.

Residual Db/Tx arguments in mounted/version/lineage, generic storage helpers,
prepare operations and maintenance owners are explicitly outside D10.

## Imports, normal checks, and coverage limits

Runtime additions are the existing official receipt schema, local `db$`, route
`computed`, and the service factory import. The route's Zod and `AuthContext`
imports are type-only.
There is no service-to-route runtime back-edge, dynamic import, suppression,
configuration exception, production test hook or 128-line exemption.

Applicable checks use the normal repository versions and effective executable
hooks, repo-local Ethan identity, no hook exclusions, and unchanged resource,
concurrency and timeout settings. Local Vitest and dev servers are not run.
Verification results and exact PR-head natural CI evidence belong in the handoff;
installation success is not project-check success.

Before the PR-first handoff, offline serialization/schema checks and scoped
Oxlint, type-aware Oxlint and ESLint passed. Full `pnpm -F api lint` exited 137;
its log contained only the script expansion, so the failing sub-stage and cause
are unknown. This remains a failed check, not an OOM diagnosis or PASS. It was
not retried. Full normal types, Knip, mandatory hooks and commit-message checks
had not yet run when the failure stopped authoring. The subsequent PR-first
instruction permits a normal commit attempt with all applicable hooks intact,
not a hook bypass or final-check waiver. Actual hook and natural CI outcomes
must be recorded separately against the resulting commit, if any.

The first normal commit attempt subsequently failed at API routes types with
TS2353: the direct factory argument contextually typed its nested auth literal
as the narrower `SandboxAuth`, which contains user/Run/org identity but not
`tokenType`. Fourteen of fifteen tasks succeeded with zero cache hits; API types
exited 2 and the commit exited 1. Prettier, style policy, Knip and file size
passed; commit-message validation did not run and no commit was created.
This type failure remains a failure. A separately approved source repair uses
a plain commit projection checked with `satisfies` against the existing sandbox
member of `AuthContext` and validated contract body shape. This retains literal
`tokenType: "sandbox"`, the original four auth fields and `auth, ...body` order,
then passes that structurally compatible plain value to the existing narrow
factory input. It adds no cast, global type expansion, parser or async step.
The new source revision permits one normal commit attempt with original hooks
intact, not a blind retry, full-lint rerun or exclusion.

A prior exact-edit attempt
was atomically rejected because its import replacement was ambiguous. That
failure remains a failure; separately authorized unique-context editing resumed
this slice without changing prepare or erasing the historical evidence.

Existing endpoint suites cover ordinary sandbox prepare/commit/dedup, malformed
auth/body, storage bounds and organization ownership, timeout write rejection,
committed retry and deduplicated HEAD-move retry through WHCB-09/10. Their actual
run counts and logs must be checked at the new PR head. These ordinary replay
cases are not private-maintenance receipt proof.

Exact private maintenance receipt public constructibility, lock-wait and
initial-vs-locked observation races, mounted-fact changes, abort/auth/body
microtask timing, and same-Store repeated graph consumption remain unproved.
The existing excluded `*.boundary.test.ts` maintenance suite is internal fixture
coverage, not a public PASS and is not run here. No tests are removed, weakened,
mocked internally or claimed as independent cases from one composite scenario.

There is no wire, contract, persisted shape, migration or feature-switch change.
Old/new Runner and API versions use the same endpoint and response schema;
rollback changes only internal query ownership, not receipt semantics. #37513
remains OPEN/PARTIAL. PR creation and CI handoff do not authorize merge, queue,
release, deployment, another owner's work, or full D9 implementation.
