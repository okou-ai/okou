# Account erasure: cloud browser authorization apply (B2b2-R10)

Scope: [#34975](https://github.com/vm0-ai/okou/issues/34975), repaired by
[#35021](https://github.com/vm0-ai/okou/issues/35021), under
[#33745](https://github.com/vm0-ai/okou/issues/33745).

Accepted [R8](account-erasure-chat-thread-computer-use.md) fenced the direct
`POST /api/chat-threads/:id/computer-use-host` route. Approving an existing
cloud-browser authorization link writes the same thread selection state through
a different service, and that path kept a plain transaction. This slice fences
`POST /api/browser/authorization-requests/:requestToken/apply` and its coupled
completion write with the existing dormant [B1 barrier](account-erasure-foundation.md),
reusing the canonical parent lock contract accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md),
[pin writes](account-erasure-chat-thread-pin.md),
[read cursors](account-erasure-chat-thread-read-state.md),
[model settings](account-erasure-chat-thread-model-settings.md) and
[direct Computer Use settings](account-erasure-chat-thread-computer-use.md).

It installs no closure decision, ingress, worker, schema, migration, capability
or production operation, and it fences no other browser writer.

## What this path actually writes

| Durable effect                                                                           | Where it comes from                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| `chat_threads.computer_use_host_id = NULL`, `cloud_browser_enabled = true`, `updated_at` | the service's own `UPDATE`                 |
| One `computer_use_host_updated` sidebar event and its durable sequence id                | `appendChatThreadEvent`                    |
| `browser_authorization_requests.completed_at`, `updated_at`                              | the completion `UPDATE`                    |
| One content-free `threadListChanged` invalidation                                        | `publishThreadListChanged`, after `COMMIT` |

Nothing else. This apply issues **no** provider or Browser Use request, starts
and stops no session, and none was added here.

## Canonical identity and admission

The opaque token, and the `user_id`/`org_id` stored on the request row, decide
only **which** request was presented. They are not ownership. The service keeps
its existing preflight — token hash plus request user, request organization and
TTL — and then uses the request's `chat_thread_id` purely as a locator for
`withChatThreadContentWrite`.

`authorize` is expressed over the real persisted identity:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`, where `identity.orgId` is the canonical
  Agent's organization.

At most three deduplicated subjects are admitted: the thread user, the Agent
owner when it is a different user, and the actual organization. `authorize` runs
before admission, so an unauthorized request never takes another account's
subject locks, and the subject set is never widened after the business locks.

### Explicit behavior correction

The previous `UPDATE` matched on thread id, thread user and a non-null Agent
only. It had **no organization predicate**, so a request minted while a thread
belonged to organization A still applied after the thread's Agent moved to
organization B, and published a `computer_use_host_updated` event carrying the
stale request organization.

That is now out of scope: the apply returns the route's existing
`404 Cloud browser authorization scope not found` and writes nothing. This is a
deliberate change, not preserved parity; a case covers it.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The service's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. Re-read **this exact request** — same row id, token hash, user, organization
   and thread — **FOR NO KEY UPDATE**, and recheck its TTL against a clock read
   only once that row is held.
8. The thread `UPDATE`, the sequence reservation, the event insert and the
   completion `UPDATE`.

The order is **subjects -> Agent -> thread -> request -> content**, and every
barrier is retained through `COMMIT`.

### Why the request pin, and why this mode

Step 7 runs before any content mutation, so a request that was deleted or that
lapsed between the preflight and the write produces the existing `404`/`410`
with **no** partial commit: no thread update, no consumed sidebar sequence, no
event and no completion stamp. The service never writes first and reports
failure afterwards.

`FOR NO KEY UPDATE` is exactly the lock the completion `UPDATE` in step 8 takes,
so the pin never upgrades mid-transaction, and that is why this mode is used. It
does also block a concurrent `DELETE`, but that property alone would not select
it: `KEY SHARE`, a weaker mode, blocks `DELETE` as well. An earlier revision of
this document called `FOR NO KEY UPDATE` the weakest mode that blocks `DELETE`,
which is wrong.

The lock order has no inverse. Every statement that touches
`browser_authorization_requests` anywhere in the repository lives in
`browser-authorization.service.ts`: the creation `INSERT`, the token lookup both
read paths share, and this completion `UPDATE`. Nothing deletes the row — no
endpoint revokes one, the table declares no foreign key that could cascade it
away, and no cleanup job sweeps it. Request
[creation](account-erasure-browser-authorization-creation.md) now takes
subjects -> Agent -> thread -> run before inserting a fresh request; apply takes
subjects -> Agent -> thread -> this existing request; the token lookups take no
row lock. No path therefore locks a request before `agents` or `chat_threads`.

`chat_threads` keeps taking its own `FOR NO KEY UPDATE` through the selection
`UPDATE`, which does not conflict with the retained `FOR KEY SHARE`, so no new
self-deadlock is introduced and these locks add no serialization between
different threads.

That is a statement about the locks this slice adds, not a claim that two
applies by the same owner never contend. They do, and they did before this
slice: the unchanged sequence reservation writes
`chat_thread_event_sequences`, whose row is keyed by `(user_id, org_id)` rather
than by thread, so two of one owner's writes still serialize on that row for the
remainder of whichever transaction reaches it first.

## Timestamps

The preflight keeps its own clock reading for the TTL check it already
performed. Inside the admitted transaction one further reading is taken and used
for **all** of the write: the TTL recheck, `chat_threads.updated_at`, the event
`created_at` and `completed_at`/`updated_at` on the request. The existing
invariant that those written timestamps share a single value is preserved.

That reading is taken **after step 7's pin has been acquired and its row
returned**, and before any content mutation. Where it is taken is the whole
point. Acquiring the pin is an `await`: it can wait on a concurrent holder of
the same row, and on the transaction's own `1s` lock budget. A reading sampled
before that `await` describes a moment that has already passed by the time the
row is in hand, so a request that was live when it was sampled and has since
lapsed would compare as valid and go on to commit a thread update, a durable
sidebar sequence and event, and a completion stamp.

[#34975](https://github.com/vm0-ai/okou/issues/34975) moved the reading inside
the transaction but sampled it before the pin, so it still described a moment
before the wait it was meant to cover; the reading now happens after.
[#35021](https://github.com/vm0-ai/okou/issues/35021) is that repair, and two
cases hold the pin open across a lapse to keep it. No production incident is
claimed. Preflight expiry is still decided by the preflight's own reading, and
the bounded reselection loop re-enters this same sequence, so each attempt
rechecks the TTL with a reading taken inside that attempt.

## Failure contract

| Outcome                                                                                        | Disposition                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Unknown token, or token for another user or organization                                       | The existing `404 ... request not found`                      |
| Request expired at the preflight                                                               | The existing `410`                                            |
| Request deleted between the preflight and the write                                            | The same `404`, nothing written                               |
| Request expired between the preflight and the write, including while its pin is being acquired | The same `410`, nothing written                               |
| Thread missing, foreign, organization-foreign or Agent-less                                    | The existing `404 ... scope not found`                        |
| B1 subject closure                                                                             | The same scope `404`, with no update, event or completion     |
| No organization on the session                                                                 | The existing `401`, from unchanged `requireOrganization`      |
| Identity moved under the locks                                                                 | Roll back and reselect, at most three attempts                |
| Attempts exhausted                                                                             | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort                                                            | Original database error or cancellation, propagated unchanged |

Closure reuses the existing scope-not-found disposition without revealing which
subject closed, so the endpoint stays non-oracular. Closure is **not** a success
`200`, and a timeout, a blocked parent lock, a cancelled request or any
unrelated SQL failure is **never** reported as a fabricated `404` or `410`.

The route configuration is unchanged: `requireOrganization: true`,
`missingOrganizationStatus: 401`, no `chat-thread:write` capability, and the
success body is still `{ ok: true, cloudBrowserEnabled: true }`. Repeat apply is
unchanged — the token is not consumed and stays usable until its TTL — and a
completed request is therefore still a live writer that closure denies, not a
bypassing no-op.

`publishThreadListChanged` runs only after a successful `COMMIT`, to the
admitted user and organization — the `user-org:<userId>:<orgId>` channel of the
session that applied. A denied, rolled-back or paused request consumes no
sequence id, appends no event and publishes nothing, on that channel or on any
other.

Cancellation is bounded, and the exact bound is the writer's **last
in-transaction abort check**: the `signal.throwIfAborted()` that
`withChatThreadContentWrite` runs immediately after the write callback returns,
in `chat-thread-content-erasure-admission.service.ts`. An abort that this check
observes rolls the executed statements back, and that is what a case proves: the
thread update, the sequence, the event and the completion had all executed and
none of them survived.

The guarantee stops there, not at `COMMIT`. That check runs **before** `COMMIT`
is dispatched, so an abort arriving in the window between it and the `COMMIT`
the driver then sends is already too late: the transaction commits and the data
is durable. The writer's next `throwIfAborted` runs after the transaction and
turns that abort into a failed response, so the caller loses the `200` and the
`threadListChanged` publication that would have followed it — the write is
durable, the notification is not retried, and the cursor a client later reads is
the durable event. So "a cancelled request consumes nothing" is true only up to
that last in-transaction check; after it, cancellation costs a response and a
publication, not the write.

Cancellation of the application operation is what the writer observes; a raw
client disconnect or an abandoned `fetch` is not by itself server-side
cancellation of the operation. No cancellation or retry API is added here, and
nothing cancels a `COMMIT` already in flight.

## Evidence

`turbo/apps/api/src/signals/routes/__tests__/browser-authorization-erasure.test.ts`
holds nineteen cases at the real HTTP boundary against real PostgreSQL and the
real dormant B1 projector. Requests are created with a real run token through
the real create endpoint and applied with a real authenticated session.

Every publication assertion is scoped to an **exact channel and topic**, not to
the topic alone. The Ably client mock records `channels.get(name)` and the
returned channel's `publish(topic)` on two separate spies that every channel
shares, so a topic-only count cannot tell one publication per owner from two
under a single owner or one routed to the wrong channel. The shared
`publishedChannelTopics` helper in
`turbo/apps/api/src/signals/routes/__tests__/helpers/realtime-publications.ts`
recovers each publish's channel from the last `channels.get` whose global
invocation order precedes it; every publisher in `signals/external/realtime.ts`
performs the `get` and that channel's `publish` in one synchronous step with no
await between them, so the pairing is exact rather than an assumption about
call order. Cases that expect nothing still assert that **no** channel received
the topic, which is strictly stronger than a scoped zero.

- Closure denial for the thread user, for a **legitimately distinct** shared
  Agent owner — a second member of the same organization who owns the Agent from
  the moment it is created, so no transfer is needed to produce the subject —
  and for the organization. Thread state, completion, durable events, sequence
  and outbound invalidation are all unchanged, and the first denied case then
  retires the closure and proves the next accepted apply takes the very next
  sequence id.
- An unrelated eligible owner still applies while another subject is closed.
- A completed request re-applied after a later closure is denied, so the
  existing repeat path cannot bypass closure.
- Writer-first: the apply pauses at `COMMIT` with every write executed; an
  exclusive closure is proved blocked through `pg_blocking_pids`; an independent
  reader still observes the old thread state, a null `completed_at`, the old
  event list and zero invalidations. An unrelated owner — a genuinely different
  user in a genuinely different organization — applies normally meanwhile, and
  while the target is still paused the count is asserted **per owner**: exactly
  one on the unrelated owner's own channel, zero on the target's, and no third
  channel. After release each owner has exactly one on its own channel and the
  total is two, and the landed closure then denies the next apply without adding
  one. A global total of two would also be satisfied by two publications under
  one owner or by either one misrouted, which is why it is not asserted alone.
- Identity gaps: an Agent owner transferred under the locks, a thread deleted
  under the locks, and a cross-organization transfer before the apply.
- Request window: deletion after the preflight, and a TTL that lapses after the
  preflight, both rechecked with no partial write; and the pin itself, where a
  concurrent `DELETE` is observed blocked on the apply's own row lock through
  `pg_blocking_pids` and can only land after `COMMIT`.
- A TTL that lapses **while the pin is being acquired**, which is the window
  [#35021](https://github.com/vm0-ai/okou/issues/35021) repaired, covered twice
  and without moving the stored `expires_at`:
  - A second real session holds that exact request row, so the apply's own
    `FOR NO KEY UPDATE` waits in PostgreSQL. `pg_blocking_pids` is filtered to
    the pin statement itself, so a non-zero count is proof that this exact apply
    reached the request lock rather than proof that something waits somewhere.
    The clock is then advanced past the TTL and the holder released, well inside
    the apply's unchanged `1s` budget and with no sleep. The apply returns `410`
    and leaves the thread selection, the completion stamp, the event list, the
    sidebar sequence and the outbound invalidation count untouched. While the
    request is lapsed, another member's session and an unknown token still get
    `404`, so token and ownership keep their precedence over expiry. A later
    link minted from the same run is the unexpired control: it waits on the very
    same pin, still applies, and takes exactly the sidebar sequence id the
    denial never consumed, so a vacuous denial cannot pass this case.
  - The shared `pauseAfter` barrier stops the apply holding the pin's own
    executed result with `rowCount` 1, which shows the same lapse with the
    backend idle inside its transaction and no budget of its own running.

  Only the test's own mock clock moves in these cases; it is restored before the
  unchanged read endpoint is asked to report the request's state, because that
  endpoint would otherwise refuse a lapsed request rather than describe it.

- Atomic failure: holding the next `(user_id, org_id, seq_id)` slot makes the
  event insert fail on its own bounded budget after the thread `UPDATE` and the
  sequence reservation, and all four effects roll back together.
- Real operation cancellation **after an executed write**: the barrier pauses
  after the completion `UPDATE` and asserts its `rowCount` is 1, so the thread
  update, the sequence, the event and the completion had all run and were still
  uncommitted; the abort then reaches the writer's last in-transaction check,
  which still runs after this pause, and everything rolls back. This is
  server-side cancellation of the operation, not an abandoned client fetch, and
  it is not a claim about undoing anything after `COMMIT`.
- Real operation cancellation **at the commit boundary**, which is the other
  side of that bound. The barrier holds the driver's own `COMMIT` before it is
  dispatched, so PostgreSQL has neither executed nor acknowledged it — the pause
  is a pre-dispatch barrier, not a server-acknowledged `COMMIT`. What it is past
  is the writer's last in-transaction abort check. While paused the state is
  still unchanged and unpublished; the abort then lands and releasing sends a
  `COMMIT` that succeeds. The case asserts the full accepted state afterwards —
  the selection, the completion stamp and the next sidebar sequence id — while
  the caller's `200` fails and **no** channel receives a `threadListChanged`.
  That is the loss this contract describes: a response and a notification, not
  the write. No in-flight `COMMIT` is cancelled and no publication is retried.
- A held parent thread lock propagates as a real failure, not a closure `404`.
- Parity: unknown token, another member's token, a foreign owner's token, an
  unauthenticated caller, an organization-less session, a thread without an
  Agent, and a lapsed TTL all keep their existing dispositions; run-token
  creation, clearing a selected Computer Use host, the exact success body, the
  `completed_at` stamp, repeat apply and a second link minted from the same run
  all still work.

### Sensitivity of the per-channel assertions

The per-owner assertions were checked against a deliberate, uncommitted mutation
of the service that routed every apply's invalidation to the first owner that
reached the publish, so the paused writer-first target was suppressed and the
unrelated owner's was duplicated. The number of `threadListChanged`
publications stayed at two. Under that mutation the retained total — two
publications, two channel entries — still passed, and the writer-first case
failed on `threadListInvalidations(fixture)`, receiving `0` where `1` is
required. That is the concrete demonstration that a topic-only count could not
have caught a misroute and that the per-channel binding does. The mutation was
reverted before any commit. At the time this apply-only experiment was recorded,
the service blob was `4f59282b0b129c8a186dc6dfdc8625f2acad113e`; later creation-fence work under
[#35096](https://github.com/vm0-ai/okou/issues/35096) changed the same service.
This remains a historical test-validation control, not a reported production
defect: no misrouting has been observed in the real publisher, which derives its
channel from the admitted session's own user and organization.

### Baseline failure and candidate pass

Same tree, one blob different in each row: only
`turbo/apps/api/src/signals/services/browser-authorization.service.ts` is
replaced, and the whole file is run against each build.

These three rows were measured when the file held **eighteen** cases. The later
publication-scope and commit-boundary work changed only this file, the shared
test helper and this document — the service blob is byte-identical — so the
rows are kept as the historical record of that comparison rather than
re-measured against the nineteen-case file.

| Build                                                   | Result                        |
| ------------------------------------------------------- | ----------------------------- |
| Pre-fence `89dcfaf69404070fc8fd5c4c2dc932faf0914544`    | 16 failed, 2 passed, 326.92 s |
| Merged fence `45bb5cdc0acf3d7e79ac1b0cf99b975aae48d121` | 2 failed, 16 passed, 22.69 s  |
| Candidate `4f59282b0b129c8a186dc6dfdc8625f2acad113e`    | 18 passed, 22.10 s            |

The two cases that pass on every build are exactly the parity cases — the
unchanged token/ownership/expiry/Agent dispositions, and run-token creation with
host clearing and repeat apply — which is the intended separation: they assert
behavior this slice preserves.

Against the **pre-fence** service every fence, atomicity, window and
cancellation case fails. The closure cases fail with
`Expected API response status to be one of 404, received 200. Body: {"ok":true,"cloudBrowserEnabled":true}`;
the cross-organization case fails the same way; the expiry-window case fails with
the same shape against `410`. The barrier-driven cases time out because that
transaction never issues the identity read the barrier selects on, the
held-parent-lock case times out because a plain transaction sets no
`lock_timeout`, and the new real-holder case times out waiting for a request pin
that service never takes.

Against the **merged fence** — the blob `main` carried before this repair —
exactly the two new cases fail, and both fail the same way:
`Expected API response status to be one of 410, received 200. Body: {"ok":true,"cloudBrowserEnabled":true}`.
That is the defect stated plainly: the request had lapsed while the apply held
or awaited its own pin, and the apply committed the selection, the durable
event and the completion stamp anyway. The other sixteen cases pass on that
build, which is why they could not catch it.

## Measured local cost

Local PostgreSQL 18.6 with the repository migrations applied, the API test
harness at its real HTTP boundary, one organization / user / Agent / thread and
authorization links minted from one run, single process, requests issued
sequentially. The two builds differ in exactly one blob:

| Build     | `browser-authorization.service.ts`         |
| --------- | ------------------------------------------ |
| Baseline  | `89dcfaf69404070fc8fd5c4c2dc932faf0914544` |
| Candidate | `4f59282b0b129c8a186dc6dfdc8625f2acad113e` |

The baseline is the pre-fence service, the blob `main` carried at
`491c13c3a8978d45e36679dee5dba3e8da2d24a1` before this slice. The candidate is
the final repaired service. Each build was measured in its own process with that
blob in place, against an equivalent fixture created by that run rather than
literally the same rows, in a local database that still held rows from earlier
runs.

### Round-trip inventory

Statements counted per request from a driver-level proxy over one traced apply
per build. The counts are every statement the driver issues for that request,
**including the transaction-control statements**: the baseline's `BEGIN` and the
candidate's `BEGIN ISOLATION LEVEL READ COMMITTED` are each counted, as is each
build's single `COMMIT`.

| Request                | Baseline | Candidate |
| ---------------------- | -------: | --------: |
| Apply an authorization |        7 |        18 |

Both builds keep the same preflight token lookup, the same thread `UPDATE`, the
same sequence reservation, the same event insert, the same completion `UPDATE`
and one `COMMIT`. The eleven added statements per admitted apply are the two
`set_config` calls, the identity read, the isolation probe, two
`pg_advisory_xact_lock_shared` calls, the `account_erasure_jobs` closure lookup,
`agents FOR KEY SHARE`, `chat_threads FOR KEY SHARE`, the revalidating identity
re-read and the request pin. A thread whose Agent belongs to a different owner
adds one further advisory lock, for three subjects, giving 19.

### Query plans

`EXPLAIN (ANALYZE, BUFFERS)` inside one transaction that had already set the
`1s` and `5s` deadlines, second (warm) execution, on the local fixture:

| Added statement              | Plan                                                                           | Rows | Buffers | Execution |
| ---------------------------- | ------------------------------------------------------------------------------ | ---: | ------: | --------: |
| Identity read (left join)    | Nested Loop Left Join, `agents_pkey` Index Scan over a `chat_threads` Seq Scan |    1 |  4 hits |  0.055 ms |
| B1 closure lookup            | Seq Scan on the empty `account_erasure_jobs`                                   |    0 |   1 hit |  0.017 ms |
| `agents` FOR KEY SHARE       | LockRows over `agents_pkey`                                                    |    1 |  3 hits |  0.033 ms |
| `chat_threads` FOR KEY SHARE | LockRows over a `chat_threads` Seq Scan                                        |    1 |  4 hits |  0.021 ms |
| Request pin                  | Limit over LockRows over a `browser_authorization_requests` Seq Scan           |    1 |  3 hits |  0.026 ms |

The sequential scans are a property of the fixture, not of the statements: the
local `chat_threads` table held 3 rows, `browser_authorization_requests` 2 rows
for this owner and `account_erasure_jobs` was empty, so the planner preferred a
single heap page. Re-planned with `enable_seqscan = off`, the request pin uses
`uq_browser_authorization_requests_token_hash` (Index Scan, 3 buffer hits,
0.020 ms) and the closure lookup uses the
`account_erasure_subject_generation` `(subject_kind, subject_id)` prefix
(BitmapOr of two Bitmap Index Scans, 2 buffer hits, 0.015 ms). None of the added
statements sorts, aggregates or scans a range, and the advisory locks touch no
relation at all.

An earlier revision claimed every added statement resolves at most one row. That
is not true of the B1 closure lookup: it is a disjunction over all the admitted
subjects, so it can match one row per closed subject, and per generation of a
subject, up to the three subjects this path admits. It returned zero rows here
only because the local `account_erasure_jobs` table was empty. The identity
reads, the two `FOR KEY SHARE` locks and the request pin do each resolve at most
one row, by primary key or by a unique token hash.

### Per-request timing

The suite durations above are whole-suite wall clock dominated by the baseline's
`30 s` case timeouts and are **not** a per-request cost comparison. This is.

Method: one authorization link per build, three untimed warm-up applies, then
ten applies issued one after another with no concurrency, each timed around the
HTTP call alone. Repeat apply is accepted and unchanged, so every sample does
the identical admitted write. Milliseconds, in the order they were produced:

| Build     | Raw samples (ms)                                                     | Median |   Min |   Max |
| --------- | -------------------------------------------------------------------- | -----: | ----: | ----: |
| Baseline  | 13.21, 6.41, 8.38, 6.42, 5.96, 6.40, 6.50, 6.31, 6.87, 5.76          |   6.42 |  5.76 | 13.21 |
| Candidate | 23.47, 13.75, 13.45, 10.71, 13.85, 25.31, 11.97, 13.58, 12.28, 13.35 |  13.52 | 10.71 | 25.31 |

On this sandbox the fenced apply cost roughly 7 ms more per request at the
median, a little over twice the pre-fence path, for eleven added round trips
against a local socket. Both builds show single outliers well above their own
median, which is what a shared two-core sandbox produces; ten samples per build
do not separate that noise from the signal, and no variance claim is made.

These are bounded local observations on a two-core sandbox with empty erasure
tables and a local database, measured by the run that wrote this document. They
are not production throughput, not a per-request cost on any deployed
configuration, not a universal overhead bound, and not evidence that the added
cost is irreducible. A different database, latency, table size or closure
population would move both columns.

## Residual work

This is a producer fence for one endpoint only. It erases no existing binding,
cloud-browser flag, sidebar event, authorization request or snapshot, and it
does not complete B2, A2 or account erasure. Explicitly still unfenced, and not
covered by this slice:

- The authorization-request **read** endpoint. Request creation was deliberately
  outside this apply-only slice and is now fenced separately by
  [#35096](https://github.com/vm0-ai/okou/issues/35096); the read remains
  unfenced.
- `stopComputerUseHost$` and its `clearComputerUseHostThreadBindings`, the
  direct settings route's own retained host-revocation race, thread creation and
  the chat ingress services, and every other writer of thread content: the
  send-path model reconciler, member model preferences, image and video model
  routes, the generated and LLM title workflow, message create/send/edit/revoke,
  run and queue admission, and the sidebar snapshot projector.
- Browser session and provider lifecycle: session creation, resume, stop,
  reconciliation, profiles, egress and every remote provider-side artifact, plus
  Computer Use host registration and revocation and the Teams flows.
- Historical cleanup, inventory and purge of already durable selections,
  completed authorization requests and expired rows.
- Closure ingress, worker activation, independent recovery authority and any
  production erasure, deletion, canary or backfill operation.
