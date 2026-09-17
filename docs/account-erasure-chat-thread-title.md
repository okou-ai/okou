# Account erasure: generated chat titles (B2b2-R4)

Scope: [#34838](https://github.com/vm0-ai/okou/issues/34838), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the eager
generated chat-title workflow with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the admission helper
accepted for [direct draft and manual title writes](account-erasure-chat-thread-content.md)
and the asynchronous ownership-pin contract accepted for
[activity copies](account-erasure-run-activity.md). It installs no closure
decision, ingress, worker, schema, migration or production operation.

The accepted R3 contract names the generated/LLM title workflow as residual and
does not fence it. This slice closes that one residual producer.

## The covered writer

| Entry point                                                                                               | Writes                                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `scheduleChatThreadTitleGeneration` -> `waitUntil` -> title provider -> `persistGeneratedChatThreadTitle` | `chat_threads.title`/`updated_at`, one `renamed` sidebar event and its sequence |

Two production schedulers reach it: the inline web send route
(`chat-events.command.ts`) and the queued-claim drain
(`internal-chat-run-callback.service.ts`). Both go through the same service
function, so the fence sits in the service and neither caller changed. The
issue's inventory named only the first; the second exists at the audited commit
and is covered by construction.

Before this change the late persistence opened a bare transaction that updated
the title on `id`, `title IS NULL`, `renamed_at IS NULL` and
`agent_id IS NOT NULL` alone, then appended a title-bearing `renamed` event and
advanced the durable sidebar sequence — with no B1 admission, no canonical
parent lock, and no comparison against the identity the title was generated
for. The eligibility check that preceded generation read title and `renamed_at`
by thread id only, so it granted no closure or ownership authority at the point
the provider answered. The provider request routinely outlives the HTTP
response, so a closed account could still receive a new title and a new sidebar
event minutes after closure.

## The ownership pin

A generated title is content prepared for the account that owned the thread when
generation started. Resolving ownership only after the provider answers would
re-attribute that prepared content to whoever survives an ownership change, so
the workflow freezes a **content-free** pin at initiation:

```
{ chatThreadId, userId, agentId, agentOwner, orgId }
```

It carries no prompt, title or draft, which is what allows it to be resolved and
admitted before any account content is read. It is transient: it never reaches a
provider prompt, a public contract, telemetry or a persisted copy.

`agents.org_id` and `agents.owner` are `NOT NULL`, so a resolved Agent always
carries both; they are nullable in the resolved identity only because it
left-joins a nullable parent reference. The generated-title writer requires a
resolved Agent — unlike the legal null-Agent draft thread — so a thread whose
Agent does not resolve has no complete pin and keeps its existing omission.

Comparing the **whole** pin is load-bearing. An Agent owner transfer inside the
same organization moves `agentOwner` alone: a check that stopped at user and
organization would hand a title generated for the previous owner to the
survivor, and would also print the survivor's label on the sidebar event.

## Transaction order

### Initiation: bounded capture and admission

One bounded `READ COMMITTED` transaction, through a read-only sibling of the R3
helper:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution by primary key, left-joining Agents.
3. The scheduling caller's own contract: its `userId` and `orgId` must equal the
   real persisted parents, and the Agent must resolve.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. Title eligibility (`title IS NULL AND renamed_at IS NULL`) and the bounded
   prior-round context read.
6. The same content-free identity read again and compared field by field, then
   `COMMIT`.

A subject already known closed therefore never begins another title generation,
and the identity is fixed before any account content is read. The transaction
commits before the provider await: **no database transaction is held across the
provider request.**

This gate takes **no business lock**, and that is deliberate rather than an
omission. This workflow is scheduled from inside the request that holds the chat
queue's own `FOR UPDATE` on the same thread, which conflicts with `FOR KEY
SHARE`. A gate that took the parent locks would contend with the very request
that scheduled it and delay every eager title behind a bounded lock wait — long
enough for the next scheduler on that thread to still observe it untitled and
start a second, wasted provider call.

Taking no lock has a consequence that step 6 exists to bound. Admission and the
context read are both awaits, and under `READ COMMITTED` without a lock an owner
or organization transfer can commit during either one. The gate would then have
admitted one account's subjects and be holding another account's prior rounds —
and the completion's pin check, correct as it is, comes too late: it refuses the
database write, but it cannot recall context the workflow has already put into a
provider request. So the identity is read again after the context read and
compared to the one that was admitted; a mismatch discards the operation before
anything is generated.

That narrows the window to the gate's own transaction. It does not close it.
Ownership can still move between this `COMMIT` and the provider request, so the
pin this gate returns remains a **candidate, not a permission**: nothing is
written on its word, and every database guarantee is re-established at
completion, where the whole pin is compared again under retained locks before
any row changes. It is also not a fence around egress — see below.

This is a local initiation boundary only. It is not external-provider fencing
and it proves nothing about provider-side deletion.

### Completion: fresh admission under the frozen pin

The late persistence starts a **fresh** bounded `READ COMMITTED` transaction
through the full R3 write helper, with `authorize` comparing the entire frozen
pin. The order is: deadlines -> identity -> pin comparison -> B1 admission ->
`agents` KEY SHARE -> `chat_threads` KEY SHARE -> revalidation -> the title
`UPDATE`, the durable sidebar sequence and the `renamed` event, all in that one
transaction with every barrier retained through `COMMIT`.

Because `authorize` compares the pin rather than the current owner, a retry can
only ever re-admit the identity this title was generated for. A canonical parent
that moved is simply no longer authorized on the next attempt and the title is
discarded; the pin never rebinds to the survivor, on any attempt. The sidebar
`user_id`/`org_id` and the post-commit invalidation are built from that admitted
identity, after equality with the pin, not from the caller's captured labels.

The existing `title IS NULL AND renamed_at IS NULL AND agent_id IS NOT NULL`
CAS is preserved, so a concurrent manual rename still wins over a late
completion and two concurrent title completions still append exactly one
`renamed` event and consume exactly one sequence id.

## Background lifetime

The scheduler dispatches through `waitUntil` and has no request signal. The R3
helper requires one, and the request's own signal is the wrong source: the send
response is already delivered, so that signal would cancel a legitimate late
completion the moment the client disconnects.

Each fenced transaction instead carries its own `AbortSignal.timeout`, sized as
an outer bound (`30s`) on the helper's own budget of at most three attempts,
each statement capped at `5s` and each lock wait at `1s`. It is a real abort
source and a bound on this background work — not a never-aborting wrapper, and
not a cancellation channel this workflow claims to support. It does not fence
the provider request, whose existing optional-generation semantics, telemetry
and failure classification are unchanged.

These are three different mechanisms and the tests check them separately:

| Mechanism                   | What it bounds                                      | How it is verified                                                                                                      |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `lock_timeout` `1s`         | How long one statement waits for a conflicting lock | Observed on the paused transaction, then a held parent row lock makes the writer block and give up on it                |
| `statement_timeout` `5s`    | How long one statement may run                      | Observed on the paused transaction                                                                                      |
| `AbortSignal.timeout` `30s` | How long the retry loop may keep starting attempts  | Exercised at its cooperative boundary: an already-aborted fence reaching the completion stops it before the first write |

They do not compose into an aggregate transaction deadline: the two server budgets
apply per statement, and the signal is only read where the workflow chooses to
read it — between attempts and around the transaction. It stops the workflow
from beginning further work and does **not** cancel a statement PostgreSQL is
already executing; only `statement_timeout` and `lock_timeout` do that, server
side. There is therefore no claim that a title transaction is hard-cancelled at
`30s`, and none that the background workflow is cancellable by a caller: it owns
no request-cancellation contract and no such endpoint exists for it.

The deadline case reaches this boundary through the API suite's existing
`AbortSignal.timeout` seam, armed only after the initiation gate has committed
so it applies to the completion fence alone, and it asserts that the production
`30s` value is the one actually requested. Production budgets are unchanged.

## Failure contract

| Outcome                                     | Disposition                                                     |
| ------------------------------------------- | --------------------------------------------------------------- |
| B1 subject closure                          | Discarded: no title, timestamp, event, sequence or invalidation |
| Thread missing, moved or no longer eligible | Discarded, with nothing recreated or upserted                   |
| Identity moved under the locks              | Roll back and reselect, at most three attempts                  |
| Attempts exhausted                          | Discarded as an ownership change, not reported as erasure       |
| Lock wait, statement timeout, abort         | The workflow's existing failure handling, unchanged             |

Closure-first means no title, timestamp, event, sequence or invalidation.
Writer-first means an admitted completion commits one coherent title and event,
and the closure waits behind the retained barrier instead of racing it.

This asynchronous optional workflow does not manufacture the manual route's
`404`: the originating send has already succeeded and no title is owed. Closure,
a missing thread and an ownership change are therefore safe discarded results,
while a real timeout, blocked parent lock, cancellation or database error keeps
the workflow's existing failure handling and is never laundered into a
fabricated erasure success.

## Egress is not covered

A provider request already in flight can still complete, and the provider keeps
whatever copy it already received. This fence discards the **new database copy**;
it cannot recall that pre-existing egress. Provider erasure and drain remain B2
and G2 obligations. The prompt truncation, the at most ten visible prior rounds
and the existing auxiliary telemetry are unchanged: no prompt, title or owner
copy was added, and no new retention exception was created.

## Verified behavior

`chat-thread-title-erasure.test.ts` drives the production send route and the
production terminal-callback drain against real PostgreSQL with the title
provider response held open, and reuses the accepted closure, owner-transfer,
row-lock, held-event and transaction-barrier fixtures. **Eighteen cases**, all
passing locally:

| Case                                                                                       | What it establishes                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closure of the thread user, of a distinct Agent owner, of the Agent organization (3 cases) | Each subject independently discards the late title: no title, no `renamed` event, no consumed sequence, and the provider request counted exactly once                                               |
| A distinct Agent owner that stays open                                                     | Control for the case above: same shape, unrelated subject closed, and the title **is** written                                                                                                      |
| Closure committed before admission                                                         | The gate refuses to start generation: **zero** provider requests for that thread                                                                                                                    |
| Owner moves while the gate reads context                                                   | The gate's fresh pin check discards before generation: **zero** provider requests                                                                                                                   |
| Writer-first commit ordering                                                               | The admitted completion commits one coherent title, event and sequence; the closure is a real blocked PostgreSQL waiter behind it; an unrelated owner writes through; the next write is then fenced |
| Owner moves between identity selection and the retained locks                              | Discarded, not rebound to the survivor                                                                                                                                                              |
| Blocked parent row lock **before** the first write                                         | The writer blocks on `FOR KEY SHARE`, then gives up on its own `1s` budget; nothing written, nothing consumed, and the next accepted rename still takes the very next sequence id                   |
| Late write that fails **after** the title UPDATE and the sequence reservation              | The whole transaction rolls back: title, `renamed_at`, `updated_at`, the sidebar event and the reserved sequence id                                                                                 |
| Commit ordering of the sidebar invalidation                                                | None published while the written transaction is paused before `COMMIT`; exactly one afterwards, on the admitted owner's own channel                                                                 |
| Two overlapping in-flight generations from the two real schedulers                         | Both provider requests counted and held together; exactly one title, one `renamed` event and one invalidation result                                                                                |
| The fence deadline reaching the completion                                                 | The workflow stops at its cooperative boundary before the first write; nothing written, published or consumed                                                                                       |
| Same-organization Agent owner transfer                                                     | `agents.owner` alone moving is caught                                                                                                                                                               |
| Agent organization transfer                                                                | Caught                                                                                                                                                                                              |
| Thread deleted during the provider request                                                 | Nothing recreated                                                                                                                                                                                   |
| Manual rename during the provider request                                                  | The manual title wins                                                                                                                                                                               |
| A further send once the thread is titled                                                   | Eligibility refuses it: the provider request count stays at **one** and exactly one `renamed` event exists                                                                                          |

Two details worth stating exactly, because both were previously asserted loosely:

- Provider entry is **counted**, per owner prompt, not inferred from the number
  of sends. A case that claims generation did not start asserts zero; a case
  that claims it ran and was refused only at persistence asserts one.
- The distinct-Agent-owner closure case is attributable. The Agent owner is
  moved **before** the thread exists, so the pin already names that owner and
  the identity never changes; a pin mismatch therefore cannot discard the title
  on its own. Removing the Agent owner from the admitted subject set was run as
  a mutation probe: that case fails and its open-owner control still passes.

Three more details, each of which replaces an earlier claim that its evidence
did not support:

- **A genuine pair of concurrent in-flight generations is reachable**, and is
  now exercised. A second send while the first run is active does become a
  queued message and the send route schedules nothing for it — but the terminal
  callback then claims that message, creates its run and calls
  `scheduleChatThreadTitleGeneration` itself, independently of whether the
  earlier provider request has answered. The case holds the first request open,
  finishes the first run through the production completion webhook, waits until
  **two** requests are counted inside the held handler, and releases both
  together: one title, one `renamed` event and one invalidation result. The
  earlier statement that this pair was unreachable was wrong; the eligibility
  CAS it relied on is sound and unchanged.
- **Rollback of an already-executed late write is exercised directly.** The
  pre-write lock case fails on `FOR KEY SHARE`, before the title UPDATE, so it
  proves refusal on a lock budget and nothing about rollback. The new case holds
  the next `(user_id, org_id, seq_id)` slot instead, which the writer's _last_
  statement collides with — after the title UPDATE and after the durable
  sequence reservation — so the failure happens with both writes executed and
  `COMMIT` never sent. That distinguishes a failing final statement from a
  failing `COMMIT`; the latter is not claimed here. Every baseline, including
  `updated_at` and the sequence, is captured before the attempt rather than read
  back afterwards.
- **Outbound invalidation is observed, not inferred.** Cases assert the
  `threadListChanged` publishes routed to the admitted owner's own
  `user-org:<userId>:<orgId>` channel, paired from the Ably client mock's
  channel and publish spies. Closure, a moved identity, a rolled back write and
  a paused pre-`COMMIT` transaction publish none; a committed title publishes
  exactly one. The send itself publishes other topics on that same channel, so
  both the channel and the topic are filtered and each case compares against a
  baseline it took after the send had answered.

Because no chat-thread read contract returns `chat_threads.updated_at` — the
metadata response omits it and the snapshot projection that carries it is served
from a compacted row this workflow never produces — the timestamp assertions use
a read-only fixture. It writes nothing, and it is a narrower exception than
adding a timestamp endpoint for a test.

The title fence's own cancellation coverage is the deadline case above.
`auxiliary-generation.test.ts` cancellation covers `saveRunSummaryRequest` and
is **not** coverage of this fence.

## Measured cost

Local development PostgreSQL, real HTTP boundary, same harness for both builds:
20 sequential sends on 20 threads, each drained to its persisted title, three
samples each. Candidate is `ccaca7482432147bd5e61f7c66fabd2cf91407bf`; baseline
is that revision with `chat-title.service.ts` and
`chat-thread-content-erasure-admission.service.ts` restored to
`aad63fff96aa14413a97b952093fc897f7962804`, the `main` commit immediately before
it.

| Build     | Samples (ms)       |  Median | Per send |
| --------- | ------------------ | ------: | -------: |
| Baseline  | 2127 / 2099 / 2150 | 2127 ms |  ~106 ms |
| Candidate | 2093 / 2162 / 2173 | 2162 ms |  ~108 ms |

These are **raw observations from three samples per build on one developer
machine, and nothing more**. The two ranges overlap — the candidate's fastest
sample is below the baseline's median — so they neither resolve the added cost
nor bound it, at a couple of milliseconds per send or at any other figure. They
are recorded because they are the measurement that was taken, not because they
support an upper bound, and they say nothing about production throughput.

The gate's identity read and its revalidating re-read share one plan, measured
here against a **real** thread row whose Agent resolves, so the join is actually
exercised rather than short-circuited by an empty outer side:

```
Limit (actual time=0.027..0.028 rows=1.00 loops=1)
  Buffers: shared hit=4
  ->  Nested Loop Left Join (actual time=0.026..0.027 rows=1.00 loops=1)
        ->  Index Scan using chat_threads_pkey on chat_threads
              Index Cond: (id = $1)
        ->  Index Scan using agents_pkey on agents
              Index Cond: (id = chat_threads.agent_id)
```

The writer's `FOR KEY SHARE` locks keep the plans the accepted R3 measurement
recorded for the same two statements.

### What the fence actually adds

Per eager title, replacing one standalone eligibility `SELECT` with two bounded
transactions:

| Transaction               | Statements                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initiation gate (all new) | `BEGIN`, two `set_config`, identity read, B1 isolation probe, one `pg_advisory_xact_lock_shared` per distinct subject, B1 closure lookup, eligibility read, prior-round context read, identity re-read, `COMMIT` |
| Completion (new prologue) | two `set_config`, identity read, B1 isolation probe, the same advisory locks, B1 closure lookup, `agents` `FOR KEY SHARE`, `chat_threads` `FOR KEY SHARE`, identity re-read                                      |
| Completion (pre-existing) | title `UPDATE ... RETURNING`, sequence `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, `renamed` `INSERT ... ON CONFLICT DO NOTHING`, `COMMIT`                                                                 |

There are two or three distinct subjects — thread user, Agent organization, and
the Agent owner when it differs from the thread user — so B1 issues that many
advisory-lock round trips in each transaction.

Not all of this is primary-key work, and the earlier claim that it was should be
read as withdrawn. The advisory locks are function calls that take no snapshot
and scan nothing but can **wait**; the isolation probe reads a `VALUES` row; the
closure lookup filters `jobs` over the subject domains rather than by primary
key; and the two `FOR KEY SHARE` selects are primary-key scans that additionally
take row locks. Only the identity reads, the eligibility read and the title
`UPDATE` are plain single-row primary-key work.

## Residual work

This is a producer fence only. It erases no existing title, sidebar event or
snapshot, and it does not complete B2, A2 or account erasure. Still open:

- Shared and public snapshot titles, and the sidebar snapshot projector.
- Create, send, edit and revoke message flows, and pin/read/model/browser
  thread metadata.
- Provider egress closure and drain, and the remaining `appendChatThreadEvent`
  producers outside this workflow.
- Historical cleanup, inventory and purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
