# Issue #37513: D1 internal callback delivery bookkeeping

Related to #37513. Bounded WRITE-only acceptance; not complete callback,
cancellation, or epic migration. Practice/base revision:
`26e1e57c16f13ecea61441b52b30927e8f79a674` (fresh main after the assigned revision).

## Actual closed caller chain and interface

Completion/recovery, cancellation, Pi worker, and existing workflow execution
route call `dispatchRunCallbacks$`. That command is the only direct caller of
`dispatchSingleInternalCallback$`. Its internal branch no longer passes `db`.
`DispatchInternalRunCallbackInput` no longer contains a database capability, so
`callbackEnvelope(input)` also receives only callback/business facts.

The private, package-scope `recordInternalCallbackDelivery$` is the single
bookkeeping node. It accepts a plain callback ID, a discriminated
attempt-started/delivered/failed stage (error string only for failed), and the
caller-owned final positional `AbortSignal`. It locally calls `set(writeDb$)`
and directly executes one existing UPDATE. No handle/accessor/node/executor
argument, factory-at-command-time, intermediate state slot, callback adapter,
re-export, or additional public signal is introduced. No new import edges or
eager imported-node reads are introduced.

Internal order remains attempt persistence → original abort check →
`settle(dispatchInternalCallback$)` → original abort check → result persistence
→ original abort check → existing return/log behavior. The SQL-owning command
also checks the same caller signal immediately after its uninterruptible SQL
await; parent checks remain at their original locations. There is no new
pre-SQL cancellation check. Thrown dispatch errors keep their existing Error
message/Unknown error classification, reported unsuccessful deliveries retain
their error, and bookkeeping failures still propagate. No retry/recovery,
concurrency, deduplication, or terminal business-marker behavior is strengthened.

## SQL, clocks, bindings, decoders and transaction accounting

Offline Drizzle `.toSQL()` evaluation of the actual old helper and new command
expressions gives identical SQL and ordered bindings for all three shapes with
one fixed synthetic callback ID, error string and clock:

| Stage     | SQL SET columns           | Ordered bindings                         |
| --------- | ------------------------- | ---------------------------------------- |
| Attempt   | attempts, last_attempt_at | 1, nowDate timestamp, callbackId         |
| Delivered | status, delivered_at      | delivered, nowDate timestamp, callbackId |
| Failed    | status, last_error        | failed, error string, callbackId         |

Every WHERE remains `agent_run_callbacks.id = callbackId`. Attempts remains an
assignment of **1**, not an increment. `nowDate()` is still evaluated at the
attempt/delivered UPDATE, not dispatch start or database clock. Failed does not
call it. No old lastError/deliveredAt is cleared. There is no RETURNING, selected
row/decoder change, schema/payload change, or historical row reinterpretation.

Successful or unsuccessful completed internal delivery still executes exactly
two UPDATEs/round trips: attempt plus one result. Abort/SQL failure can stop at
the same partial boundary. Existing outer reads/feature lookup are unchanged.
Explicit transactions before/after: **zero**; removed/combined/retained/moved:
**zero**. Each UPDATE keeps its existing autocommit atomicity. No CAS, new lock,
transaction, query, index/hint, timeout or retry is added. Identical generated
SQL introduces no query-shape change; no production EXPLAIN or performance
improvement is claimed. These serialization checks are not behavioral tests.

## Explicit retained capabilities

- `DispatchRunCallbacksInput.db` and its Run/callback READ queries remain.
- HTTP `DispatchSingleCallbackInput.db` and `dispatchHttpCallback` remain.
- `markCallbackAttemptStarted(db, callbackId)` remains for HTTP attempt writes.
- `markCallbackDelivered(db, callbackId)` remains for HTTP successful delivery.
- `markCallbackFailed(db, callbackId, error)` remains for HTTP missing URL/secret,
  thrown fetch and non-OK responses.
- `undeliveredChatCallbackIdForRun` READ handle and deleted-thread cleanup remain.
- Pi phase2's handle and chat/Feishu/workflow callback owners remain.

AST-normalized comparison confirms HTTP dispatch and all three helpers are
unchanged, as are envelope construction, undelivered READ and deleted-thread
cleanup. HTTP remains non-cancellable as before; its existing outer abort
boundary is untouched. No unrelated owner is moved to solve this slice.

## Public coverage and verification

Existing route coverage is retained without modifications: chat-callback BDD
partial-side-effect recovery checks completion HTTP response, cancellation
lifecycle marker and one replacement after duplicate completion/cancellation;
normal/failed rounds and billing recovery markers remain covered. Run-lifecycle
covers cancellation-driven chat callbacks and retained ordinary-HTTP no-redelivery
behavior. Workflow scheduler covers cron/loop callback-driven nextRunAt via reads
and disabling after repeated failure; related workflow callback suites remain.
These preserve real response/repeat/recovery/terminal-marker outcomes; no new
internal node/SQL/DB-row/log assertion or production hook is added. No behavior
change or distinct publicly constructible regression gap requires duplicating
these scenarios solely for node ownership.

Local affected formatting/ESLint, normal API Oxlint (including import-cycle and
128-line rules), type-aware Oxlint and complete API check-types with one checker
pass. Knip fails before analysis in oxc-parser with `RangeError: Array buffer
allocation failed`; this is incomplete, not a pass. No local Vitest/devserver.
Exact-head eight API shard/four required gate results must be recorded on the PR
before stopping for independent coordinator review; this slice has no merge,
pr-auto, release or deployment authorization.

## Main integration and retained failure history

The original D1 head `c8af6348b498d104fba239e2d32d4b50d1fee576` failed
run `37182434671`: API shard 4 reported a concurrent get-started check-in
500 / PostgreSQL `23505` on `uq_get_started_reward_key`; the Turbo gate failed
and API shard 1 was cancelled, not passed. That run is not rerun or reclassified
as acceptance. Passing callback suites alone do not close the blocker.

Ordinary main integration uses `cf155ac9e19c1ce08a1a55fa43f97ff5da358d7f`,
which contains the separately reviewed and merged reward conflict fix #37683
at `1261224f046ba759c162f5e35b9aebdc65334023`. D1 does not modify that fix,
reward tests, or D2 cleanup. The callback service remains byte-identical to the
original D1 head. Relative to integrated main, the slice still contains only
this acceptance document and internal callback bookkeeping ownership.

Prior environment-only failures (missing worktree, non-project `lost+found`
permission denial, and missing Git committer identity / exit 128) remain
failures; they are not product failures or passing checks. Normal project setup
restored the existing branch and hooks, and the authorized repository-local
identity was verified without rewriting published history.

New-head static/type results, all eight API shards, four required gates and
public callback/lifecycle coverage must be verified independently on the PR.
Neither main integration nor the reward fix establishes exhaustive corruption
boundary coverage or authorizes queue admission/merge. No local Vitest or
devserver, blind old-run rerun, new lock/retry/timeout, or suppression is used.
