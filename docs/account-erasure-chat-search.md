# Account erasure: durable chat search projection (B2b2-R2)

Scope: [#34700](https://github.com/vm0-ai/okou/issues/34700), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the durable
chat-search producer with the existing dormant
[B1 barrier](account-erasure-foundation.md) and preserves the accepted
[run-output](account-erasure-run-output.md) and
[terminal callback](account-erasure-terminal-callback.md) contracts. It installs
no closure decision, ingress, worker, schema, migration or production operation.

Searchable chat text is account data, not platform billing. This slice stops the
projector from producing **new** rows for a closed subject; rows that already
exist are historical data owned by C2/D/H and are not erased here.

## Why the projection needs its own fence

`chat_event_search_messages` stores long-lived message text, its bigram form and
a generated `tsvector`, plus the `user_id`/`org_id`/`agent_id` labels the reader
filters on. Neither it nor `chat_event_search_message_watermarks` has a foreign
key to `chat_threads`, and both intentionally outlive `chat_events` retention:
the disappearance of a source event is not erasure of its searchable copy.

Before this change the projector re-read only thread existence and the last
sequence, then copied owner-bound content using the user/org/Agent labels
captured during candidate selection. It acquired no B1 admission and held no
canonical parent lock, so a projector racing `deleteChatThread$` could rewrite
the rows that deletion had just removed. Its orphan-cleanup comment accepted
that recreation explicitly and deferred repair to the next cron tick.

## Canonical ownership of the derived copy

The canonical owner of one thread-scoped search row is the **thread user plus
the Agent the thread belongs to**: the Agent's identity, its `owner` and its
`org_id`. `loadProjectionThread` resolves all of it from the real persisted
parents with the same inner join candidate selection uses, so a thread without a
resolvable Agent has no canonical owner and is not projected.

The snapshot is content free, which is what allows admission to happen before
any message text is read. `agentOwner` only widens the admitted subject set; the
persisted labels remain `userId`/`orgId`/`agentId` exactly as before, and this
slice migrates no historical run or content ownership.

User and organization stay separate subject domains. A thread user and a shared
Agent's owner are distinct user subjects, so closing one member never closes the
other or the organization.

## Transaction order and retained barriers

Each candidate gets one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout`/`statement_timeout`.
2. Content-free ownership snapshot.
3. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
4. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
5. Re-read the same content-free ownership under those locks and compare.
6. Only then read event content, insert search messages, delete revoked rows and
   advance the watermark.

The order is **subjects -> Agent -> thread -> projection rows**, matching the
run-output writer's resource-before-thread order and the orphan repair's
watermark-before-messages order. No subject lock is acquired after a business
lock, and every barrier is retained through COMMIT.

Lock strength follows the actual constraints and writers:

- `agents` carries the `idx_agents_id_org_owner` unique key over
  `(id, org_id, owner)`, so an owner or organization move is a **key** update.
  KEY SHARE conflicts with it and with Agent deletion, which cascades the thread.
- `chat_threads` has no unique key containing `user_id` or `agent_id`, and no
  production writer updates either column; the repository's only writers of those
  columns are test fixtures. Its KEY SHARE conflicts with the `FOR UPDATE` that
  `deleteChatThread$` takes before removing the projection rows, and with Agent
  cascade deletion, while leaving ordinary thread updates such as
  `lastMessageAt`/`lastChatEventSeqId` free. The projector therefore still does
  not serialize against ordinary chat-event writes.
- Because a non-key ownership move would not conflict, the ownership tuple is
  re-read under the retained locks. A transfer committed between selection and
  lock acquisition rolls the attempt back instead of relabelling prepared
  content or expanding the admitted subject set after the business locks.

An observed ownership race rolls back and reselects in a fresh transaction, at
most three attempts, each resolving the complete subject set again. After that
the thread is deferred to the next tick. Selection carries no identity at all
now: `loadCandidateThreads` returns thread IDs only.

### Both commit orders against thread deletion

- **Projection first:** the projector holds `chat_threads` KEY SHARE, so the
  deletion's `FOR UPDATE` waits for COMMIT and then removes the messages **and**
  the watermark it just wrote.
- **Deletion first:** the projector's KEY SHARE waits behind the deletion. When
  that transaction commits, the locked re-read finds no thread and the attempt
  performs no insert, no revocation delete and no watermark advance. If the
  deletion outlives the per-thread lock budget the thread is deferred, not
  written.
- **Selection/read gap:** a thread deleted after selection resolves as a missing
  parent in step 2 or step 5, again with no write.

`deleteChatThread$` keeps its synchronous cleanup, and
`cleanupOrphanedSearchProjection` keeps its bounded repair. Repair now covers
only rows written before this fence and any older producer; it is no longer the
answer to a racing projector.

## Eligibility, disposition and honest convergence

Candidate selection adds an indexed `NOT EXISTS` over `account_erasure_jobs`
through `erasureSubjectOpenCondition`, using the
`(subject_kind, subject_id)` prefix of `account_erasure_subject_generation` for
the same three subjects the transaction admits. Closed threads therefore stop
consuming the bounded 500-thread batch, so any number of low-sorting closed
candidates cannot starve a later eligible thread. **Selection is not authority**:
it takes no lock and can go stale immediately, so the in-transaction shared
admission still decides, and a closure committed after selection is denied there.

`convergence.eligibleThreads` applies the same filter, so eligible now means
"has events and no closed canonical subject". A thread this fence refuses to
index leaves the eligible set instead of being reported as permanent lag, and no
closed thread's watermark is advanced to fake convergence. The Agent join stays
outer there so threads without a resolvable Agent keep their previous
eligibility.

Two new response counters keep the dispositions separate:

| Counter           | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `closedThreads`   | Denied by B1's exact `account_erasure:subject_closed` inside the transaction                |
| `deferredThreads` | Bounded `55P03` lock wait or an exhausted ownership race; retried next tick, watermark kept |

Cancellation and every other database failure keep their existing propagation:
a statement timeout, a driver error or an abort is never reported as closure, and
a closure is never reported as infrastructure failure. `threads`, `indexedEvents`,
`deletedDocs` and `orphanedThreads` keep their meanings.

Message role/text extraction, retired-Goal archive text, revocation deletes by
thread/sequence, monotonic watermarks, the full-page boundary, duplicate
idempotency and search-after-source-retention are unchanged.

## Lock and statement budget

Each per-thread transaction uses `lock_timeout` **1s** and `statement_timeout`
**5s**, the repository's existing content-write limits. Waiting is newly possible
because the fence conflicts with thread deletion, Agent transfer/deletion and an
exclusive erasure holder, and `lock_timeout` covers B1's advisory acquisition as
well as the row locks. A contended thread is deferred after one second rather
than failing the tick, so a single held deletion or closure cannot stop the
minute-cadence cron, and the deferred thread keeps its watermark and is
reselected next tick. The 500-thread and 1000-event bounds and the cron's
inherited abort ownership are unchanged; no global or whole-table lock exists and
no transaction is unbounded.

## Verification and cost boundaries

Coverage lives in the existing route suite for the real cron and test-scoped
projector endpoints, so no new ESLint exception was added. The dormant B1
closure, a paused projector COMMIT, held identity rows and an Agent owner move
are not constructible through any production API; those narrow infrastructure
fixtures execute every original query unchanged and mock nothing. The commit
barrier pauses at COMMIT rather than at a statement so the projector's own
deadlines stay outside the observation window, and it reports the connection's
real `lock_timeout`/`statement_timeout`. Lock waits are observed with
`pg_blocking_pids` and the blocked statement kind, never with a sleep. There are
no logger or Axiom assertions.

The suite covers both commit orders against real thread deletion and the real
closure, the selection/read gap, thread-user, distinct-Agent-owner and
organization closures with an unrelated owner still progressing, a closure
committed after selection, ownership re-derivation after a transfer in both
directions, an ownership move during lock acquisition, more than one batch of
closed low-sorting candidates, and a bounded deferral followed by a clean retry.
Existing projection, revocation, orphan-repair, idempotency, batch-bound and
reader/retention regressions remain.

Finite local plans on PostgreSQL 18.6, UTC, inside one synthetic transaction that
was rolled back (+5,000 agents, +100,000 threads with 99,072 eligible, 98,000
watermarks):

| Statement                       | Before                        | After                                               |
| ------------------------------- | ----------------------------- | --------------------------------------------------- |
| Candidate selection (limit 500) | 108.7 ms, 102,094 buffer hits | 189.6 ms / 162.9 ms with 20 / 2,000 closed subjects |
| Convergence aggregate           | 69.2 ms, 2,272 buffer hits    | 246.4 ms / 330.8 ms with 20 / 2,000 closed subjects |

Per-thread statements stay on primary/composite indexes: the ownership join uses
`chat_threads_pkey` with an `idx_agents_id_org_owner` index-only scan
(0.060 ms), thread KEY SHARE 0.034 ms, Agent KEY SHARE 0.034 ms, and B1's closure
lookup 0.035 ms through `account_erasure_subject_generation`. The subject set is
fixed at a maximum of three. These are local plans at synthetic scale, not
production planner, cache or throughput measurements, and no index was added.

Controller-provided read-only production totals, **2026-09-16
12:32:41–12:32:54 UTC**, are non-atomic whole-table counts and not deletion
candidates: `chat_threads` **158,657**, `chat_event_search_message_watermarks`
**157,319**, `chat_event_search_messages` **1,955,877**. No foreign key,
migration, backfill or historical scan is added to that derived table.

## Remaining obligations

This fences one derived copy of chat text. It is not complete B2/A2 readiness and
not H. Existing search rows, R2 snapshots and other historical copies remain
C2/D/H work. Chat input writers, summaries/followups/automation results,
notification and sidebar copies, files/sites, credentials and remote sessions
remain B2b2-R/D/E/G2. Already-running older API and Runner producers still need
independently verified drain; this change alters no public protocol or persisted
schema and establishes no fence for those versions.

Account closure remains dormant: no decision authority, activation, Clerk
acknowledgement, deletion worker or production operation ships here, and the
recovered September 12 account is excluded from every fixture. The implementation
owner stops at this PR's protected merge; controller acceptance and separate
release publication remain independent.
