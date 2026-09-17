# Account erasure: bulk Agent read-cursor writes (B2b2-R9)

Scope: [#34877](https://github.com/vm0-ai/okou/issues/34877), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the one
set-based read-cursor writer with the existing dormant
[B1 barrier](account-erasure-foundation.md), and bounds the ids it returns and
publishes. It reuses the canonical parent lock contract already accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md), for
[pin writes](account-erasure-chat-thread-pin.md) and for the
[two single-thread read-cursor writers](account-erasure-chat-thread-read-state.md),
which deliberately left this route to its own slice. It installs no closure
decision, ingress, worker, schema, migration or production operation.

A read cursor is account read state, not platform billing. This slice stops the
writer from producing **new** read state for a closed subject; a cursor that is
already durable is historical data owned by C2/D/H and is not erased here.

## The covered writer

| Entry point                               | Writes                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/chat-thread-unreads/mark-read` | `chat_threads.last_read_at` for **every** unread thread of one user under one Agent |

It writes no durable sidebar event and consumes no sequence, before or after
this change. It ran its `UPDATE` through `writeDb` with no transaction, no B1
admission and no canonical parent lock, and its `RETURNING` list and the single
`chatThreadReadCursorUpdated` invalidation it publishes both carried one id per
changed thread, with no bound.

## Preserved route contract

The fence adds no authorization and no capability:

- The route keeps `authRoute({ requireOrganization: true, missingOrganizationStatus: 401 })`.
- It keeps its own selection predicates unchanged, including `chat_threads.user_id`
  equal to the caller, the Agent's organization equal to the caller's active
  organization, and the monotonic latest-terminal recheck.
- It still does **not** require the caller to own the Agent. A member with their
  own threads under another member's shared Agent still succeeds, and other
  members' threads under the same Agent stay untouched.
- Malformed bodies keep `400` and anonymous requests keep `401`. No `404` is
  introduced; the contract declares `204/400/401/403` and nothing is added.

## Canonical identity and admission

Every matched row shares one authenticated user and one selected Agent, so the
canonical subject set is **at most three** — the actor, the Agent's `owner` when
it is a different user, and the Agent's organization — whether one thread or
every thread matches. Subject cardinality is independent of thread count, and no
thread or content scan derives a subject. This is not the sidebar projector's
unbounded owner set.

The route therefore resolves the Agent's content-free identity by primary key
(`id`, `owner`, `org_id`) and admits those deduplicated subjects through the
unchanged sorted shared `assertErasureSubjectWritable`, before any business-row
lock and before any cursor write.

`authorize` is this route's existing organization scope expressed over the real
persisted identity: `identity.orgId === auth.orgId`. It runs **before**
admission, so a request for an Agent the caller may not read never takes another
account's subject locks.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free Agent identity resolution, by primary key.
3. The route's own organization check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**.
6. Re-read the same content-free identity under that lock and compare.
7. Only then the bulk read-cursor `UPDATE`.

The order is **subjects -> Agent -> content**, a prefix of the
subjects -> Agent -> thread -> content order the draft, rename, pin and
single-thread read-cursor writers already use, so this slice introduces no new
lock ordering and no cycle against thread deletion, Agent transfer or deletion,
the search projector or the run-output writer.

`agents` carries the `(id, org_id, owner)` unique key, so KEY SHARE conflicts
with an owner or organization transfer and with Agent deletion, which cascades
the matched threads. It does not conflict with the `FOR NO KEY UPDATE` the bulk
`UPDATE` itself takes on `chat_threads`, so holding the Agent identity key adds
no serialization of its own to thread traffic.

The route takes **no separate per-thread admission lock**: it never enumerates
thread subjects and never loops a single-thread helper transaction. That is a
statement about admission, not about row locks. The bulk `UPDATE` does lock
every row it matches, for the rest of the transaction, so a concurrent writer of
one of those same rows waits on it and the bulk statement waits on a row another
writer already holds — `1s` later that wait becomes this route's failure, and
the covering test is
`leaves every cursor unchanged when the bulk write cannot take a matched row's lock`.
Evidence that one specific unrelated owner was not serialized is evidence about
threads under a different Agent, not a claim that all thread traffic is
unserialized.

An Agent that moves under the lock rolls the attempt back and reselects, at most
three attempts, so a newly discovered subject is never appended after the
business locks and cursors are never written under a stale owner.

Publication runs only after a successful `COMMIT`, and only when rows changed.

## Failure contract

| Outcome                                                          | Disposition                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Agent missing, or in another organization                        | The existing `204`, decided **before** admission, no notification            |
| B1 subject closure on an admitted Agent                          | The contract's declared `403`, generic, with no mutation and no notification |
| Admitted Agent with no unread threads                            | `403` when closed, the existing `204` when open                              |
| Agent deleted between selection and lock                         | The same `204` after revalidation, no resurrected cursor, no notification    |
| Agent's organization moved under the locks                       | Reselect, then the same `204`: the caller's scope no longer authorizes it    |
| Agent's owner moved under the locks                              | Reselect and admit the newly resolved owner, so a closed one denies with 403 |
| Attempts exhausted                                               | `ChatThreadAgentOwnershipChangedError` propagates                            |
| Lock wait or statement timeout                                   | Original database error, propagated unchanged                                |
| Operation cancelled after the write, before the callback returns | Rollback of every executed row write, the original cancellation propagated   |
| Operation cancelled once `COMMIT` is on its way                  | The cursors stay committed; only the publication and response are dropped    |

The `403` body is `Chat read state is unavailable`: it names no subject, no
owner and no reason. Because the Agent is admitted **before** the unread match
is computed, a closed subject is denied even when the request would otherwise
have changed zero rows, so closure cannot be told apart from an ordinary no-op
by row count. A missing or foreign Agent is resolved earlier and keeps its
existing `204` even when the caller's own subject is closed, so the endpoint
stays non-oracular about accounts the caller cannot already see. A timeout, a
blocked parent lock or a cancelled request is **never** reported as closure or
as a fabricated success.

A writer that is already admitted finishes: a closure arriving afterwards waits
on the retained shared subject barrier and commits only after that transaction,
and the next bulk request is then rejected. A closure that commits first admits
no mutation and no invalidation. While that admitted writer is paused with every
matched cursor written and its `COMMIT` not yet sent, nothing outside it reads
the new cursors, its unread listing is unchanged, and no invalidation has been
published for that Agent — an unrelated owner publishing their own progress in
the same window is a different Agent on a different user-org channel.

## Cancellation between the write and the commit

Cancellation has one exact boundary here, the same one the
[single-thread read-cursor writers](account-erasure-chat-thread-read-state.md)
document, and it is the **operation signal** rather than the client connection.
`honoSignalHandler` hands the app's own signal to every route command;
`requestSignal$` exposes `c.req.raw.signal` but this route never reads it, so a
disconnecting client does not cancel an in-flight write and a `fetchOptions`
signal only abandons the caller's own promise.

The helper checks that operation signal immediately after the bulk statement
returns and before the transaction callback resolves. An operation cancelled in
that gap rolls back work PostgreSQL really performed:

- The signal aborts while the transaction holds every matched row's write — the
  statement's own reported row count proves it executed — and has issued no
  `COMMIT`; the check that follows the write throws and the transaction rolls
  back.
- The request fails. It is **not** the existing `204` and **not** the closure
  `403`, so a cancelled caller can never read a cancelled write as a success or
  as an account decision.
- Every cursor equals its pre-request value, every thread is unread again, and
  nothing is published — including for an overflow-sized write past the
  notification budget, which would otherwise publish the agent-scoped payload.
- A rolled back attempt is not a durable denial: the same request commits the
  whole set once its operation is no longer cancelled.

Once the callback has returned, `COMMIT` is already on its way. A cancellation
arriving then **loses the race**: every cursor stays committed and only the
post-transaction publication and the response are dropped. That is the
at-most-once publication property of the publish-after-commit order, shared with
the unfenced code this slice replaced — it is not a rollback, and this slice
does not describe it as one. Both boundaries are covered separately so neither
can be read as the other.

A blocked row lock also proves the atomic failure outcome — the statement fails,
no cursor moves — but unordered SQL fixes no visit order, so it is not evidence
that some other row had already been written. The cancellation case above is
what supplies that.

## Bounded ids over a complete atomic write

The complete all-matching `UPDATE` is unchanged — same selection, same lateral
latest-terminal subquery, same monotonic outer recheck, same parameters — and
now runs inside a data-modifying CTE whose outer query returns at most **101**
ids:

```sql
WITH "updated_threads" AS (update "chat_threads" set ... returning "chat_threads"."id")
SELECT "id" FROM "updated_threads" LIMIT 101
```

PostgreSQL executes a data-modifying statement in `WITH` exactly once and always
to completion, independently of whether the primary query reads all of its
output. The limit therefore bounds only the ids that cross the driver. It is not
pagination, not a batch, not a partial commit, and it does not order or
materialize every id in application memory. `EXPLAIN (ANALYZE, BUFFERS)` over
129 matching rows on local PostgreSQL 18, inside a transaction that already set
the `1s` and `5s` deadlines:

```
Limit  (cost=100.09..100.11 rows=1 width=16) (actual time=0.413..2.357 rows=101.00 loops=1)
  CTE updated_threads
    ->  Update on chat_threads  (actual time=0.410..2.971 rows=129.00 loops=1)
  ->  CTE Scan on updated_threads  (actual time=0.382..1.558 rows=101.00 loops=1)
        Storage: Memory  Maximum Storage: 20kB
Planning Time: 0.719 ms   Execution Time: 2.357 ms
```

129 rows updated, 101 returned. These are bounded local samples, not production
throughput. A full `UPDATE` remains **O(every matching row)** of database work,
so the `5s` statement timeout is a real bound: exceeding it rolls the whole
operation back rather than committing a prefix. Nothing here promises success at
arbitrary size, and no hidden retry runs until it succeeds. The operation signal
is checked between statements, as before; it does not cancel an in-flight
statement, and the check that follows this one rolls the completed statement
back rather than committing it.

## Bounded notification and consumer compatibility

| Changed rows | Published payload                                 |     Serialized |
| -----------: | ------------------------------------------------- | -------------: |
|            0 | none                                              |              — |
|        1–100 | `{ agentId, threadIds }`, the existing exact list | 3,964 B at 100 |
|         101+ | `{ agentId, threadIds: [], scope: "agent" }`      |           81 B |

100 is a **new explicit transport budget**, not an alleged provider hard limit.
The overflow payload is an explicit agent-scoped invalidation, never a silently
truncated list presented as complete, and it keeps the existing `threadIds` key.

Consumers were rechecked on this head and on the `0.887.0` minimum supported App
(`web-client-compatibility.json`, tag source `9ce19385`), which is unchanged by
this slice:

- `shared-database/worker-signals.ts` reloads **authoritative** chat indicators
  on every `chatThreadReadCursorUpdated` event before forwarding the payload and
  reloading computed state, identically in both revisions. Indicator correctness
  therefore does not depend on the id array.
- `signals/chat-thread-list-reload.ts` interprets only the single-thread
  `{ threadId, lastReadAt: null }` optimistic-mark clear and ignores bulk ids.
- `shared-database/protocol.ts` carries `payload: z.unknown()` inside a strict
  envelope, so additive `scope` metadata is preserved.

No current first-party consumer reads the bulk id array, so no compatibility
blocker was found and no client redesign or minimum-version change is needed.
This is **not** a claim that every historical or third-party client was verified.

## Concurrent native Morning Brief delivery

[#34826](https://github.com/vm0-ai/okou/issues/34826) /
[#34843](https://github.com/vm0-ai/okou/issues/34843) own a server-defined
native-delivery read watermark over the shared latest-unread-marker query this
route calls. This fence keeps the call shape it found on `main` and changes no
unread marker semantics; whichever slice merges second rebases onto the other
and keeps both.

## Residual work

This is a producer fence only. It erases no existing cursor, unread projection
or browser cache, and it does not complete B2, A2 or account erasure. Post-commit
realtime egress, read-response erasure and drain remain separate obligations,
and a closure may begin immediately after this commit. Still open in the parent
epic:

- Model selection, service tier, image and video model preferences.
- The generated/LLM title workflow, message create/send/edit/revoke, run and
  queue admission, and the sidebar snapshot projector.
- Historical cleanup, inventory and purge of already durable read state.
- Closure ingress, worker activation and any production erasure operation.
