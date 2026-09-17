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
same three deduplicated subjects as a single thread.

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

Every statement the fence adds is a single-row index lookup, measured with
`EXPLAIN (ANALYZE, BUFFERS)` inside one transaction that already set the `1s`
and `5s` deadlines:

| Added statement              | Plan                                              | Rows | Buffers | Execution |
| ---------------------------- | ------------------------------------------------- | ---: | ------: | --------: |
| Identity read (left join)    | Nested Loop Left Join over two unique-index scans |    1 |  6 hits |  0.960 ms |
| `agents` FOR KEY SHARE       | LockRows over `idx_agents_id_org_owner`           |    1 |  4 hits |  0.202 ms |
| `chat_threads` FOR KEY SHARE | LockRows over `chat_threads_pkey`                 |    1 |  5 hits |  0.104 ms |
| Mark-read fallback cursor    | Index Scan on `chat_threads_pkey`                 |    1 |  3 hits |  0.038 ms |

No statement scans, sorts or serializes, and each touches exactly one row. The
identity read's first execution above includes a cold `Index Only Scan` heap
fetch; its planning buffers dominate a first call and not steady state.

End to end, 40 sequential requests on one thread (20 mark-read/mark-unread
pairs), three samples after a warm-up pair, same process and database:

| Build     | Samples            | Median | Per request |
| --------- | ------------------ | -----: | ----------: |
| Baseline  | 220 / 339 / 292 ms | 292 ms |     ~7.3 ms |
| Candidate | 478 / 339 / 329 ms | 339 ms |     ~8.5 ms |

These samples overlap and the spread within each build is larger than the gap
between them, so this run bounds the added cost at roughly one millisecond per
request locally rather than resolving it precisely. What it does establish is
the shape: the added work is round-trip count, not lock contention. Each write
went from one statement to a transaction that also runs two `SET LOCAL` calls,
the identity read, the closure lookup, two `FOR KEY SHARE` locks and the
revalidating re-read, plus one `last_read_at` select on the mark-read path. A
transaction retained through `COMMIT` is what the B1 barrier requires. The plans
above show no scan, no serialization and no unbounded work; they do not
establish production overhead, and combining round trips could be optimized
separately without weakening transaction ownership.

Admission is constant-size one-thread work and is independent of the response
unread query, which already scanned the caller's threads under the Agent before
this change. The parent epic's dated totals (156,947 threads at the September 16
sample) are not deletion candidates and are not this slice's cost.

Unrelated owners keep making progress while one writer holds its barrier: the
writer-first tests complete an unrelated owner's read-cursor write while the
admitted mark-read is paused at `COMMIT` with a closure already blocked behind
it.

## Residual work

This is a producer fence only. It erases no existing cursor, unread projection
or browser cache, and it does not complete B2, A2 or account erasure. Post-commit
realtime egress and read-response erasure or drain are separate broader
obligations, and a closure may begin immediately after this commit. Still open
in the parent epic, and explicitly outside this slice:

- `POST /api/chat-thread-unreads/mark-read`, which needs the bounded-runtime and
  complete-scope disposition described above.
- Model selection, service tier, image and video model preferences.
- The generated/LLM title workflow, message create/send/edit/revoke, run and
  queue admission, and the sidebar snapshot projector.
- Historical cleanup, inventory and purge of already durable read state.
- Closure ingress, worker activation and any production erasure operation.
