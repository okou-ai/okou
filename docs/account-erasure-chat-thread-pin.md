# Account erasure: direct thread pin writes (B2b2-R5)

Scope: [#34839](https://github.com/vm0-ai/okou/issues/34839), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the three
direct chat-thread pin writers with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the canonical parent lock
contract already accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md). It
installs no closure decision, ingress, worker, schema, migration or production
operation.

A pin timestamp, its client rank and the sidebar copy of both are account
content, not platform billing. This slice stops all three writers from
producing **new** pin state for a closed subject; pin state that is already
durable is historical data owned by C2/D/H and is not erased here.

## The three covered writers

| Entry point                            | Writes                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/chat-threads/:id/pin`       | `chat_threads.pinned_at` and `pin_order`, one `pinned` sidebar event |
| `POST /api/chat-threads/:id/unpin`     | clears both pin columns, one `unpinned` sidebar event                |
| `POST /api/chat-threads/:id/pin-order` | `chat_threads.pin_order` only, one `sort_touched` sidebar event      |

Each route already used one transaction for its `UPDATE`, the durable sidebar
sequence and its event, and already checked thread user, organization and Agent
existence. None of them took B1 admission, so a closed account could keep
pinning, unpinning and reordering, reserving a durable user/org sequence and
appending sidebar events for every attempt.

## Preserved route contracts

The fence adds no shared authorization. The three routes keep their distinct
configurations, which are **not** equalized:

- pin and unpin require an organization; they declare no capability.
- reorder additionally requires `chat-thread:write`.

Their other semantics are also unchanged: pin's rank validation and
omitted-rank-to-`null` default, pin writing one timestamp used for both the row
and the event `created_at`, unpin clearing both columns, reorder changing only
the rank and leaving `pinned_at` untouched, reorder's already-pinned `UPDATE`
predicate, the caller-supplied event ids and the existing duplicate event-id
suppression in `appendChatThreadEvent`.

Reorder's already-pinned requirement stays in the `UPDATE` predicate rather than
moving into `authorize`: the admitted identity is deliberately content-free and
carries no pin state, and an unpinned thread must keep returning the existing
404 without a second read.

## Canonical identity and admission

Each route now calls `withChatThreadContentWrite` at the writer itself. The
shared helper is unchanged, and `appendChatThreadEvent` is **not** wrapped
globally: it has other callers with their own transaction ownership, and a
universal guard there would hide admission inside an unrelated helper.

`authorize` is each route's existing ownership contract expressed over the real
persisted identity, and it is the same predicate for all three:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`.

That matches the `UPDATE` predicates these routes already use, where the
organization condition is an `EXISTS` over the Agent's `org_id` and
`agent_id IS NOT NULL` is required. The request's own `userId`/`orgId` and any
stored sidebar label remain comparison inputs, never authority.

At most three deduplicated subjects are admitted in sorted order: the thread
user, the Agent owner when it is a different user, and the actual organization.
A thread belonging to one user under another user's Agent therefore carries both
user subjects. Admission runs before any business-row lock, `UPDATE`, sequence
reservation or event insert, and every barrier is retained through `COMMIT`.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. Only then the pin `UPDATE`, the sidebar sequence reservation and the event.

The order is **subjects -> Agent -> thread -> content**, identical to the draft
and rename writers, so this slice introduces no new lock ordering and no cycle
against thread deletion, Agent transfer or deletion, the search projector or the
run-output writer. A canonical parent that moves under the locks rolls the
attempt back and reselects a bounded number of times; a new subject discovered
that way is admitted by a fresh attempt, never after the business-row locks.

## Failure contract

| Outcome                             | Disposition                                                    |
| ----------------------------------- | -------------------------------------------------------------- |
| Thread missing, foreign, wrong org  | Each route's existing `404 Chat thread not found`              |
| Reorder on an unpinned thread       | The same existing `404`, from the unchanged `UPDATE` predicate |
| B1 subject closure                  | The same existing `404`, with no write and no event            |
| Identity moved under the locks      | Roll back and reselect, at most three attempts                 |
| Attempts exhausted                  | `ChatThreadContentOwnershipChangedError` propagates            |
| Lock wait, statement timeout, abort | Original database error or cancellation, propagated unchanged  |

Closure reuses the existing not-found disposition, so the endpoints stay
non-oracular. Closure is **not** a success `204`, and a timeout, a blocked
parent lock or a cancelled request is **never** reported as a fabricated `404`.

A writer that is already admitted finishes: a closure arriving afterwards waits
on the retained shared subject barrier and commits only after that transaction,
and the next pin mutation is then rejected. A closure that commits first admits
no mutation, no event and no durable sequence increment. The `UPDATE`, the
sequence reservation and the event insert stay atomic, and
`publishThreadListChanged` still runs only after a successful commit.

## Measured local cost

Local development PostgreSQL 18, real HTTP boundary. These are bounded local
samples, not production throughput.

Every statement the fence adds is a primary-key index scan over one row:

| Added statement              | Plan                                | Rows | Buffers | Execution |
| ---------------------------- | ----------------------------------- | ---: | ------: | --------: |
| Identity read (left join)    | Nested Loop Left Join, two PK scans |    1 |  4 hits |  0.286 ms |
| `agents` FOR KEY SHARE       | LockRows over `agents_pkey`         |    1 |  3 hits |  0.296 ms |
| `chat_threads` FOR KEY SHARE | LockRows over `chat_threads_pkey`   |    1 |  3 hits |  0.017 ms |

End to end, 40 sequential requests on one thread (20 pin/unpin pairs), three
samples, same process and database:

| Build     | Samples            | Median | Per request |
| --------- | ------------------ | -----: | ----------: |
| Baseline  | 220 / 191 / 189 ms | 191 ms |     ~4.8 ms |
| Candidate | 580 / 527 / 467 ms | 527 ms |    ~13.2 ms |

The local difference is round-trip count, not lock contention: each pin write
went from one transaction to a transaction that also runs two `SET LOCAL` calls,
the identity read, the closure lookup, two `FOR KEY SHARE` locks and the
revalidating re-read. A transaction retained through `COMMIT` is what the B1
barrier requires. The plans above show no scan, no serialization and no
unbounded work; they do not establish production overhead, and combining round
trips could be optimized separately without weakening transaction ownership.

Unrelated owners keep making progress while one writer holds its barrier: the
writer-first test completes an unrelated owner's pin while the admitted pin is
paused at `COMMIT` with a closure already blocked behind it.

## Residual work

This is a producer fence only. It erases no existing pin state, sidebar event or
snapshot, and it does not complete B2, A2 or account erasure. Still open in the
parent epic, and explicitly outside this slice:

- Read cursors (`mark-read`, `mark-unread`, `mark-agent-read`), which have
  different authentication and need a bounded bulk-admission design.
- Model selection, service tier, image and video model preferences.
- Computer Use host and browser settings, including the separate
  `browser-authorization` writer, so the single direct route must not be
  advertised as complete browser fencing.
- The generated/LLM title workflow, message create/send/edit/revoke, run and
  queue admission, and the sidebar snapshot projector.
- Historical cleanup, inventory and purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
