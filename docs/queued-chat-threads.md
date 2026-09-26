# Queued chat threads: no queued runs for chat threads

Status: draft for review
Source snapshot: `okou-ai/okou` main `b3119bb78e8523e6ce5dab33a541e4b5851aff81` (2026-09-26, after #36914 and #36929)
Related: #36929 (active_agent_runs thread slot, merged), `docs/deployment-compatibility.md` (active_agent_runs steps), `docs/advisory-locks.md` (advisory lock retirement)

Line references point at the source snapshot and may drift.

## Problem

When an org is at its concurrency limit, every chat-thread launch becomes a
`queued` run:

- `createQueueFirstAgentRun$` always sets `queueOnConcurrencyLimit: true`
  (`agent-runs-create.service.ts:1139`). All production chat entry points go
  through it: web send, queued-message auto-send, and workflow automation launch.
- At capacity, the launch transaction still claims the queue-first association,
  so the user message is bound to the new run. It then inserts
  `agent_runs(status='queued')` and an `agent_run_queue` row
  (`agent-run-create.service.ts:9192-9253`, `commitQueuedPreparedLaunch`).
- The queue row holds a fully prepared, encrypted runner job payload
  (`agent-run-queue-payload.service.ts`). That payload includes
  `resumeSession`, `reuseKey`, the Pi session and launch config, `sandboxToken`,
  `encryptedSecrets`, firewalls and network policies, and feature flags
  evaluated at creation time. Promotion (`run-queue.service.ts:395-440`)
  dispatches this payload unchanged.

Three problems follow from that:

1. **The context is bound too early.** A queued run already fixed the session
   it continues from. A queued run must therefore keep the thread busy, or a
   later run would fork from the same snapshot. The thread-busy check has
   counted `queued` since #12253 (`chat-active-run.service.ts:26`).
2. **`active_agent_runs` has to carry queued rows.** `finishAdmittedLaunch`
   inserts a row for both `pending` and `queued` launches. As a result:
   - every capacity reader joins `agent_runs` to exclude queued rows
     (`sandboxCapacityPredicate`);
   - promotion has to reset `lastHeartbeatAt`;
   - the stale-terminal sweep has to order around long-queued rows that never
     heartbeat (`run-activity.service.ts:104`).
     None of the table's mutable columns (heartbeat, activity, summary, claim)
     mean anything for a queued run.
3. **Secrets sit in the queue.** `agent_run_queue` was introduced in #3764 with
   the promise "secrets never persist long-term". Since #13076 it stores
   resolved credentials for as long as a run waits.

### Why the payload is prepared at queue time

The queue introduced in #3764 (2026-03-06) stored only the caller's
`CreateRunParams`. `executeQueuedRun` rebuilt the context at dequeue.

During the web → API migration, #12582 (2026-05-10) ported only an SQL-only
drain; dispatch was deferred as "~600 LOC of transitive infrastructure".
#13076 (2026-05-13) then stored the prepared payload so the API drain could
insert `runner_job_queue` directly. Nothing in either PR discusses the
session-binding semantics. The approach was a migration expedient.

Rebuilding at promotion is not a practical fix. `CreateAgentRunArgs` carries
closures (`piStableContext`, `bindClaimedQueueFirstRun`,
`validatePiMemoryPhase2Admission`, `dispatchFailedCallbacks`) and request-time
resolutions (`capturedPersonalSubscriptionAccount`, `threadSessionResolution`,
`productAgentExecutionPlan`, connector scope). Rebuilding them would mean
replaying the whole product launch in the drain path.

## Decision

A chat thread never gets a `queued` run. At capacity, the launch creates
nothing, and the message or automation event stays in the chat thread's own
queue, which already exists (#12253). When a slot frees, the thread queue is
drained through the normal launch path, so the new run reads the latest
session.

Resulting invariants:

- A run in a chat thread is only ever `pending`, `running` or terminal.
- `active_agent_runs` holds only runs that occupy or may occupy a runner:
  pending, running, and started runs until completion. The per-thread slot
  (#36929) then means "one pending or running run per thread", with no queued
  special case.
- `pi-memory-phase2` (the only other `queueOnConcurrencyLimit` caller, and
  threadless) no longer takes part in the concurrency limit. It launches
  directly and is never queued.
- With no producer left, the `queued` status, `agent_run_queue`, the prepared
  payload and `drainOrgQueue$` promotion are removed once legacy queued runs
  have drained.

## Design

### 1. `queued_chat_threads`: one row per thread with queued messages

```
queued_chat_threads
  chat_thread_id   uuid primary key   -- one row per thread, however many messages
  org_id           text not null
  queued_at        timestamp not null -- when the thread started having a queue
  claim_id         uuid               -- pick lease, unindexed
  claim_expires_at timestamp          -- unindexed
  index (org_id, queued_at)
```

- **What a row means.** The thread has queued input, whatever the reason: the
  thread is busy, or the org is full. The table holds no message content or
  payload.
- **Where the content comes from.** When a thread is picked, its concrete
  queue head is read from `chat_events` by `chat_thread_id`: the oldest pending
  `input.prompt` with `runId = NULL`, or an automation event. Only the hot
  `chat_events` table is read, never the snapshot/archive.
- **Bounded length.** Hot retention (`CHAT_EVENT_RETENTION_DAYS = 30`) is the
  queue length limit: queued input that has aged out of the hot table is not
  picked. There is no limit on the number of queued threads per org.
- **Written** with `INSERT … ON CONFLICT DO NOTHING` whenever input enters a
  thread's chat queue.
- **Deleted** by the picker once the thread has no pickable queued input left.
- **Scope.** The table serves the org concurrency limit and cross-thread
  scheduling. "One run per thread" stays with the queue-first head check and
  the `active_agent_runs` thread slot (#36929).

### 2. When a queued thread is picked

**Ingress (new message or automation event)**

1. Append the input to the chat queue as today, and upsert the thread's row.
2. If the thread has no active run, do a lock-free count of the org's active
   runs. If a slot is free, pick this thread (below). Otherwise stop: the row
   waits.

**A run ends** (completion, cancel, timeout, claim failure; after its
`active_agent_runs` row is released)

1. **Same thread first.** If the finished run's thread has a row, pick it. It
   takes over the slot the run just freed, so no count is needed.
2. **Otherwise the org.** Pick the oldest pickable row in the org. The pick
   checks capacity itself.

**The org's concurrency limit changes** (Stripe purchase, plan change)

- Loop: count, and if below the limit, pick the oldest pickable row in the
  org. Stop when the limit is reached or no row is pickable.

**Cron sweep**

- Scan `queued_chat_threads` for rows with no live lease (bounded, oldest
  first). For each row: claim it, then check whether the thread is idle and
  the org has a free slot. If so, launch; otherwise release the lease.
- This replaces the queue half of `drainStaleChatThreadQueues$`, which today
  scans `chat_events` by time window. Its cancellation-recovery half is
  separate and stays.

**Pick(thread)**

1. **Lease with CAS:**
   `UPDATE queued_chat_threads SET claim_id = ?, claim_expires_at = now() + 1 min
WHERE chat_thread_id = ? AND (claim_expires_at IS NULL OR claim_expires_at <= now())`.
   Zero rows means someone else holds it; move on.
2. **Check admission.** The thread must have no active run. Unless the caller
   is handing over the slot of a run that just ended in the same thread, the
   org must also be below its limit (lock-free count). If either check fails,
   release the lease and stop.
3. **Read the head** from hot `chat_events`. If there is none, delete the row
   `WHERE claim_id = ?` and stop.
4. **Launch the head** through the normal queue-first launch. The claim writes
   the replacement `input.prompt` with `runId` and `revokesEventId`. The run
   reads the thread's latest session, and `active_agent_runs` is the last
   insert.
5. **Settle the lease:**
   - More queued input remains: clear the lease (`WHERE claim_id = ?`). The
     thread is now busy; its next pick happens when this run ends.
   - Nothing remains: delete the row (`WHERE claim_id = ?`).

"Oldest pickable row in the org" means rows of the org ordered by
`queued_at` whose lease is free or expired and whose thread has no active run
(checked against the `active_agent_runs` thread slot). These are bounded
reads outside any transaction.

**Failure handling.** If a picker dies, for example because a deploy stops the
instance, its row stays. After the one-minute lease expires, any later pick
takes the row again. Nothing is deleted before the launch commits, so a queued
thread cannot be lost.

**No lock for capacity.** The capacity check is the coarse, lock-free count
that ordinary launches already use on main (`enterFinalLaunchAdmission`).
Overshoot under concurrent picks is accepted (soft limit). The only advisory
lock a pick can take is the official-workflow fence (see Lock changes).

**Caller mapping.** A launch that is not performed because the org is full
leaves the input queued and the row in place:

- web send returns 201 with `runId: null`;
- auto-send returns "not launched";
- workflow automation returns `enqueued`.

`queueOnConcurrencyLimit` is no longer used by chat launches.

### 3. `active_agent_runs` holds no queued rows

- `finishAdmittedLaunch` inserts only for `pending`.
  `requestPiMemoryStage1Day` still runs for both outcomes.
- Queue promotion (`promoteAdmittedQueuedRun`, `run-queue.service.ts:419`)
  replaces its `UPDATE … lastHeartbeatAt` with
  `INSERT … ON CONFLICT (run_id) DO UPDATE SET last_heartbeat_at`.
  - The conflict handler is needed for rows written by migrations `1250`/`1258`
    and by older API instances.
  - The insert moves to be the transaction's **last statement**, after the
    queue delete, marker revoke and `insertPromotedRunnerJob`. That keeps the
    ordering rule the thread slot depends on.
  - Promoted runs are threadless after this change, so the `chat_thread_id`
    slot cannot conflict. Legacy queued chat runs promoted during the rollout
    already own their row, and hit the `run_id` conflict path.
- After cleanup, simplify:
  - `releaseStaleTerminalActiveAgentRuns$`: drop the queued-crowding ordering
    and comment;
  - the schema docstring (`active-agent-run.ts:14-21`);
  - `docs/chat-thread-activity-summary.md`;
  - `docs/deployment-compatibility.md`.
- `sandboxCapacityPredicate` still needs the `agent_runs` join for the pending
  TTL. Only the queued exclusion becomes redundant. A plain
  `count(*) WHERE org_id` is a possible follow-up, but it is not part of this
  change.

### 4. User-visible state: unchanged

The server ack for a queued message has no `runId`. A non-optimistic
`input.prompt` without a `runId` is already rendered as a queued message
(`chat-event-state.ts:100` → `pending`). When the waiter is promoted, the
existing queue-first claim writes the replacement `input.prompt` with `runId`
and `revokesEventId` (`replaceLoadedChatEvent`, `chat-event.service.ts:1192`).
The web therefore shows capacity waits exactly like messages queued behind a
running run. No new chat event, marker or indicator mode is needed.

Server-side adjustments only:

- Stop emitting `run.queued` / `run.dequeued` for chat runs. Readers keep
  parsing historical events.
- Feishu sends its queued card only when `run.status = 'queued'`
  (`canonical-feishu-ingress-processor.service.ts:520`). Switch it to the
  "pending message" condition that Telegram, Teams and AgentPhone already use.
- Small follow-ups, not required for correctness:
  - the web "Waiting in queue…" drawer link disappears;
  - the sidebar and Discord typing are run-based and show the thread idle
    while it waits;
  - `GET /api/runs/queue` no longer lists chat waiters.

### 5. Cancel, stop and recall

- **Web stop** already sends `revoke` for every queued `input.prompt`
  (`create-chat-thread.ts:3589-3643`), and it interrupts only live runs.
  - A capacity waiter has no run, so stop just recalls the messages.
  - The thread's row is deleted by the next pick, which finds no head.
- **`cancelRun$` for `queued`** stays, for threadless runs and for legacy
  chat runs during the rollout.

## Lock changes

Main has already removed the capacity locks from ordinary launches:

- final admission takes `hashtext(orgId)` only for official-workflow runs
  (`enterFinalLaunchAdmission`, `agent-run-create.service.ts:9340`);
- the preflight is a plain read (`:8515`);
- promotion uses a coarse count plus a `status = 'queued'` CAS;
- #36929 replaced the `chat_threads` row locks in launch with the unique
  `active_agent_runs.chat_thread_id` insert.

What this proposal removes on top of that:

| Lock                                                               | Where                                      | Why it goes                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Promotion run lock `agent_runs FOR UPDATE` + `status='queued'` CAS | `run-queue.service.ts:482-492`             | No promotion (Release D)                                                                                                                              |
| Plan row `FOR UPDATE` at promotion                                 | `run-queue.service.ts:526-531`             | Picks use the normal launch; `creditAdmitted` is decided there (Release D)                                                                            |
| `credit_<orgId>` advisory lock at promotion                        | `run-queue.service.ts:534`                 | Same (Release D)                                                                                                                                      |
| Queue expiry and orphan cleanup `agent_runs FOR UPDATE`            | `run-queue.service.ts:740-745`, `:857-862` | No queued runs (Release D)                                                                                                                            |
| Queued-run marker `agent_runs FOR UPDATE`                          | `chat-queue-marker.service.ts:36-43`       | No markers for chat runs (B), revocation gone in D                                                                                                    |
| `chat_event_queue:<threadId>` lock on the workflow head read       | `workflow-chat-event-queue.service.ts:326` | The picker's lease owns the thread; the claim is already exclusive via the revoke edge. The admission use at `:233` (schedule-tick coalescing) stays. |
| Time-window scan of `chat_events` for missed queues                | `drainStaleChatThreadQueues$`              | Replaced by the `queued_chat_threads` sweep (not a lock, but the same kind of coordination)                                                           |
| `queue-payload-required` second commit invocation                  | `agent-run-create.service.ts`              | No prepared payload, so no retry of the commit to attach one                                                                                          |

What stays, and why:

- **`hashtext(orgId)` on official-workflow runs.** It is the lock-order fence
  against official reconciliation (org lock → plan row → workflow rows versus
  admission's workflow rows → plan row). A pick that launches an
  official-workflow automation event still takes it. It is per official run,
  not per path.
- **Plan row `FOR UPDATE` in launch** (`:8476-8482`), for `creditAdmitted`.
- **Queue-first head `FOR UPDATE OF chat_events`**
  (`chat-queued-event.service.ts:566`, `:616`), since picks launch through
  it. Note that the picker's head read must also exclude open active-input
  deliveries.
- **The thread slot unique insert** (`:9322-9336`), which becomes the only
  per-thread admission.
- **Unrelated locks stay:** session snapshot, cancel, timeout cron, runner
  claim, MCP submission, active-input delivery, pi-memory job and credential
  locks, and thread deletion.

Stale comments to fix alongside:

- `agent-run-create.service.ts:5903`
- `chat-thread-queue-drain.service.ts:112`
- `mcp-chat-cancellation.service.ts:57`
- dead `lockChatQueueThread` (`chat-event-queue.service.ts:362`)

## Rollout

The pattern follows `docs/deployment-compatibility.md`: each step ships alone,
the previous API drains, and the rollback floor is raised.

1. **Release A — promotion writes the active row.**
   - Promotion upserts the `active_agent_runs` row as its last statement.
   - Launch is unchanged.
   - The migration adds `queued_chat_threads`, and the drain hooks read
     it; nothing writes it yet.
   - Why this has to come first: if a new launch skipped the queued row while
     an old API still promoted by `UPDATE`, the promoted run would have no
     active row. It would then be invisible to capacity, heartbeats and the
     timeout cron.
2. **Release B — chat launches no longer create queued runs.**
   - Admission leaves input queued when the org is full, `queued_chat_threads` is written and picked, and the
     marker and integration changes ship.
   - `finishAdmittedLaunch` inserts only for `pending`.
   - Old queued chat runs still drain through `agent_run_queue`, and A's
     upsert tolerates their rows.
   - `pi-memory-phase2` stops using `queueOnConcurrencyLimit` and skips the
     concurrency check.
3. **Release C — cleanup, after B is live and A has drained.**
   - Migration:
     `DELETE FROM active_agent_runs a USING agent_runs r WHERE r.id = a.run_id AND r.status = 'queued'`.
   - An optional `1258`-style backfill for pending or running runs without a
     row.
   - Simplify the sweep, and update docs and the schema comment.
   - Raise the rollback floor to B.
4. **Release D — remove the run queue, once no `queued` runs remain.**
   - Remove `agent_run_queue`, the prepared payload
     (`agent-run-queue-payload.service.ts`), `drainOrgQueue$` promotion, and
     the `queued` handling in cancel and cleanup.
   - `run.queued` / `run.dequeued` stay readable for historical events.

#36929 (merged) stays valid: after B, queued chat rows stop appearing, and
promoted rows are threadless, so a promotion never conflicts on the
`chat_thread_id` slot.

## Tests to update

- `chat-callbacks.bdd.test.ts:2292`: "marks an auto-sent follow-up when org
  concurrency queues the new run". Change it to: the message stays queued, a
  `queued_chat_threads` row is written, and freeing a slot launches it.
- `chat-activity-summary.test.ts:1075-1096`: a queued run has an active row.
  Change it to assert that the row is absent.
- `test-cron-cleanup-sandboxes-state.ts:226-236`: the fixture inserts active
  rows for `queued`. Drop `queued`.
- `workflow-queue.test.ts:1198`, `:1239`: queued workflow successor at the
  limit. Change them to: the event stays enqueued, then launches on slot
  release.
- `integrations-telegram-post.test.ts:3571` and the Teams, AgentPhone and
  Feishu queued-notice tests: they should now be driven by a queued message with no run.
- New tests:
  - two messages in one thread at capacity produce a single run, launched
    after the slot frees, that sees the latest session;
  - run end prefers the same thread's queue over older threads in the org;
  - a concurrency increase picks threads in a loop until the limit is reached;
  - a picker dies mid-launch: the row is picked again after the lease expires;
  - queued input that has aged out of hot `chat_events` is not picked;
  - pi-memory launches while the org is full;
  - the cron sweep claims a row, finds the org full, and releases the lease;
  - recall while waiting;
  - a row whose thread has no pickable head is deleted.

## Decisions

- pi-memory runs keep counting toward org capacity: they occupy real
  sandboxes. They are just never limited or queued.
- Queue length is bounded by hot `chat_events` retention (30 days); there is
  no per-org limit on queued threads.
