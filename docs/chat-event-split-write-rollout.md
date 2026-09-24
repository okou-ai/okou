# Chat event split writes: two-release rollout

This preparation release expands the schema and installs a legacy allocation
bridge. It does **not** activate split writes. The only switch is the singleton
`chat_event_write_control` row: `activated_at IS NULL` means legacy mode. No
per-user override, cache, or environment default may activate it.
The bridge migration seeds that row before API promotion. An absent singleton
is an invariant failure, not legacy mode. The rollback workflow alone accepts an
absent control **table**, because workflow code on main can run before the
expansion has been released; a present table with no singleton still fails.

## Storage and consistency

`chat_event_sequences(chat_thread_id, last_seq_id)` is the allocation authority.
One statement reserves a range and inserts the corresponding events. Cross-thread
batches reserve in a deterministic thread order. Existing event-ID, run-event,
revocation, and terminal-marker uniqueness remains authoritative. An intentional
conflict can consume a sequence position; a SQL error rolls the statement back.
`chat_event_snapshots.last_seq_id` continues to mean archive coverage.

During deployment the `BEFORE UPDATE OF last_chat_event_seq_id` bridge reserves
from the new table and replaces the legacy update's returned watermark. For
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
  the input exactly as a failed event insert does, so the channel's normal
  redelivery retries it; no event is appended without its context and launch
  never reconstructs a destination from thread routes. Only optional ingress
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
  locks first and uses bounded NOWAIT control retries; agent cascade deletion
  uses its existing conflict response when a child sequence is busy.
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

## Release 2 boundary

Only after production acceptance and a verified legacy-entry drain may a separate
cleanup PR remove legacy code, the allocation bridge/function and
`chat_threads.last_chat_event_seq_id`. Keep the irreversible active control row
and its rollback protection. The preparation API's runtime table mapping omits
the legacy column from implicit INSERT/SELECT/RETURNING lists, and acceptance
runs its direct writer against the contracted shape. Since migration precedes
API promotion, Release 1 is a valid rollback target after contraction **only in
its verified, fixed active mode**. Never reactivate the compatibility branch.

### Compatibility inventory and follow-up

The named follow-up is the separate post-rollout PR2; opening it is outside this
implementation task. Its removal checklist must verify each gate below, rather
than treating promotion as proof that retained work has drained.

| Behavior                                                                                                                                         | Surface and exposure window                                                                           | Removal condition and follow-up                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy allocator and Web/native/output branches, including `loadOptionalChatEnrichment`'s preactivation failure path and migration 1212's bridge | Old API against expanded DB, rolling API fleet, captured legacy operations and preactivation rollback | PR2 after activation, all legacy operations/entry points drain, production acceptance and a compatible rollback floor.                                                                                           |
| `insertChatDeliveryCallback` recognizes historical random IDs                                                                                    | Persisted callback delivery/retry records written by old APIs                                         | PR2 only after historical pending retries and retained delivery records no longer require recognition and no supported API can write them. Do not equate deployment completion with record retirement.           |
| `ensureUserErasureJob` and `createRelationalErasureCollector` replay the preceding captured version                                              | Durable erasure captures and their original provider obligations outlive API deployment               | PR2 must inventory preceding-version captures; remove together only once every capture is completed or retired without losing obligations. Retain and explicitly carry this follow-up if that gate remains open. |
| Rollback resolver accepts an absent control table                                                                                                | Main's workflow may run before the first expansion release                                            | PR2 after the completed expansion is permanently within the supported schema floor. A present table with no singleton always fails.                                                                              |

The following are permanent accepted data states, not rollout shims to remove in
PR2:

- A missing sequence row means zero only for a new empty thread; the first
  allocator creates it atomically. Existing nonzero legacy watermarks are
  covered by the mandatory backfill. Retained event maxima are never a fallback.

## Verification and production measurements

The migration-consistency pipeline includes PostgreSQL acceptance for mixed
allocation, concurrent batches/replacement, first writes, gaps, rollback,
interrupted backfill/retry, retention, FK/control locks and contraction. Separate
suites inject real SQL failures into required context (the input is rejected
in both modes and its redelivery is accepted) and into weak
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
