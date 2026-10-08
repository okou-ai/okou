# Issue #37513: Run metadata write increment

Related to #37513. This is task A's bounded write increment, not completion of
Run output ownership or the overall refactoring target.

## Source and scope

Started from main `e85733c038` (newer than the assignment's `d7530e50e7`).
Changes cover `agent-run-metadata-write.service.ts`, `run-summary.service.ts`,
the metadata call in `agent-event-consumer-run-output.service.ts`, and existing
metadata callers in `test-runtime-state.ts`,
`test-cron-cleanup-sandboxes-state.ts`, and `test-telegram-state.ts`.
No cancellation, terminal-transition, Thread launch, Pi, or other output
processing implementation is rewritten.

## Public surface and actual call chains

- `writeRunMetadata$(args, signal)` owns an independent single UPDATE through
  `set(writeDb$)` and returns metadata rows (`id`, decoded `apiStartedAt`).
- `runMetadataWritePlan(args)` is a pure patch/predicate/returning plan. It takes
  only values and SQL predicates, returns no executable callback, and performs
  no I/O. It lets the existing mutation owner execute the statement locally.
- `normalizeRunMetadata(input)` and `RunMetadataValues` are unchanged: model
  normalization, autonomy default 10, and nullable fields retain their contract.
- Production chat and Feishu completion owners call `saveRunSummary$`, which
  generates auxiliary text then calls `writeRunMetadata$`. The old
  `saveRunSummary(db, ...)` interface is deleted; its best-effort persistence
  error boundary remains.
- Runner event ingress calls the existing output materialization owner, then
  `materializeAdmittedRunOutputEvents` / `claimFirstAssistantAcknowledgement`.
  Its existing auxiliary callback executes the metadata plan on `args.db`;
  it does **not** call the independent command. The same `id`, non-null
  `apiStartedAt`, and null `firstAssistantEventAcknowledgedAt` predicates still
  fence the first acknowledgement, with schema-column RETURNING decoders.
- Guarded runtime fixture actions dispatch stable commands for summary,
  API-start clearing, and autonomy patching. Guarded cron and Telegram fixture
  actions dispatch stable commands for thread attachment and selected-model
  patching. No new fixture API or production hook is added.

## Capability and transaction accounting

Metadata writer: both handle-taking APIs (`Db` and `Pick<Tx, "update">`) are
removed. Summary persistence no longer takes a handle. Migrated fixture
metadata paths no longer pass handles to a metadata writer. No database/node
bundle, state parameter slot, getter/setter adapter, escaping executor closure,
or graph constructed during command execution replaces those interfaces.

Transactions: **removed 1; combined 0; moved 0; retained 0 in this slice**.
The removed wrapper contained exactly one UPDATE and no local setting or
multi-statement invariant. A SQL UPDATE remains atomic without BEGIN/COMMIT.
Other transactions in the fixture files are untouched, not counted as removed
or as newly retained by this increment.

The refreshed main's output consumer already has **no transaction** at this
call site. This increment preserves its post-event-commit callback order and
optional metric-error handling; it does not claim cross-statement atomicity
that main does not have. Its existing `AdmittedRunOutputArgs.db`, auxiliary
closures and other handle-taking helpers remain follow-up ownership work.
Unrelated fixture/runtime handles also remain outside this task.

## Verification boundaries

Retained public route coverage includes `run-lifecycle.bdd.test.ts` assistant
projection, concurrent acknowledgements, Codex output and mixed-version runs;
`chat-callbacks.bdd.test.ts` completion and auxiliary storage failure behavior;
`auxiliary-generation.test.ts` caller cancellation; cron cleanup, Telegram and
runtime fixture consumers. Assertions are not weakened and no tests are
replaced with SQL-text or database-row assertions.

Offline query construction compares the old statement with the pure plan for
all six current patch shapes. UPDATE SQL, ordered bindings and schema-column
RETURNING are identical, including explicit null and timestamp encoding. This
is supplementary serialization evidence, **not** executed database behavior,
EXPLAIN, production performance, or preview acceptance. No material SQL shape,
index predicate, or result decoder changes are proposed.

No local Vitest or dev server is run. Local and exact-head CI results are
recorded in the PR body; incomplete checks are not passes. Independent review
and protected merge remain the coordinator's responsibility.

## Bounded cancellation-cleanup follow-up

Merge-group run `37173803361` passed all 51 files / 741 tests in API shard 7,
but failed on one pending `onUserConsoleLog` RPC rejection during worker teardown.
Source and logs establish a pre-existing cleanup gap: Vitest 5.0.2 runs
`onTestFinished` after shared `afterEach` drains, while the cancel API returns
before its `waitUntil` side effects finish. Existing cleanup callbacks created
new background work without awaiting it; logs show callbacks using a closed DB
pool. Successful same-head, independent-PR and main jobs exhibit this gap too.

The follow-up adds only `await flushWaitUntilForTest()` after the existing cancel
request in the three cancellation `onTestFinished` callbacks in
`test-runtime-state.test.ts`. Status lists, business assertions, imports and all
production code remain unchanged. No global hook, fixture or toolchain change
is made. Each cleanup now waits for the background work it creates.

This lifecycle gap is a strong candidate for the RPC failure, not a uniquely
proven cause: the failed RPC's payload and creating task are not recorded.
Green new-head CI cannot establish permanent elimination of that failure.
The original head's independent LGTM and merge permission do not cover this
follow-up. New-head review and protected-queue authorization remain required;
static and normal PR-pipeline acceptance evidence is recorded in the PR body.
