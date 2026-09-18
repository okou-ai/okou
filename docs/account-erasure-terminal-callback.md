# Account erasure: terminal chat callbacks (B2b2-T)

Scope: [#34415](https://github.com/vm0-ai/okou/issues/34415) and its capture-recovery
repair [#34437](https://github.com/vm0-ai/okou/issues/34437), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This extends the accepted
[run-output boundary](account-erasure-run-output.md) using the existing dormant
[B1 barrier](account-erasure-foundation.md). It adds no migration, historical
scan, backfill, authority installation, deletion ingress or worker activation.

## Actual writer and caller inventory

All service paths below are under `turbo/apps/api/src/signals/services/`.

| Transaction entry                                                          | Actual callers                                                                                         | Atomic durable writes                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertAssistantErrorEvent` in `internal-chat-run-callback.service.ts`     | `handleFailedChatCallback` -> `prepareFailedTerminalChatCallbackWork` -> `processTerminalChatCallback` | Failed/cancelled lifecycle event, formatted error/failure reason, thread event sequence, up to six delivery callbacks, lastMessageAt, sidebar sort event and sidebar sequence   |
| `insertRunLifecycleMarker` in the same service                             | `handleCompletedChatCallback` -> `prepareCompletedTerminalChatCallbackWork` -> the same processor      | Completed/cancelled marker, optional integration completion fallback, the same coupled callback/thread/sidebar writes                                                           |
| `insertIntegrationCompletionFallback`                                      | Only the lifecycle transaction                                                                         | Deterministic `output.message` placeholder for Teams, Telegram, AgentPhone or GitHub without canonical output                                                                   |
| Six `insert*ChatDeliveryCallback` helpers                                  | Only the two transactions above                                                                        | Slack, Feishu, Teams, Telegram, AgentPhone and GitHub callback rows; exact source run/kind/optional callback ID selection, encrypted-secret copy, target and canonical event ID |
| `insertChatEvent`, `touchChatThreadLastMessageAt`, `appendChatThreadEvent` | Transitive calls inside those transactions                                                             | Event reservation/insertion, thread ordering and user/org sidebar stream reservation/insertion                                                                                  |

Plain and ccstate dispatch in `agent-run-callback.service.ts` both reach the
same terminal processor through `handleChatInternalCallbackWithoutCcstate` /
`handleChatInternalCallback$`. Public completion and cancel paths use that
shared dispatcher. Queue-first preparation failure calls the same processor
with the existing scheduler dependency removed to prevent recursive draining.
Progress callbacks remain outside this terminal slice. No subject lock was
added to the generic event, sidebar or run-metadata helpers.

## Ownership and commit contract

The loader checks run existence without reading content, then captures persisted
run/session/thread/resource ownership **before** reading prompt/error/thread
presentation metadata or formatting/history preparation. The same snapshot
reaches both the independent B2b2-O assistant writer and the terminal writer.
A transfer cannot attribute old prepared content to a new open owner. Snapshot
capture is not admission.

Each actual terminal transaction uses `withRunContentWrite`: READ COMMITTED,
1-second lock timeout, 5-second statement timeout, and at most three fresh
transactions for a proven ownership race. The order remains **all distinct B1
subjects -> resources -> thread -> run -> session**; the exact run row is the
common same-run mutex before callback writes. Locked ownership
and supplied snapshot/destination are checked before every admitted write; B1
locks remain held through COMMIT. Closed may precede supplied-identity mismatch,
and grants no write capability. Optional `users` rows and current compute leases
are not authorities. User and organization subjects remain distinct.

Error formatting, archived group/history reads, publication, canonical delivery,
queue drain, cleanup and deferred work remain outside these transactions.
Historical reads use the existing owner signal. Completed/failed/ordinary
cancelled runs do not need renewed compute admission for their terminal content.

## Projection and scheduler outcomes

| Outcome     | Projection and derived work                                                                                | Scheduler                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `written`   | Existing atomic writes, publication, canonical delivery and deferred work                                  | Existing drain before summary/followup/automation/push work                                 |
| `duplicate` | No new delivery or deferred invocation; existing open duplicate sequence behavior is preserved             | No redrive                                                                                  |
| `closed`    | No covered event, callback, lastMessageAt, sidebar, either sequence, terminal publication or deferred work | Existing owning callback resolves the current run/thread again and wakes the real scheduler |
| Failure     | Transaction rolls back; no conversion to closed or duplicate                                               | Load/capture/preparation recovery, cleanup and original-error rethrow                       |

After a closure denial, an indexed read checks whether a terminal marker was
already committed. Such a replay remains `duplicate`, including a retry after
closure. A denied projection with no marker retains its independent wakeup. This
read grants no write permission and database errors remain failures.

The outer callback ACK and source callback attempt/delivered bookkeeping still
precede background projection. They do not prove erasure or terminal admission.
The ccstate dispatcher supplies the real scheduler; the plain wrapper retains
its existing absence of that dependency. On closure, the current run/thread
mapping is reloaded and the scheduler independently reloads current thread
user/agent/candidates. Surviving work uses its own B2b1 admission. Closing one
member does not close an organization or authorize the old member's next run.

### Load and capture failure boundary

The preparation failure boundary starts with the first indexed, content-free
run lookup and includes ownership capture, metadata loading and preparation.
The early ACK does not transfer recovery ownership to the completion endpoint:
that endpoint already treats the source callback as delivered and skips its own
drain. A rejected capture must therefore reach the same callback owner's
recovery, before the existing outer background error handler. It cannot be
classified as closure, duplicate or success.

Only the persisted thread ID is retained before capture. Recovery probes the
existing per-run terminal marker to avoid redriving a duplicate, then reads the
current run mapping and verifies the destination thread still exists. A current
mapping takes precedence, including an explicit unmap or loss of chat trigger.
If the run disappeared, the previously persisted thread ID may still identify a
surviving queue that this ACK owns waking. An absent thread is never recreated.
The payload's thread/agent and the old ownership snapshot never authorize a
scheduler destination. The existing scheduler reloads thread/agent/candidates
and admits each candidate independently through B2b1.

No prompt, error, title, history or formatted content is carried in this recovery
locator, and no old content is re-pinned. A capture failure starts no content
writer or deferred publication/summary/followup/automation/push work. Slack status
cleanup retains its current idle check and persisted route binding; Feishu
reaction cleanup retains its current installation lookup. A non-abort drain
failure still reaches cleanup. Recovery is awaited by the existing callback
owner; a secondary recovery/cleanup error cannot replace the original failure.
Caller cancellation keeps its existing ownership and no detached retry is added.
The plain wrapper still has no scheduler dependency, and queued launch failure
still uses the existing dependency boundary that prevents recursive draining.

A vanished load result also accounts for the ACK-owned wakeup using this same
content-free resolution. This is finite lifecycle recovery, not a compatibility
reader, retained audit record, separate worker or new deletion authority.

## Verification and finite cost

The existing `compute-erasure-admission.service.test.ts` dormant-projector
exception covers real PostgreSQL, B1, actual callback writers and real APIs.
Normal run/thread/queued-input creation uses APIs. Synthetic ownership transfers,
closure projection, terminal-to-callback pauses, and backend lock/fault inspection
have no equivalent production test interface. No generic lint exemption is added.

Deferred gates and observed `pg_blocking_pids` establish both commit orders for
completed, failed and cancelled projections, output-to-terminal preparation gaps,
error-formatting ownership races, resource/session/run/thread transfers, deleted
threads, same-subject contention and independent-subject progress. Assertions
cover events, callback source secrets/targets/IDs, lastMessageAt, sidebar rows and
both sequences. The matrix includes all six integrations, four no-output
completion fallbacks, exact retries/collisions, distinct subjects, missing
optional users, real dispatcher scheduler admission/denial, and completion/cancel
usage settlement. Lock timeout, the actual five-second statement timeout, query cancellation,
connection loss and pre-ACK abort retain failure semantics. A unique synthetic
trigger performs bounded database work until the unchanged statement deadline;
a server notice proves the timeout cause and the transaction rolls back.
Existing public callback, integration and cancellation route suites cover open
behavior and protocol compatibility. Exact commands/results belong in the PR.

The capture regression enters through the real early-ACK dispatcher. A unique
schema visible only to the test worker shadows the session read with a real
PostgreSQL advisory-lock gate. Observed backend SQL proves it is the ownership
SELECT before preparation. The test queues removal of that view behind the
capturing backend, cancels that backend query with `pg_cancel_backend`, then
joins database healing and processing. There are no fixed sleeps, mocked B1
checks or dangling foreign keys. The same three completed/failed/cancelled cases
fail on the pre-repair implementation and pass after repair, with candidate runs
and queue events verified through real APIs. Additional cases cover surviving
threads after run removal, thread removal, unmapping with an unrelated payload,
closed candidates, duplicate no-redrive, plain callers, real Slack/Feishu cleanup
seams, cleanup failure and absence of history/provider/push/publication work.

Controller-provided read-only MaskDB observations at **2026-09-15
15:03:28.919–15:03:35.520 UTC** are non-atomic whole-table counts:

| Table                 |      Rows |
| --------------------- | --------: |
| `chat_events`         | 1,682,256 |
| `chat_threads`        |   157,944 |
| `chat_thread_events`  |    80,936 |
| `agent_runs`          |   284,174 |
| `agent_run_callbacks` |   302,220 |

These are not deletion-candidate counts. `chat_thread_event_sequences` and the
two `run_output_*` tables were not exposed; live metadata/counts remain unknown.
Ownership resolution is bounded to one run/session/thread, at most two agents
and the existing optional private memory resource, using existing indexes.
Source callbacks use run-ID/primary-key indexes; a projection inserts at most
six callbacks and bounded event/sidebar updates. The closed duplicate probe
uses the per-run event index. Load/capture recovery adds at most three indexed
reads (terminal marker, current run mapping, surviving thread) before invoking
the existing scheduler once; the plain wrapper performs no scheduler reads.
The successful path retains one initial run lookup and the same capture/writer
transactions and 1s/5s deadlines. Existing provenance/history preparation remains
outside admission and is not a new historical scan. Writers sharing any user
or organization subject serialize. Local lock observations establish ordering,
not production throughput or an isolated incremental latency measurement.

## Residuals and rollout

B2b2-R still owns summaries/followups/automation-result writers, notification/
LLM/provider/Ably egress, already-created delivery execution/status, terminal run
and checkpoint/active-input/runtime metadata, queued input/marker/admission-error/
title writers, generic sidebar/archive paths and final ingress wiring. The
durable chat search producer has its own fence in
[B2b2-R2](account-erasure-chat-search.md), which covers new projection writes
only.
The scheduler's active-input notification, user queue and workflow queue remain
independent families; this slice preserves their entry, not a universal fence.
Managed-browser idle-lease extension and Slack/Feishu status cleanup retain their
E/B2b2-R obligations and are not erasure completion.

Genuine usage, attribution, `creditAdmitted`, ledgers and cancellation recovery
are preserved. BYOK runs keep `creditAdmitted: false`; it is a built-in credit
admission flag, not the B1 content decision. Usage display events and financial
connector business payloads are not platform billing retention exceptions.

No public request/response or persisted shape changes. Old API versions still
lack this fence and must leave serving/rollback populations before activation;
old Runner/client producers and issued 48-hour URLs/multipart capabilities need
independent drain evidence. B2b2-R/D/E/G2, authority, billing independence,
domain/history/copy erasure and controller release/production acceptance remain
open. The implementation owner stops at its single PR's protected merge and
never uses the recovered September 12 account or performs production deletion.
