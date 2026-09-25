# Chat event split writes: two-release rollout

Release 1 expanded the schema, installed a legacy allocation bridge and shipped
both write modes behind the singleton `chat_event_write_control` row. Release 2
(the `contract_chat_event_sequence_bridge` migration) removes the legacy mode:
the API only writes through `chat_event_sequences`, the bridge trigger/function
and `chat_threads.last_chat_event_seq_id` are dropped, and no runtime path reads
the write mode. Production activated split writes at 2026-09-25 00:06:25 UTC.
Migration `drop_chat_event_write_control` then drops the control table and its
activation trigger/function; the rollback resolver refuses API targets before
Release 2 (#36703, API 1.676.0), the last release that read the table.

The contraction migration still fails closed (SQLSTATE `55000`) unless the row
is activated. A database without any chat thread is activated by that migration;
any other database that has not yet applied it, including a shared preview
parent or a local development database with data, must run the control write
under [Activation](#activation) before it can migrate.

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
  event. The existing callback retry mechanism owns delivery recovery and
  retryable `chat-run-finished` automation admission; an already committed
  marker does not acknowledge unfinished completion work. An admission receipt
  on the existing source callback commits with each watched automation's queue
  event. This receipt survives hot-event archival, so a lost final callback
  acknowledgement cannot enqueue the automation again. Replay still attempts the
  guarded source and automation queue wakeups.
- Ordinary identity checks remain. Event/context/output writes no longer hold
  the broad erasure fence. Confirmed deletion can race a late write; the existing
  background-job cron collects those rows as described below.

There is no outbox or durable compensation queue for draft/timestamp/sort. A lost
weak side effect is an accepted observable outcome, not an event-write failure.

## Activation

Release 1 shipped the expansion, bridge, backfill and routing/cleanup
migrations. Production was activated at 2026-09-25 00:06:25 UTC after event
producers were quiesced and every legacy-mode operation had drained. A database
that has not yet applied the contraction migration and holds chat threads must
be activated before migrating:

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

Exactly one row must be returned. Never run a pre-Release-1 binary against an
activated database.

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
or access authority. Verified erasure completion and the Clerk user-deletion
job write it in their completing transaction. Clerk organization cleanup records
the subject before cleanup and marks it completed in a separate statement after
`deleteOrgData` returns, outside any transaction. That cleanup runs after the
webhook is acknowledged, so a failure before the completion write leaves the
receipt without `completed_at` and nothing retries it. The migration seeded
jobs that were already terminal. The deployment-time reconciliation for older
APIs is retired: on 2026-09-25 every completed deletion and verified erasure
job had a receipt. Cleanup requires a completed receipt, not a missing user row.
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
Release 1 remained a valid rollback target after contraction only in its
verified, fixed active mode. Dropping the control table ends that window: the
rollback resolver now requires a target from Release 2 on. Never reactivate the
compatibility branch.

### Compatibility inventory

| Behavior                                                                                                                                                                 | Release 2 outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy branch of every `isSplitChatEventWriteEnabled` caller, `loadOptionalChatEnrichment`'s preactivation path and the `chat_event_sequence_bridge` migration's trigger | Removed. Activation is enforced by the contraction migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Rollback resolver accepts an absent control table, then its activation read                                                                                              | Removed. Migration 1236 and the irreversible activation trigger guarantee the activated row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ensureUserErasureJob` / `createRelationalErasureCollector` replay of the preceding captured collector                                                                   | Removed. Merge requires zero incomplete preceding-version captures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `insertChatDeliveryCallback` recognizes historical random-ID registrations, and cancel recovery replays an acknowledged callback whose `run.cancelled` marker is missing | Removed together. Split writes commit the marker before the callback is acknowledged, so only undelivered source callbacks are replayed. On 2026-09-25 no historical delivery row had a pending or failed source callback, and every cancelled run missing a hot marker belonged to an archived thread.                                                                                                                                                                                                                                                                           |
| Source-thread reach for `chat_agent_run_context` rows with null `source_user_id`/`source_org_id`                                                                         | Retained for now. On 2026-09-25, 955 rows had a null owner and none of their source threads still exists, so the reach matches nothing. Removing it changes the relational collector contract, which needs a new collector version. That waits until no incomplete job is captured under the current version. On 2026-09-25 one pending user job still is. Its `catalogue_absent:discord_chat_deliveries` failure ([#36798](https://github.com/okou-ai/okou/issues/36798)) was fixed by applying migration 1226, and it now waits for an objects-domain erase verification retry. |
| `chat_event_write_control`, its `preserve_chat_event_write_activation` trigger, and the rollback resolver floor at the split-writer commit                               | Removed. Migration `drop_chat_event_write_control` drops the table, trigger and function. API 1.674.0/1.675.0 read the control row on every write, so the resolver floor moved to Release 2 (`15117da781`, API 1.676.0) with owner approval; production was serving 1.676.1 or later.                                                                                                                                                                                                                                                                                             |

The following are permanent accepted data states:

- A missing sequence row means zero only for a new empty thread; the first
  allocator creates it atomically. Existing nonzero legacy watermarks are
  covered by the mandatory backfill. Retained event maxima are never a fallback.

## Verification and production measurements

The migration-consistency pipeline includes PostgreSQL acceptance for mixed
allocation, concurrent batches/replacement, first writes, gaps, rollback,
interrupted backfill/retry, retention, FK locks and contraction. Separate
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
