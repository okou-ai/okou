# Chat event split writes: two-release rollout

Release 1 expanded the schema, installed a legacy allocation bridge and shipped
both write modes behind the singleton `chat_event_write_control` row. Release 2
(the `contract_chat_event_sequence_bridge` migration) removes the legacy mode:
the API only writes through `chat_event_sequences`, the bridge trigger/function
and `chat_threads.last_chat_event_seq_id` are dropped, and no runtime path reads
the write mode. The control row and its irreversible activation trigger remain
the durable record used by the rollback resolver.

The contraction migration fails closed (SQLSTATE `55000`) unless the row is
activated. A database without any chat thread has no legacy allocation or
operation to drain and is activated by that migration; every other database,
including shared preview parents and local development databases with data,
must be activated with the control write below before it can migrate.

## Storage and consistency

`chat_event_sequences(chat_thread_id, last_seq_id)` is the allocation authority.
One statement reserves a range and inserts the corresponding events. Cross-thread
batches reserve in a deterministic thread order. Existing event-ID, run-event,
revocation, and terminal-marker uniqueness remains authoritative. An intentional
conflict can consume a sequence position; a SQL error rolls the statement back.
`chat_event_snapshots.last_seq_id` continues to mean archive coverage.

During the Release 1 deployment the `BEFORE UPDATE OF last_chat_event_seq_id`
bridge reserved from the new table and replaced the legacy update's returned
watermark. For
example, legacy 100 / canonical 110 plus one returns 111, including to an old API.
It is not a mirror. The bounded backfill copies the legacy watermark using
`GREATEST`; retained hot events cannot reconstruct archived positions or gaps.
Empty threads may have no sequence row until their first append.
Each backfill page acquires thread `KEY SHARE` locks before inserting sequence
rows, preserving the pre-release Web writer's thread-before-sequence order.

After activation:

- Event payload preparation and context persistence occur before the append.
  The per-message context row is the single authoritative source of required
  destination, identity and automation input. A failed context write rejects
  the input exactly as a failed event insert does on the pre-release path: it
  leaves no partial event, Slack/Feishu ingress keeps its existing retry
  classification, and channels that acknowledge before processing (Telegram,
  Teams, AgentPhone) accept a later duplicate delivery. Launch never
  reconstructs a destination from thread routes. Only optional ingress
  lookups (history and display names) may be omitted after activation; they
  emit structured warnings without prompt content.
- An acknowledged Web event survives draft, last-message timestamp, sort-event,
  and invalidation failures. Each weak side effect is awaited independently.
  Both existing draft copies are cleared; retained null rows remain, and a
  concurrently typed draft can be lost by explicit product choice. Timestamp
  writes and activity-sort replay are monotonic; explicit pin movement retains
  its independent semantics.
- Run output retains a short run-owned timeout arbitration boundary around its
  prepared event append. Materialization, memory citations, first-assistant
  metrics, thread touch, and channel delivery do not extend that boundary.
  Queue claim/revoke/discard and active-input settlement retain their necessary
  control transactions. Cancellation recovery still requires `run.cancelled`.
  Thread deletion preserves its strong FK attachment fence, orders run/sequence
  locks first, then waits for the thread row under the ordinary lock timeout;
  agent cascade deletion uses its existing conflict response when a child
  sequence is busy.
- Terminal-marker replay can repair missing channel callback registration.
  Delivery identity is derived from the original callback, channel and delivery
  event; historical random-ID registrations are recognized. The existing
  callback retry mechanism owns delivery recovery and retryable
  `chat-run-finished` automation admission; an already committed marker does not
  acknowledge unfinished completion work. An admission receipt on the existing
  source callback commits with each watched automation's queue event. This
  receipt survives hot-event archival, so a lost final callback acknowledgement
  cannot enqueue the automation again. Replay still attempts the guarded source
  and automation queue wakeups.
- Ordinary identity checks remain. Event/context/output writes no longer hold
  the broad erasure fence. Confirmed deletion can race a late write; the existing
  background-job cron collects those rows as described below.

There is no outbox or durable compensation queue for draft/timestamp/sort. A lost
weak side effect is an accepted observable outcome, not an event-write failure.

## Release 1, before activation

1. Apply the generated expansion, bridge, sequence backfill, and routing/cleanup
   preparation migrations through the normal release pipeline. Database migration
   precedes API promotion. Old binaries remain on the legacy entry point.
   Bounded procedures commit each page; online indexes are built concurrently.
   Interrupted migration attempts are safe to rerun through the migration runner.
   The preceding API's strict erasure catalogue rejects the expanded tables (or
   a newly captured collector version). Its durable Clerk deletion jobs retain
   their checkpoint/selectors and retry every 60 seconds without an attempt cap.
   This maintenance backlog is also expected during a preactivation rollback.
   Monitor pending age/failure count; after Release 1 resumes, confirm the backlog
   drains. Do not reset captures or delete these pending jobs.
2. Verify the bridge and control trigger/function inventory, migration frontier,
   index validity and backfill completeness. This query must return zero:

   ```sql
   SELECT count(*) AS incomplete_watermarks
   FROM chat_threads AS thread
   LEFT JOIN chat_event_sequences AS sequence ON sequence.chat_thread_id = thread.id
   WHERE thread.last_chat_event_seq_id > 0
     AND COALESCE(sequence.last_seq_id, 0) < thread.last_chat_event_seq_id;
   ```

   Confirm `SELECT activated_at FROM chat_event_write_control WHERE id = 'global'`
   returns exactly one null value. Do not derive a watermark from `MAX(chat_events)`.

3. Promote Release 1 and verify all API instances, cron workers, retries and
   in-flight readers using pre-Release-1 code have drained. Exercise native
   replies, Web sends, output, cancellation/queue admission and callback replay.
4. Record the actual serving release and supported rollback artifact. Expansion
   alone does not raise the chat-event rollback floor: preactivation rollback to
   a previously otherwise-compatible API remains valid.

## Separately authorized activation

Activation is a global operational step, not part of opening or merging this PR.

1. Briefly quiesce event-producing traffic and workers, including Web/native
   ingress, output/callback processing, cron and control operations. Drain **all**
   operations that entered legacy mode, including requests running Release 1 that
   already observed a null activation value. Draining only old binaries is not
   sufficient. The retained legacy send/draft protocol can hold a strong thread
   lock before allocation, whereas direct allocation reaches the sequence first.
   Do not introduce those mixed lock orders by flipping under active writers.
   Also finish pending/retrying source chat callbacks that entered legacy mode,
   including their deferred automation work. Legacy automation admissions do not
   carry the new callback-owned receipt; activation must not reinterpret their
   partially completed side effects as a fresh source obligation. Retained
   channel delivery callbacks still use their existing retry/deduplication path.
2. Repeat completeness/routing checks and verify a Release-1-compatible rollback
   target. Then perform this single authorized control write:

   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '1s';
   SET LOCAL statement_timeout = '10s';
   UPDATE chat_event_write_control
   SET activated_at = COALESCE(activated_at, timezone('UTC', now()))
   WHERE id = 'global'
   RETURNING activated_at;
   COMMIT;
   ```

   Exactly one row must be returned. Resume writers after commit. Late legacy
   allocator entry calls still obtain unique positions through the bridge; the
   drain is additionally required for the enclosing legacy operations' locks and
   side effects. No pre-Release-1 reader may serve after activation.

3. Verify new-mode allocation, all weak side-effect attempts, native destination
   correctness, output replay, queue recovery, periodic erasure and metrics.
   The activation trigger prevents reverting or deleting the active marker.
   The production rollback resolver reads this marker and refuses pre-Release-1
   API targets only after activation. Recover with a compatible artifact or a
   forward fix; never restore pre-Release-1 binaries or null the marker.

## Periodic late-content cleanup

The existing `/api/cron/process-background-jobs` schedule runs every minute in
`turbo/apps/api/vercel.json` and invokes this application cleanup. This change
creates no external schedule. The cleanup processes up to
five due confirmed subjects per invocation, at most 250 rows per affected table,
with a 15-minute next-sweep interval. Backlog can make the effective interval
longer. Each batch is repeatable; completed subjects never become permanently
exempt from later scans.

`chat_content_erasure_subjects` retains only a subject key, confirmed source
reference and maintenance timestamps. It is a deletion receipt, not admission
or access authority. Verified erasure completion and authenticated Clerk cleanup
populate it, projection retirement preserves it, migration seeds existing
terminal jobs, and bounded cron reconciliation catches old APIs completing jobs
during deployment. Cleanup requires a completed receipt, not a missing user row.
It covers events, native/automation context, attributed agent-run context,
sequence rows, thread-list events, materialization and memory citations. Existing
foreign keys and ordinary user/organization ownership paths remain in use.
Sequence cleanup waits until the thread has no remaining hot events.

Deletion jobs captured by the preceding durable-erasure release retain their
known relational collector version and captured provider obligations. They are
not recaptured after source deletion. New jobs use the expanded ownership plan;
the recurring cleaner removes late copied-provenance rows after either version
completes. Other collector-version changes remain rejected during replay.

Monitor `ChatContentErasureCleanup` warnings for collected late rows and errors
for failed batches, plus due-subject backlog/oldest `next_sweep_at`. The registry
must outlive local job retention and must not be purged with account content.

## Release 2

Release 2 ([#36696](https://github.com/okou-ai/okou/issues/36696)) may only be
promoted after production acceptance of the activated Release 1 and a verified
drain of every legacy-mode operation. Since migration precedes API promotion,
Release 1 remains a valid rollback target after contraction **only in its
verified, fixed active mode**; the rollback resolver requires a target that
contains the split writer. Never reactivate the compatibility branch.

### Compatibility inventory

| Behavior                                                                                                                                                                 | Release 2 outcome                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy branch of every `isSplitChatEventWriteEnabled` caller, `loadOptionalChatEnrichment`'s preactivation path and the `chat_event_sequence_bridge` migration's trigger | Removed. Activation is enforced by the contraction migration.                                                                                                                                                                                                                                           |
| Rollback resolver accepts an absent control table, then its activation read                                                                                              | Removed. Migration 1236 and the irreversible activation trigger guarantee the activated row.                                                                                                                                                                                                            |
| `ensureUserErasureJob` / `createRelationalErasureCollector` replay of the preceding captured collector                                                                   | Removed. Merge requires zero incomplete preceding-version captures.                                                                                                                                                                                                                                     |
| `insertChatDeliveryCallback` recognizes historical random-ID registrations, and cancel recovery replays an acknowledged callback whose `run.cancelled` marker is missing | Removed together. Split writes commit the marker before the callback is acknowledged, so only undelivered source callbacks are replayed. On 2026-09-25 no historical delivery row had a pending or failed source callback, and every cancelled run missing a hot marker belonged to an archived thread. |
| Source-thread reach for `chat_agent_run_context` rows with null `source_user_id`/`source_org_id`                                                                         | Retained. Pre-Release-1 writers kept writing unattributed rows after the `prepare_chat_event_routing_and_cleanup` backfill; a re-run backfill cannot attribute rows whose thread or agent no longer matches, so dropping the reach loses erasure obligations.                                           |

The following are permanent accepted data states:

- A missing sequence row means zero only for a new empty thread; the first
  allocator creates it atomically. Existing nonzero legacy watermarks are
  covered by the mandatory backfill. Retained event maxima are never a fallback.

## Verification and production measurements

The migration-consistency pipeline includes PostgreSQL acceptance for mixed
allocation, concurrent batches/replacement, first writes, gaps, rollback,
interrupted backfill/retry, retention, FK/control locks and contraction. Separate
suites inject real SQL failures into required context (the input is rejected
in both modes without a partial event, and a duplicate delivery is accepted) and into weak
draft/timestamp/sort/materialization side effects, exercise callback replay,
and collect late records after a local deletion job is gone. Activity replay has focused unit coverage.

Append telemetry reports statement duration plus database allocation/lock-wait
and insertion phases for returned rows. Empty-conflict appends still report
statement duration. Auxiliary writes have operation-specific timings and error
logs; slow appends/auxiliaries (250 ms) emit warnings. Compare p50/p95/p99 and Error
Ratio by phase and mode, together with PostgreSQL blocking/deadlock evidence.
Client/network time is not a database phase, and internal FK/index work remains.
This change does not establish that the previously observed 1.04-second INSERT
itself is fixed; production measurements must establish that separately.
