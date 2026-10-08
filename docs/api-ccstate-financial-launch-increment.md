# Financial pending-launch ownership increment

This is an integration increment for Draft PR #37525, based on `12dee7d527`.
It is **not** terminal conformance with the API ccstate target. Apply the commit
to the parent branch; do not replace the parent branch with this worker branch.
Pricing, selection, catalog ownership, event APIs and allowance APIs remain
owned by their assigned workers.

## Changed interface and consumers

In `agent-run-execution.service.ts`:

- `CommitPreparedLaunchArgs` no longer contains `db`.
- `buildAtomicLaunchCteContext(args, creditAdmitted)` takes only launch facts.
  Its args contain the prepared commit, payload, validated thread snapshot and
  captured account identity; there is no `tx` property.
- `persistPendingAtomicLaunch` is removed. Its consumers use
  `pendingAtomicLaunchPlan(args, context)` (non-executing CTEs, structured
  selection, relations and join predicate) and
  `pendingAtomicLaunchResult(args, context, row)` (pure validation/result and
  billing attribution write description).
- `ValidatedThreadSessionSnapshot` no longer stores a transaction in a Symbol.
  It is a frozen plain snapshot. Existing callers use it within the same
  transaction; this does not establish validation for arbitrary future callers.
- Private package-stable `commitPreparedLaunch$` and `persistPreparedLaunch$`
  replace the direct launch's helper-owned transaction. `createRun$` dispatches
  them through ordinary ccstate accessor calls. The latter obtains `writeDb$`
  itself and executes pending row/attribution/native-session/active-run SQL
  inside its own callback.
- `PersistAtomicLaunchRowsArgs`, `persistAtomicLaunchRows`,
  `commitPendingPreparedLaunch`, `activatePreparedLaunchUsageAllowance`,
  `finishAdmittedLaunch` and `lockOfficialWorkflowLaunchPlan` are removed.

`pick-chat-run.service.ts` adapts its existing pending writer to the pure plan
and pure result exports, performs the structured select and attribution write
locally, and no longer supplies a database in the prepared commit.
Its rejection graph and Morning Brief producer predicates are unchanged.

`pending-launch-sql.ts` exports only `pendingLaunchInsertSql` and
`pendingLaunchUpdateSql`. These use the installed public `PgDialect` APIs,
schema column encoders and SQL parameters. They construct SQL and have no
session, database, transaction, execution method or injected signal node.
The CTEs use public non-executing `QueryBuilder` construction. Structured
results keep concrete schema-column/nullable decoders. No raw execution wrapper
receiving a handle has been introduced.

## Consistency and recovery boundaries

The pending financial transaction is retained, not removed. It keeps Run,
Runner queue, explicit R1 attribution, producer binding, allowance activation
and unique active-run admission together. The unique active-run insert remains
the final SQL statement; conflicts roll back the preceding pending writes.
Attribution conflict still throws rather than silently accepting unrelated
history. Thread binding still uses its captured Run-ID CAS and throws when the
update returns no bound thread. Native-session reset executes before sampling
the Run creation timestamp. The queue retains its original creation timestamp
construction inside the persistence measurement.

The pick path retains its lease fence, producer SQL statements, pending visibility
and final active-run insert. Official workflow/catalog fences, subscription
validation and allowance window identities have not been removed or weakened.
Resource preparation, orphan eligibility and recovery are unchanged.
These are source-level preservation statements, not a new runtime acceptance
claim.

## Explicit residual gaps

- `commitPreparedLaunchAdmission` / `commitValidatedPreparedLaunch`,
  `validateClaimedRunAdmission` and `persistClaimedRun` still receive `tx`.
- Thread/session and subscription validation helpers still receive `tx`;
  removing the Symbol did not complete their query ownership migration.
- `persistThreadSessionBinding` still executes SQL through a passed transaction.
- Official catalog admission, credit-plan read, queue-first event claim,
  Pi-memory scheduling and allowance activation still call legacy helpers with
  a transaction. Integrate the assigned event/allowance/pricing changes before
  replacing these boundaries with pure plans or owner-local execution.
- Direct launch's legacy `persistProducerRunBinding` callback still receives
  `tx`; this requires producer caller adaptation. Pick's producer statement
  plans remain intact.
- `AtomicLaunchRunInput` and unrelated read/failed-run graphs are not governed
  by this increment. In particular, deleting `db` from the prepared commit does
  not imply that every upstream input graph is handle-free.

Do not count these remaining calls as compliant because the new CTE builders
are pure. There is no new public command/computed injection, runtime command
construction, sessionless database wrapper, suppression, retry, lock, timeout,
test hook or database-row assertion.

## Verification

On the worker branch, full API `TSC_CHECKERS=1 pnpm check-types`, affected
Prettier/ESLint, the 128-line owner rule on the execution service, plain API
Oxlint, affected production type-aware Oxlint and API-scoped Knip passed.
Knip reported only two existing configuration hints. The full API production
type-aware Oxlint process was terminated with exit 137; the full type-aware
suite is not claimed to pass. No Vitest, development server or behavioral
verification was run. Parent integration and CI remain required.

## Second writer increment (base `5b7e380fbf`)

This section supersedes the first increment's interface and residual inventory
where they differ. It is still not terminal architectural conformance.

- Remove `validateClaimedRunAdmission`, `persistClaimedRun` and
  `commitCapturedRun$` from pick. Remove the separate `persistPreparedLaunch$`.
  Both callers dispatch the package-stable `commitPreparedPendingLaunch$` with
  a plain prepared commit and optional captured claim/producer facts. The command
  returns the actual commit result; entries record transaction-return time and
  finish telemetry. No command/computed or executor is injected.
- The shared command obtains `writeDb$` and performs pending writes in its own
  transaction. The captured token fence remains after the input claim and before
  Run persistence. Active-run uniqueness remains the final SQL statement.
- Move producer SQL, token-fence SQL/result validation, R1 SQL construction and
  allowance CAS/window preparation into pure supporting plan files. There are
  no database or transaction arguments in these new helpers.
- Capture R1 attribution in a data-modifying CTE depending on the inserted Run
  key. Preserve the exact historical `ON CONFLICT ... WHERE` comparison; absence
  of the captured Run ID throws and rolls the launch back. Run creation time
  remains sampled after native-session reset, and Runner queue timestamps retain
  their existing sampling boundary.
- Keep allowance publication, missing-window insertion and window identity reads
  in the shared owning transaction. Publication returns the actual snapshot;
  insertion uses that snapshot. The identity read deliberately remains a later
  statement so a concurrent `ON CONFLICT` winner is visible. No windows are
  issued after entitlement expiry; already-issued windows retain their existing
  availability behavior. Pick now explicitly carries its prepared allowance
  refresh into the shared commit, preserving both activation paths.
- `buildAtomicLaunchCteContext`, `pendingAtomicLaunchPlan`,
  `pendingAtomicLaunchResult` and the session/subscription helpers become private
  because pick no longer imports them. `commitPreparedPendingLaunch$` is the only
  added public node. The pure result no longer returns a separate billing write
  description because that write is included in its SQL plan.
- Preserve parent commit `0ad8faa5e9`'s empty-returning fix. This increment does
  not edit `pending-launch-sql.ts` and depends on that fix.

Remaining violations are explicit: the shared writer still forwards `tx` to
`commitPreparedLaunchAdmission` and its session/subscription/queue-first helpers,
Official catalog fencing, credit-plan reads, Pi-memory scheduling and fallback
session binding. Direct producers still use their legacy transaction callback.
The deleted pick wrappers are not proof that these remaining calls conform.

For this second increment, only affected Prettier, ESLint, normal Oxlint and the
explicit execution-service 128-line rule were checked. Full types, Knip,
whole-API type-aware lint and CI are reserved for the parent; no Vitest or dev
server was run. The earlier verification record applies only to the first
increment, not to the integrated second increment.
