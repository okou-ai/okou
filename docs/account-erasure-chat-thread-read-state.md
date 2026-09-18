# Account erasure: direct thread read-cursor writes (B2b2-R7)

Scope: [#34864](https://github.com/vm0-ai/okou/issues/34864), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the two
single-thread read-cursor writers with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the canonical parent lock
contract already accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md) and for
[pin writes](account-erasure-chat-thread-pin.md). It installs no closure
decision, ingress, worker, schema, migration or production operation.

A read cursor is account read state, not platform billing. This slice stops both
writers from producing **new** read state for a closed subject; a cursor that is
already durable is historical data owned by C2/D/H and is not erased here.

## The two covered writers

| Entry point                              | Writes                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `POST /api/chat-threads/:id/mark-read`   | `chat_threads.last_read_at`, only when the latest terminal marker is newer |
| `POST /api/chat-threads/:id/mark-unread` | clears `chat_threads.last_read_at` unconditionally for the authorized row  |

Neither route wrote a durable sidebar event or consumed a sequence before this
change, and neither does now. Both ran their `UPDATE` through `writeDb` with no
transaction, no B1 admission and no canonical parent lock, so a closed account
could keep advancing and clearing its own read cursor and keep emitting the
`chatThreadReadCursorUpdated` invalidation for every attempt.

`POST /api/chat-thread-unreads/mark-read` is deliberately **not** in this slice.
It is one set-based writer over every matching thread with an existing atomic
all-matching contract, an uncapped `RETURNING` list and a notification carrying
every changed id, so it needs its own bounded-runtime and complete-scope
disposition. Its erasure-subject cardinality is not the reason: every matched
row shares one authenticated user and one selected Agent, so it has at most the
same three deduplicated subjects as a single thread. That slice is
[bulk Agent read-cursor writes](account-erasure-chat-thread-bulk-read.md).

## Preserved route contracts

The fence adds no shared authorization, and the two routes are **not** aligned
with the pin or rename writers:

- Both keep `authRoute({})`: no organization is required and no capability is
  required. A caller with no active organization, or with a different active
  organization, still owns its own thread and still succeeds.
- Both still require the thread's user to equal the caller and still require a
  real, resolvable Agent, which is what the original `innerJoin(agents)` and the
  `agent_id IS NOT NULL` predicate enforced.
- The Agent's actual organization is **never** compared with the caller's active
  organization. It is still an erasure subject, because it is the organization
  the read-state invalidation is published to.
- The existing common-auth dispositions are untouched: a valid Okou or sandbox
  credential keeps its standard `403 sandbox-unavailable`, an anonymous request
  keeps `401`, and a malformed thread id keeps `400`.

Their read-state semantics are also unchanged. Mark-read keeps its monotonic
advancing predicate, still resolves the target instant from the latest terminal
`chat_events` marker rather than wall-clock time, and a thread with no terminal
event or an already current cursor still succeeds while preserving the existing
timestamp and publishing nothing. Mark-unread still clears unconditionally, so a
repeated clear keeps its existing success and its existing publication. Both
still answer with the freshly queried unread snapshot for the thread's Agent,
computed after commit on the successful path only.

## Canonical identity and admission

Each route now calls `withChatThreadContentWrite` at the writer itself. The
shared helper is unchanged.

`authorize` is each route's existing ownership contract expressed over the real
persisted identity, and it is the same predicate for both:

- `identity.userId === auth.userId` and a non-null Agent.

It deliberately does **not** include `identity.orgId === auth.orgId`. Copying
pin's organization equality here would reject the orgless and different-active-
organization callers these endpoints accept today.

At most three deduplicated subjects are admitted in sorted order: the thread
user, the Agent owner when it is a different user, and the actual organization.
A thread belonging to one user under another user's Agent therefore carries both
user subjects, including after a same-organization owner transfer. Admission
runs before any business-row lock or `UPDATE`, and every barrier is retained
through `COMMIT`.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. Only then the read-cursor `UPDATE`.

The order is **subjects -> Agent -> thread -> content**, identical to the draft,
rename and pin writers, so this slice introduces no new lock ordering and no
cycle against thread deletion, Agent transfer or deletion, the search projector
or the run-output writer. A canonical parent that moves under the locks rolls
the attempt back and reselects a bounded number of times.

Mark-read needs the cursor it preserves when nothing advances. That fallback is
now read **inside** the admitted transaction, as its own `last_read_at` select,
instead of being carried in from the unfenced pre-read the route used to run
before any admission. The canonical identity is deliberately not extended with
cursor content to supply it: identity stays content-free, so it can be resolved
and compared before any account content is touched.

Publication inputs come from the committed canonical identity, never from the
request's own organization or a pre-admission label, and
`publishChatThreadReadCursorUpdatedSafely` still runs only after a successful
`COMMIT` — for mark-read only when the `UPDATE` actually changed the row.

## Failure contract

| Outcome                             | Disposition                                                   |
| ----------------------------------- | ------------------------------------------------------------- |
| Thread missing, foreign, Agent-less | Each route's existing `404 Chat thread not found`             |
| B1 subject closure                  | The same existing `404`, with no mutation and no notification |
| Identity moved under the locks      | Roll back and reselect, at most three attempts                |
| Attempts exhausted                  | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort | Original database error or cancellation, propagated unchanged |

Cancellation has one exact boundary, and it is the operation signal rather than
the client connection. `honoSignalHandler` hands the app's own signal to every
route command; `requestSignal$` exposes `c.req.raw.signal` but neither route
reads it, so a disconnecting client does not cancel an in-flight write. When
that operation signal aborts **after** the cursor `UPDATE` and **before** the
transaction callback returns, the check that follows the write throws, the
transaction rolls back and nothing is published. Once the callback has returned,
`COMMIT` is already on its way: a cancellation arriving then loses the race, the
cursor stays committed, and only the post-transaction publication and response
are dropped. That is an at-most-once publication property of the
publish-after-commit order, shared with the unfenced code this slice replaced,
not a rollback — and not something this slice may describe as one.

Closure reuses the existing not-found disposition, so the endpoints stay
non-oracular. Closure is **not** a success `200`, including on the mark-read
no-advance path and the repeated mark-unread path that would otherwise both be
accepted no-ops, and a timeout, a blocked parent lock or a cancelled request is
**never** reported as a fabricated `404`.

A writer that is already admitted finishes: a closure arriving afterwards waits
on the retained shared subject barrier and commits only after that transaction,
and the next read-cursor request is then rejected. A closure that commits first
admits no mutation and no invalidation.

## Concurrent native Morning Brief delivery

[#34826](https://github.com/vm0-ai/okou/issues/34826) /
[#34843](https://github.com/vm0-ai/okou/issues/34843) owns a server-defined
native-delivery read watermark and replaces the shared latest-unread-marker
query these routes call. That is a different feature, not duplicate erasure
fencing, and neither slice waits for the other.

This fence deliberately keeps the call shape it found on `main`: mark-read still
resolves its target instant by calling the one shared subquery helper, now built
from `tx` so it runs inside the admitted transaction. Whichever slice merges
second rebases onto the other and keeps both semantics — the shared helper the
other slice defines, called from inside this transaction. Nothing here restores
a terminal-only watermark over a merged native-delivery marker, and the
automatic client-side read gate is untouched.

## Measured local cost

Local development PostgreSQL 18.6, real HTTP boundary. These are bounded local
samples, not production throughput.

Four of the statements the fence adds were measured with
`EXPLAIN (ANALYZE, BUFFERS)` inside one transaction that already set the `1s`
and `5s` deadlines. They are not every statement the fenced transaction runs:
the two `SET LOCAL` calls, the shared `assertErasureSubjectWritable` lookup, the
revalidating identity re-read and each route's own cursor `UPDATE` were not
measured here.

| Added statement              | Plan                                              | Rows | Buffers | Execution |
| ---------------------------- | ------------------------------------------------- | ---: | ------: | --------: |
| Identity read (left join)    | Nested Loop Left Join over two unique-index scans |    1 |  6 hits |  0.960 ms |
| `agents` FOR KEY SHARE       | LockRows over `idx_agents_id_org_owner`           |    1 |  4 hits |  0.202 ms |
| `chat_threads` FOR KEY SHARE | LockRows over `chat_threads_pkey`                 |    1 |  5 hits |  0.104 ms |
| Mark-read fallback cursor    | Index Scan on `chat_threads_pkey`                 |    1 |  3 hits |  0.038 ms |

Each of these four plans is a single-row index lookup with no sequential scan
and no sort. That is a statement about these four plans only. It is not a
concurrency claim: two requests writing the **same** `chat_threads` row do
serialize, because the first `UPDATE` holds that row until it commits, and the
second waits on it inside the `1s` `lock_timeout`. The retained `FOR KEY SHARE`
locks are chosen so unrelated rows and the routes' own row updates are not
serialized against each other, not to remove same-row contention. The identity
read's first execution above includes a cold `Index Only Scan` heap fetch; its
planning buffers dominate a first call and not steady state.

End to end, 40 sequential requests on one thread (20 mark-read/mark-unread
pairs), three samples after a warm-up pair, same process and database:

| Build     | Samples            | Median | Per request |
| --------- | ------------------ | -----: | ----------: |
| Baseline  | 220 / 339 / 292 ms | 292 ms |     ~7.3 ms |
| Candidate | 478 / 339 / 329 ms | 339 ms |     ~8.5 ms |

Three samples per build is too few to bound anything. The distributions overlap
(the candidate's 329 ms and 339 ms sit inside the baseline's 220–292 ms to
478 ms span), and the spread within each build is larger than the gap between
their medians, so these numbers do **not** establish an upper bound of about one
millisecond per request, or any other upper bound. They are six raw local
timings, kept above exactly as observed; treat the ~7.3 ms and ~8.5 ms columns
as arithmetic on those medians, not as a per-request cost.

What the change does is known from its own shape rather than from these numbers:
each write went from one statement to a transaction that also runs two
`SET LOCAL` calls, the identity read, the closure lookup, two `FOR KEY SHARE`
locks and the revalidating re-read, plus one `last_read_at` select on the
mark-read path. A transaction retained through `COMMIT` is what the B1 barrier
requires. The four measured plans show no scan and no unbounded work for those
four statements; they do not establish production overhead, do not cover the
statements omitted above, and do not speak to contention between callers.
Combining round trips could be optimized separately without weakening
transaction ownership.

Admission is constant-size one-thread work and is independent of the response
unread query, which already scanned the caller's threads under the Agent before
this change. The parent epic's dated `chat_threads` totals — 156,947 in the
September 14 foundation refresh and 158,712 in a separate September 16 sample —
are non-atomic source-row counts. They are not deletion candidates and are not
this slice's cost.

Unrelated owners keep making progress while one writer holds its barrier: the
writer-first tests complete an unrelated owner's read-cursor write while the
admitted mark-read is paused at `COMMIT` with a closure already blocked behind
it.

## Test evidence

Every case below runs against the real routes over HTTP and a real PostgreSQL,
and reads results back through production endpoints. The table separates what
the merged suite already covered from what this follow-up adds, because two
adjacent claims are easy to overstate: a closure that is _blocked_ behind an
admitted writer is not the same as the cursor being _invisible_ while that
writer runs, and a failure taken _before_ the cursor `UPDATE` proves nothing
about rolling that `UPDATE` back.

| Contract clause                                               | Existing evidence                                                                                   | Added here                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| An admitted writer holds its subject barrier through `COMMIT` | Two writer-first cases: a closure blocks behind the paused writer, an unrelated owner keeps writing | unchanged                                                                                                                          |
| The new cursor is invisible until `COMMIT`                    | none — both writer-first cases released the barrier before reading anything back                    | Both routes paused at `COMMIT` with the `UPDATE` applied: a separate HTTP reader still returns the old cursor and unread indicator |
| Nothing is published before `COMMIT`                          | none — publication was only asserted after the writer finished                                      | The same two cases assert the outbound mock is untouched while paused, then assert the exact payload after release                 |
| A cancelled write leaves no cursor mutation or publication    | none — the held-parent-lock case fails at the `chat_threads` lock, before any cursor `UPDATE`       | Both routes paused **after** their `UPDATE` (its own row count asserted), operation signal aborted, then rolled back and re-driven |
| A commit that wins the race is not a rollback                 | none                                                                                                | Both routes cancelled while paused at `COMMIT`: the cursor stays committed, the response fails and no invalidation is published    |
| A blocked parent lock is a failure, not a closure `404`       | Held `chat_threads` row lock propagates its own error                                               | unchanged                                                                                                                          |

The cancellation cases drive the operation signal described in the failure
contract, through an app the test owns, because that is the signal the route
commands receive. They are pinned to the boundary they claim: moving the same
pause to `COMMIT` reports no cursor row count and stops proving rollback, and
leaving the cancellation out at the post-`UPDATE` pause commits and publishes.
The barrier pauses the writer between statements, so no lock or statement
deadline is running during any observation window and no case waits on a sleep
or a widened budget.

## Residual work

This is a producer fence only. It erases no existing cursor, unread projection
or browser cache, and it does not complete B2, A2 or account erasure. Post-commit
realtime egress and read-response erasure or drain are separate broader
obligations, and a closure may begin immediately after this commit. Still open
in the parent epic, and explicitly outside this slice:

- Model selection, service tier, image and video model preferences.
- The generated/LLM title workflow, message create/send/edit/revoke, run and
  queue admission, and the sidebar snapshot projector.
- Historical cleanup, inventory and purge of already durable read state.
- Closure ingress, worker activation and any production erasure operation.
