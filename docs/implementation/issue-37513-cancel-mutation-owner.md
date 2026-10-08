# Issue #37513: C1 cancellation mutation ownership

Related to #37513. This is the bounded WRITE step after the cancellation-state
READ factory; it does not complete the issue or migrate the side-effect chain.

## Owner and public callgraph

The five existing callers (runs-cancel, chat-thread, chat-events,
threadless-run-cleanup, and mcp-chat-cancellation) import the same stable
`cancelRun$` node directly from `agent-run-terminal-transition.service.ts`.
Its input remains Run/user/org identity, requested cancellation mode, optional
API start time, preserve-existing and protection flags; the final positional
argument remains the caller's `AbortSignal`. Its result remains the existing
HTTP error or `CancelRunResult`, not a database handle.

Inside that command, `set(writeDb$)` supplies the write connection and one
transaction owns the following operations:

1. Tenant-scoped Run SELECT FOR UPDATE and existing outcome classification.
2. Existing protected-threadless guard under the existing locks, if requested.
3. Pending/running conditional terminal UPDATE RETURNING. Empty RETURNING still
   throws `Locked cancellable run was not updated`, rolling back the transaction.
4. Diagnostic registration DELETE and execution of the unchanged pure
   `disconnectedPersonalAccountCleanupSql` plan.
5. Runner job queue DELETE.
6. Never-started active-slot DELETE RETURNING, **the last SQL statement**.
7. Commit, the existing post-await abort check, then slot picks before returning
   to the caller's existing side-effect orchestration.

Started Runs retain their slots. Missing/wrong-tenant and non-cancellable results
are unchanged. Settled cancellations stay idempotent; explicit hard upgrades,
`preserveExistingCancellation`, and legacy NULL-recovery hard semantics remain.
No Runner/Ably/callback/credit operation is added to the transaction.

## Capability boundary and explicit residuals

The command no longer passes its transaction into `cancelLockedRun`,
`transitionAgentRunsToTerminal`, or `releaseRunSlots`. The cancellation-only
helper file is deleted. The field projection, active-status predicate, result
mapper, never-started ID selector, and account-cleanup SQL planner are pure data
operations; they accept no Store/DB/executor callbacks.

The protected Pi registry still uses `lockCancellationProtection` and its
transaction callbacks. That existing guard is intentionally preserved, not
claimed migrated. Generic terminal helper callers, lifecycle READ factories,
side-effect DB handles/redrive, protection registries, Pi callbacks, and other
terminal paths are also deferred. Existing generic terminal helper APIs remain.

## Post-commit dependency and initialization

The single existing `scheduleReleasedSlotPicks$` implementation moves unchanged
into `agent-run-slot-scheduling.service.ts`. It imports only ccstate `command`,
`waitUntil`, `pickOrgQueuedChatThreads$`, and a **type-only** `ReleasedRunSlot`.
Org IDs are deduplicated, each org gets its own `waitUntil`, the original signal
is forwarded, and background picks are not awaited. Required callers import the
new node directly because the repository forbids re-exporting.

The old cycle was terminal → lifecycle → webhook-complete → terminal. Terminal
now imports the lightweight scheduler directly. Lifecycle retains its original
completion dispatcher and dependencies. No extra command, injected node,
callback adapter, dynamic import, or lint exemption is introduced.

The actual draft, including all five mutation callers and scheduling callers,
passes normal Oxlint/import-cycle checking. A supplemental source-resolved
runtime-import traversal (ignoring type-only edges and installed dependency
internals) covers 1,081 modules / 4,508 edges and reports no cycles. No eager
imported-node reads occur in the terminal, scheduling, or lifecycle module
initializers: cross-command reads are inside command closures. The Run projection
initializes from the already-imported schema, not another command. No new pure
field/result module is introduced. These are static findings, not a claim that
TDZ had occurred or a standalone proof of every runtime initialization path.

## SQL, mapping, and plan evidence

Offline Drizzle `.toSQL()` comparison evaluates the actual old/new query-builder
expressions without executing a database query. Locked SELECT, hard-upgrade
UPDATE, conditional terminal UPDATE RETURNING, diagnostic DELETE, Runner queue
DELETE, and slot DELETE RETURNING generate identical SQL and positional bindings
for fixed synthetic pending/cooperative input. Selected/returned key paths,
column identities/order and decoder types also match. The account planner is
unchanged and receives the same returned rows.

The terminal UPDATE binds cancelled status, effective mode, completion time,
Run ID and prior status; it returns Run/org/user/group/provider/start fields.
Slot release still returns Run/org only. There are no added joins, projections,
queries, round trips, transactions, index changes, hints, or pagination changes.
For an active Run the statement count remains `4 + P + A + S`: lock, terminal
UPDATE, diagnostic DELETE, job DELETE; P existing protection statements; A zero
or one account-cleanup statement; S zero or one slot DELETE. Settled cancellation
is one SELECT plus an optional hard-upgrade UPDATE. Missing/other terminal
outcomes are one SELECT. Commit/rollback framing is unchanged. No production
EXPLAIN was run; identical SQL implies no new query shape, not a measured plan
or performance improvement.

## Verification boundaries

Local formatting, affected ESLint, full API normal Oxlint, affected type-aware
Oxlint, and API check-types (including gateways and chat-event acceptance, with
one type checker) pass. Knip exits before analysis with the existing oxc-parser
`RangeError: Array buffer allocation failed`; it is not a successful local check.
No local Vitest or development server is run.

Existing public API coverage includes cancellation endpoint identity/mode and
revocation tests; cancellation/claim concurrency and repeat-settled lifecycle;
pending cancellation immediate slot release and partial-effect recovery;
started cancellation slot retention until Runner completion and FIFO picking;
threadless cleanup/recovery and captured personal-account disconnect/terminal
credential denial. These tests are unchanged: no SQL-shape test, DB-row
assertion, internal mock, or duplicate fixture substitutes for public behavior.
Exact-head CI results and any limitations must be reported on the PR before
handoff for independent coordinator review. This PR has no merge authorization.
