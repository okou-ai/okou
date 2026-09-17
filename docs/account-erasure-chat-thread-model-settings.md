# Account erasure: direct thread model settings writes (B2b2-R6)

Scope: [#34863](https://github.com/vm0-ai/okou/issues/34863), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences one endpoint,
`POST /api/chat-threads/:id/model-selection`, with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the canonical parent lock
contract accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md) and
[pin writes](account-erasure-chat-thread-pin.md). It installs no closure
decision, ingress, worker, schema, migration or production operation.

A thread's model pin, its per-model reasoning effort, its Codex service tier and
the two sidebar events that mirror them are account content, not platform
billing. This slice stops the route from producing **new** settings state for a
closed subject; settings already durable are historical data owned by C2/D/H and
are not erased here. It fences this one writer and no other writer of the same
columns.

## What this route actually writes

| Durable effect                                                                                                                         | Where it comes from                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `chat_threads.selected_model`, three legacy provider pin columns, `codex_service_tier`, `model_settings`, `updated_at`                 | the route's own `UPDATE`                               |
| One `model_selection_updated` sidebar event and its durable sequence id                                                                | `appendChatThreadEvent`                                |
| One `service_tier_updated` sidebar event and its durable sequence id                                                                   | `appendChatThreadEvent`                                |
| **Lazy `org_model_policies` seeding and default repair**, with `created_by_user_id` / `updated_by_user_id` attributed to the requester | `resolveModelSelectionPin` -> `ensureOrgModelPolicies` |

The last row is the non-obvious one. `resolveModelSelectionPin` is **not** a
pure validator: for a model-first selection it calls `ensureOrgModelPolicies`,
whose slow path takes an organization-local advisory lock, inserts or repairs
the default policy and seeds the missing active models, attributing every row to
the requesting user. Before this change the route resolved that pin _before_
opening its own transaction, so a closed account could still create and repair
account-attributed policy rows even if the thread mutation itself were fenced.

## Canonical identity and admission

The route now calls `withChatThreadContentWrite` and keeps its unchanged route
configuration: `requireOrganization`, `missingOrganizationStatus: 401` and the
`chat-thread:write` capability. `authorize` is this route's existing ownership
contract expressed over the real persisted identity:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`.

That matches the predicate the `UPDATE` already used, where the organization
condition is an `EXISTS` over the Agent's `org_id` and `agent_id IS NOT NULL` is
required. The request's own `userId`/`orgId` and any stored sidebar label remain
comparison inputs, never authority. At most three deduplicated subjects are
admitted: the thread user, the Agent owner when it is a different user, and the
actual organization.

`authorize` runs before admission, and the whole write — including the pin
resolver — runs after it. No policy bootstrap, default repair or attribution
happens on a missing, unauthorized, closed or ownership-retry attempt.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. `chat_threads` **FOR NO KEY UPDATE** and the settings read.
8. `resolveModelSelectionPin`, including any `org_model_policies` bootstrap or
   repair, on a **savepoint of this same transaction**.
9. The feature-switch context, effort resolution and service-tier validation.
10. The settings `UPDATE`, then both sequence reservations and both events.

The order is **subjects -> Agent -> thread -> model policy -> content**. Every
barrier is retained through `COMMIT`.

### Why `FOR NO KEY UPDATE` replaced `FOR UPDATE`

The route previously serialized its sparse `model_settings` read/modify/write
with `FOR UPDATE`. Under the shared helper that is a deadlock: the helper
retains `FOR KEY SHARE` on the same row, `FOR UPDATE` conflicts with
`FOR KEY SHARE`, so two concurrent settings writers each wait for the other's
retained lock. `FOR NO KEY UPDATE` conflicts with another settings, rename or
pin writer — which is exactly the serialization the sparse map needs, and a
waiting writer re-reads the committed row before patching it — but it does not
conflict with a retained `FOR KEY SHARE`, so the upgrade is granted immediately
and the two writers queue instead of deadlocking. The same mode is what a plain
`UPDATE` already takes, so overlapping a settings write with a rename or a pin
write introduces no new conflict either.

Locally, reverting only this mode to `FOR UPDATE` turns the two-writer test into
`canceling statement due to lock timeout` on the admission helper's own `1s`
budget; with `FOR NO KEY UPDATE` both writes commit and both sparse entries
survive.

### Why the policy resolver comes after the thread lock

`resolvePersistedChatThreadModel` already takes `chat_threads FOR UPDATE` and
_then_ reaches `ensureOrgModelPolicies`, so **thread before model policy** is
the established order. Every other bootstrap caller —
`resolveDefaultModelFirstPin` in the welcome-thread and integration-route
services, `resolveModelSelectionPin` in thread creation and in the send path —
passes a plain connection, so its advisory lock is taken and released inside
`ensureOrgModelPolicies`'s own transaction and is never held across a thread or
Agent lock. Taking the settings row lock before the resolver therefore keeps
this route on the existing direction: no transaction can hold the
`model-policy:<orgId>` advisory lock while waiting for a `chat_threads` row, so
no cycle exists against the send-path reconciler. The resolver needs no
serialized settings value, so nothing is lost by locking first.

`ensureOrgModelPolicies` receives the admitted transaction, and Drizzle turns
its nested `transaction` into a `SAVEPOINT` on that same connection. It is
never a second connection and can never commit independently of the thread
mutation.

## Failure contract

| Outcome                                        | Disposition                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Thread missing, foreign, wrong org, null Agent | The existing `404 Chat thread not found`                      |
| B1 subject closure                             | The same existing `404`, with no write, event or policy row   |
| Identity moved under the locks                 | Roll back and reselect, at most three attempts                |
| Attempts exhausted                             | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort            | Original database error or cancellation, propagated unchanged |

Closure reuses the existing not-found disposition, so the endpoint stays
non-oracular. Closure is **not** a success `204`, and a timeout, a blocked
parent lock, a cancelled request or any unrelated SQL failure is **never**
reported as a fabricated `404`.

Success and validation semantics are unchanged for an admitted request: null
model clearing and the three null legacy provider columns, per-model sparse
effort preservation across model switches, dormant stored preferences while the
effort rollout is disabled, the `400` for an explicit effort while disabled or
an unsupported level, the retired-model and unavailable-model `400`s, the plan
`402`, the Fast-mode `400`s, explicit tier `null`, an effort-only update
retaining Fast, a legacy model-only update clearing it, both caller-supplied
event ids, the `fast` -> `priority` sidebar projection, the `204` response and
run-token support with `chat-thread:write`.

One ordering consequence is deliberate: ownership is now resolved before model
validation, so a retired or unavailable model sent against a thread the caller
does not own returns the existing `404` instead of a `400`. An unauthorized
caller no longer learns anything about the catalog, and no longer reaches the
policy bootstrap.

A validation error for an **admitted, authorized** request still commits any
policy initialization the resolver performed, exactly as before this change,
while emitting no thread update, no sidebar event and no invalidation. That
active-request behavior is preserved on purpose; what changes is that a denied
or failed request can no longer leave those policy writes behind.

`publishThreadListChanged` still runs only after a successful `COMMIT`. A denied,
invalid, cancelled or rolled-back mutation consumes no sequence id, appends no
event and publishes nothing; the next accepted update takes the very next two
sidebar sequence ids. No provider or other remote side effect runs under these
locks.

## Acceptance evidence (R6-V)

[#34897](https://github.com/vm0-ai/okou/issues/34897) closes the evidence gap in
the merged implementation. It changes no production code: the route, the shared
admission helper and the policy resolver are unchanged. Every criterion below
maps to an exact test in
`turbo/apps/api/src/signals/routes/__tests__/chat-thread-model-settings-erasure.test.ts`,
or to reused evidence that already exists.

| Original criterion                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic same-thread overlap, both writers holding the retained `FOR KEY SHARE` before either asks for the settings row          | `serializes concurrent same-thread efforts for different models without losing either`, rebuilt on `withChatThreadContentBarriersFixture` with `stopAt: ["content-lock", "content-lock"]`                                                                                                |
| The incompatible `FOR UPDATE` mode fails for the intended conflict                                                                    | `rejects the incompatible FOR UPDATE mode against a live writer's retained KEY SHARE`, using `probeChatThreadRowLockModesFixture` against a real paused writer                                                                                                                           |
| Settings/rename overlap at a retained-lock and write boundary, without product-level serialization                                    | `overlaps a settings write with a rename under the shared helper`, `stopAt: ["content-lock", "content-update"]`, with an unrelated owner completing while both are paused                                                                                                                |
| Old state visible and nothing published while a successful transaction is paused before `COMMIT`; the notification follows the commit | `publishes nothing until the transaction commits, then exactly one invalidation`                                                                                                                                                                                                         |
| Denied and rolled-back writes publish nothing                                                                                         | `denies a model-selection update for a closed thread user ...` and `rolls the pin, effort, the first sidebar event and both sequences back when the second event fails`, both now counting `threadListChanged`                                                                           |
| Real cancellation after the admitted write, with guaranteed rollback                                                                  | `rolls the thread update, both events and the policy repair back when the request is cancelled after the write`, asserting the transaction's own statement sequence through `TransactionBarrier.statements()`                                                                            |
| Held `model-policy:<orgId>` slow path keeps its own bounded error and recovers                                                        | `propagates a held model-policy lock on the slow path instead of a fabricated response`                                                                                                                                                                                                  |
| Organization move and canonical parent deletion through this route                                                                    | `re-resolves a transferred Agent organization under the locks ...` and `keeps the existing 404 after the canonical Agent parent is deleted`                                                                                                                                              |
| Owner transfer, pre-write lock failure, late second-event rollback, closure denials, policy bootstrap fencing                         | Already covered by the merged suite; unchanged and preserved                                                                                                                                                                                                                             |
| Effort levels, retired/unavailable models, Fast mode, omission/null semantics, run tokens                                             | Reused from `chat-threads-model-selection.test.ts`; no duplicate matrix was added                                                                                                                                                                                                        |
| Unchanged legacy provider columns and the `402` plan branch                                                                           | Source evidence: `chatThreadModelPinColumns` and the resolver branch are untouched by both this follow-up and the merged change. No database-read exception and no catalog/billing test project was added for them                                                                       |
| Bounded baseline/candidate cost evidence, common and slow policy path                                                                 | The route interface-cost comparison below: baseline blob `dbff4c21` versus candidate blob `3e4308b7`, with exact statements, locks, roundtrips, server durations, small-sample request times and plans. The test-suite timings are reported separately and are explicitly not this item. |

Three properties make the concurrency evidence deterministic rather than
probabilistic:

- The barrier binds a stop to the **connection** that issued the fenced
  transaction's identity read, not to the thread id several readers share. Each
  request is started only after the previous barrier reports it is paused, so
  every barrier belongs to one exact HTTP request.
- A barrier pauses **before** its statement is dispatched, so no lock or
  statement timer is running during the observation window, and both barriers
  are released before either writer's 1s lock budget starts. No production
  timeout is changed and no sleep or retry loop is used.
- The `FOR UPDATE` counter-case uses `NOWAIT` against a live writer's retained
  `FOR KEY SHARE`, so the conflict is reported immediately instead of being
  inferred from a timeout.

### Which cancellation signal this is, and what the test actually proves

The signal this route observes is the one `createAppWithRoutes` receives and
`honoSignalHandler` threads into the handler. In production that is the
instance-lifetime `AbortController` that `src/server.ts` and `src/index.ts`
create and abort on shutdown or `SIGTERM` ("Aborted due to terminated function
instance"). The route never reads the per-request fetch/connection signal
(`c.req.raw.signal`), and this slice adds no public request-cancellation API.
The test aborts that exact production-wired signal through the same constructor
argument, so the cancellation path is production's own; calling it "request
cancellation" is shorthand for the operation-lifetime abort the route really
honours, not evidence of a per-connection cancel endpoint.

The case stops at the thread `UPDATE` in the barrier's `pauseAfter` mode, so that
statement has already run inside the still open transaction when the abort
lands. Two independent observations replace any inference from unchanged final
state:

- the `UPDATE`'s **own reported row count is 1**, read from the statement result
  the barrier captured, so the write is measured rather than assumed; and
- the barrier records every statement that exact connection issued, and the test
  asserts one `update "chat_threads"`, two
  `insert into "chat_thread_event_sequences"`, two
  `insert into "chat_thread_events"`, a matching `savepoint sp1` /
  `release savepoint sp1` pair for the policy repair, **no** `commit` at all,
  and a `rollback` positioned after the last event insert.

The server's own log shows the same window for one such request. The barrier's
settings probe sits immediately after the `UPDATE`, which is where the pause and
the abort land, and the transaction still runs its whole event tail before
ending in `ROLLBACK`:

```text
18:13:28.824  release savepoint sp1
18:13:28.825  select "model", ... from "org_model_policies" ...
18:13:28.827  select "type" from "model_providers" ...
18:13:28.828  select "user_id", "switches" from "user_feature_switches" ...
18:13:28.830  update "chat_threads" set ... "selected_model" = $4 ...   <- runs, reports 1 row
18:13:28.831  SELECT pg_backend_pid() ... current_setting('lock_timeout') ...  <- paused here; the abort lands
18:13:28.833  insert into "chat_thread_event_sequences" ...
18:13:28.835  insert into "chat_thread_events" ...
18:13:28.837  insert into "chat_thread_event_sequences" ...
18:13:28.838  insert into "chat_thread_events" ...
18:13:28.839  rollback
```

The two event inserts corroborate the measured row count independently:
`writeModelSelection` returns early when the `RETURNING` row has no `agentId`
and never reaches `appendChatThreadEvent`, so they could not exist if the
`UPDATE` had matched nothing.

The `pauseAfter` mode and the row count it exposes are reused from the
read-cursor evidence slice (#34902) rather than reinvented here; this slice only
adds the stop that selects that mode for the thread `UPDATE`.

Aborting at the `commit` stop would be unsound evidence instead: once `COMMIT`
is on the wire the transaction may already have succeeded, so such a case could
not claim a rollback guarantee. No case in this suite does that.

## Interface cost of the fence: baseline versus candidate

This is the acceptance item's own measurement: the **route before and after the
R6 fence**, on the same fixture, the same single HTTP request, the same worktree
and the same PostgreSQL instance. Only the route file differs.

| Subject         | Pinned revision                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline route  | blob `dbff4c21dac7b5bc5c3391ccd662ee52373f4591`, `turbo/apps/api/src/signals/routes/chat-threads-model-selection.ts` at `ba3b46f887e8f4425186a64a3dabedd417ae8736` (the commit before the R6 merge) |
| Candidate route | blob `3e4308b7ff0b5a18d62b280761852ad05d7b2638`, the same path on `main`, unchanged since the R6 merge `ffe98626858cc8888bb9f135c1558471aa9ca968`                                                   |
| Everything else | `main` at `e9001cdc0e69e7246209e62e2995a388a82077b5`, PostgreSQL 18.6, one 2 vCPU-class sandbox, one Vitest process                                                                                 |

Method: run PostgreSQL with `log_statement=all`, `log_min_duration_statement=0`,
`log_lock_waits=on` and `log_line_prefix='%m [%p] app=%a '`; create the fixture
organization, Agent and pinned thread through the product routes; emit a marker
statement, issue exactly one `POST /api/chat-threads/:id/model-selection`, emit a
closing marker; then read the marked window of the log. Repeat with the baseline
blob checked out in place of the candidate. No production query, no new
production code path and no performance tuning is involved.

### Existing-policy common path

| Measure                          | Baseline                                                              | Candidate                                                                                              |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Statements in the marked window  | 17                                                                    | 27                                                                                                     |
| Transactions the request commits | 1 (`begin`, server-default isolation), preceded by 9 autocommit reads | 1 (`begin isolation level read committed`) containing every statement                                  |
| Transaction-local deadlines      | none                                                                  | `SET lock_timeout` and `SET statement_timeout`                                                         |
| B1 admission                     | none                                                                  | isolation probe, 2 × `pg_advisory_xact_lock_shared`, closure lookup                                    |
| Canonical identity               | none                                                                  | identity read, then a second identity read under the locks                                             |
| Row locks                        | `chat_threads` `FOR UPDATE`                                           | `agents` + `chat_threads` `FOR KEY SHARE` retained to `COMMIT`, and `chat_threads` `FOR NO KEY UPDATE` |
| Summed server statement duration | 3.81 ms over 50 logged parse/bind/execute records                     | 5.22 ms over 78 records                                                                                |
| Request wall time, n = 5         | median 16.8 ms (16.4-18.6)                                            | median 23.0 ms (20.9-71.4; the 71.4 ms is the first, cold sample)                                      |

### Initialization and default-repair slow path

| Measure                              | Baseline                                                                                                        | Candidate                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Statements in the marked window      | 27                                                                                                              | 37                                                                               |
| Transactions the request commits     | **2**: the policy repair runs in its own `BEGIN ... COMMIT` and commits **before** the thread transaction opens | **1**: `savepoint sp1 ... release savepoint sp1` inside the admitted transaction |
| `model-policy:<orgId>` advisory lock | exclusive, released when the separate policy transaction commits                                                | exclusive, held until the thread transaction commits                             |
| Summed server statement duration     | 5.26 ms over 76 records                                                                                         | 5.24 ms over 104 records                                                         |
| Request wall time, n = 5             | median 23.3 ms (22.2-29.1)                                                                                      | median 26.9 ms (19.3-37.2)                                                       |

The two-transaction baseline is the measured form of the defect this slice
fixed: the account-attributed `org_model_policies` seeding and default repair
were durable before the thread write was even attempted. Making them roll back
with the thread write is exactly what costs the extra statements and the longer
advisory-lock window; that is a correctness cost, not an optimization target.

### Plans for the statements the fence adds

`EXPLAIN (COSTS OFF)` on the same local database:

| Added statement                  | Plan                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Canonical identity read          | `Limit -> Nested Loop Left Join -> Index Scan chat_threads_pkey` + `Index Only Scan idx_agents_id_org_owner` |
| `agents ... FOR KEY SHARE`       | `LockRows -> Index Scan idx_agents_id_org_owner`                                                             |
| `chat_threads ... FOR KEY SHARE` | `LockRows -> Index Scan chat_threads_pkey`                                                                   |
| B1 closure lookup                | `Limit -> Seq Scan on account_erasure_jobs`                                                                  |

The closure lookup's sequential scan is a local artifact: that table holds 0 rows
in this sandbox. The unique index `account_erasure_subject_generation
(subject_kind, subject_id, generation)` exists and can serve the predicate. No
claim is made here about the plan production chooses.

### Honest limits

Local synthetic measurements from one sandbox with n = 5 per cell, including the
cold first sample. They are wall-clock and server-side statement times for one
request shape, not production throughput, not a latency bound, and not a
statement about any other route. The statement and lock counts, by contrast, are
exact: they are read from the server's own log of the marked request window.

## Test-suite cost (not a substitute for the measurement above)

Kept for continuity from the earlier revision of this document. These are the
cost of running this slice's **test file**, which is a different thing from the
route's interface cost and does not satisfy the acceptance item:

| Subject                                      | Before this follow-up         | After                         |
| -------------------------------------------- | ----------------------------- | ----------------------------- |
| `chat-thread-model-settings-erasure.test.ts` | 15 tests, 17.8s file duration | 21 tests, 20.4s file duration |

Per-case local times, same run: deterministic same-thread overlap 157ms,
`FOR UPDATE` / `FOR NO KEY UPDATE` probe 152ms, settings-versus-rename overlap
273ms, paused-before-commit visibility and publication 178ms, cancellation
190ms, organization move 235ms, deleted canonical parent 126ms, held
`model-policy` key 1158ms (dominated by the route's unchanged 1s lock budget).
This follow-up adds no production statement, index or lock; the only new
database work is in test fixtures, which take one advisory key or two `NOWAIT`
row locks and always roll back.

## Residual work

This is a producer fence for one endpoint only. It erases no existing model
pin, effort map, service tier, policy row, sidebar event or snapshot, and it
does not complete B2, A2 or account erasure. Explicitly still unfenced, and not
covered by this slice:

- Every other writer of the same columns: the send-path reconciler in
  `chat-thread-model.service.ts`, thread creation, the member model preference,
  and the image/video model and Computer Use host routes.
- The broader model-policy API (`PUT /api/model-policies`) and every other
  caller of `ensureOrgModelPolicies`; this slice fences only the bootstrap this
  route reaches.
- Read cursors, the generated/LLM title workflow, message create/send/edit and
  revoke, run and queue admission, and the sidebar snapshot projector.
- Historical cleanup, inventory and purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
