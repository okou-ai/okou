# Goal retirement archival (S2)

**Completed 2026-09-09:** S2 passed
[independent controller production acceptance](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5604844349).
The [completed recovery record](goal-archive-search-recovery.md) retains the
final apply, full verification and retired execution-source evidence. The
historical S2/S4/S5 procedures below document the accepted rollout; pre-contract
SQL is no longer applicable to the current schema and is not an execution guide.

**S5 completed 2026-09-10:**
[independent production acceptance](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5623079780)
accepts physical contraction through Ethan's successful release #33307,
`9c777819776d2bed0cfdb110653e46dcaffc0e8b` (API 1.582.0 / App 0.884.1).
Release #33253's production DDL failed with `40P01`; its smoke clone was not
production success. The accepted frontier uses the byte-verified actual
1106 DDL → helper cleanup/timeout resets → awaited journal INSERT →
`Migrations complete` path at **2026-09-10 17:21:49.5878347 UTC**, plus fresh
physical metadata under unchanged masking policy. MaskDB exposes no journal or
constraint/procedure catalogs; no direct SELECT of those rows is claimed.
[The recorded migration gates](../turbo/packages/db/MIGRATIONS.md#retired-goal-transition-validators-2026-09-10)
explain retirement of the two validators and four pre-contract API variants.
Permanent history, SQL, accounting, security and rollback coverage remain.

Issue [#32797](https://github.com/vm0-ai/vm0/issues/32797) implements S2 of
[#32653](https://github.com/vm0-ai/vm0/issues/32653). The normal production S1
boundary is accepted: creation/reactivation and continuation are retired. The
2026-09-09 03:11 UTC metadata census measured 4,162 Goals across 13 organizations
and 19 owners: 3,819 complete, 141 paused, 200 blocked and two residual active
records. Actual Goal-origin nonterminal runs were zero. All 103,295 original
runless Goal inputs had canonical revokers, with an empty subsequent input tail.
These observations were paginated live reads, not an atomic snapshot.

## Delivery and recovery

This section describes the completed S2 migration and its historical retry contract.

`1093_goal_retirement_receipt` adds nullable event-ID/sequence receipt columns
with paired-nullability and positive JavaScript-safe sequence constraints. It
uses the transactional runner's 1-second lock and 10-second statement bounds.
There is deliberately no foreign key to hot events. Outgoing APIs can continue
using their existing columns and writers. Normal release ordering applies the
schema before the new ORM declaration reaches traffic.

`1094_archive_retired_goals` is non-transactional. Its temporary SQL procedure:

- Pages at most 100 unique thread IDs, including unrevoked Goal-input threads
  with no remaining Goal row. It never exports an objective to an application.
- Acquires the existing Goal advisory lock before the thread row lock, then
  rereads the Goal and checks its thread, owner, agent and agent organization.
  A shared agent's owner need not be the thread owner. Pending Goal context
  pointers must not resolve to another thread or owner.
- Appends an ordinary runless `output.message`, preserving the full unchanged
  objective as the content suffix and recording the original status and Goal
  ID in readable text. Only `active` becomes `paused`. One payload-free
  `goal.close`, the receipt and up to 100 canonical revokes commit with it.
  Additional pending inputs use further transactions on that one thread.
- Excludes claimed inputs, existing revokers and unresolved open deliveries.
  An open reservation is a blocker. Sequence allocation advances the locked
  thread counter; revokes retain the target's context and have later sequence
  IDs and timestamps. The operation does not create a run or invoke callbacks,
  notifications, usage writes, shared budgets or queue dispatch.
- Skips contended advisory/thread locks, advances the candidate cursor and
  rejects success if any unarchived, active, true-pending, reserved or actual
  Goal-origin nonterminal state remains. Checks classify runs by
  `trigger_source = 'goal'`, never by historical `goal_id` provenance.

The `CALL` has a 15-minute statement bound, covering the complete 4,162-thread
census rather than resetting a timer on each commit. Lock waits are bounded at
one second; contended initial locks skip immediately. No table lock, trigger
relaxation or new scheduling index is introduced. PostgreSQL tests measure the
pending query at the observed 103,295-input scale using `EXPLAIN (ANALYZE,
BUFFERS)` and also archive 4,162 long synthetic objectives.

On failure, the current thread transaction rolls back and earlier committed
threads remain durable. Error messages contain only phase, SQLSTATE and IDs;
progress/completion notices contain counts. The migration runner writes the
journal only after every statement succeeds. A normal authorized release retry
recreates the procedure and resumes using the receipts, including when an
archive/close has already moved into a valid snapshot. Do not delete receipts,
edit the journal, relax constraints, or reset completed threads to retry.
Resolve ownership, reservation, new-work or lock blockers before retrying.
The implementation PR's merge is not production migration or release evidence.

## Count-only production acceptance

These were the S2 pre-contract acceptance checks for controller/release owners
using an approved database path. S5 removed `thread_goals` and its receipts, so
these queries must not be run against the contracted schema. They did not expand
the seven-column MaskDB policy.
Do not select objective or payload content into logs or application processes.
Record the exact release, migration journal frontier and query timestamps.

```sql
SELECT status, count(*) FROM thread_goals GROUP BY status ORDER BY status;
SELECT count(*) FILTER (WHERE retirement_archive_event_id IS NULL) AS unarchived,
       count(*) FILTER (WHERE status = 'active') AS active
FROM thread_goals;

WITH unrevoked AS (
  SELECT e.id FROM chat_events e
  WHERE e.event_type = 'input.goal' AND e.run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)
), classified AS (
  SELECT EXISTS (
    SELECT 1 FROM active_input_delivery_items item
    JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
    WHERE item.source_event_id = e.id AND item.disposition IS NULL
      AND delivery.status = 'open'
  ) AS reserved FROM unrevoked e
)
SELECT count(*) FILTER (WHERE NOT reserved) AS true_pending,
       count(*) FILTER (WHERE reserved) AS open_reservations
FROM classified;

SELECT count(*) AS actual_goal_nonterminal FROM agent_runs
WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running');

-- Exact full-content comparison stays inside PostgreSQL and returns a count.
-- Run promptly while new archive rows are hot; snapshot coverage below is not
-- a substitute for this content check or the canonical history regression.
SELECT count(*) AS invalid_hot_archive
FROM thread_goals g JOIN chat_events e ON e.id = g.retirement_archive_event_id
WHERE e.chat_thread_id IS DISTINCT FROM g.chat_thread_id
   OR e.seq_id IS DISTINCT FROM g.retirement_archive_seq_id
   OR e.event_type <> 'output.message' OR e.run_id IS NOT NULL
   OR e.payload - 'content' IS DISTINCT FROM '{}'::jsonb
   OR right(e.payload->>'content', char_length(g.objective)) IS DISTINCT FROM g.objective;

SELECT count(*) AS receipts_without_hot_or_snapshot_coverage
FROM thread_goals g
WHERE g.retirement_archive_event_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM chat_events e
    WHERE e.id = g.retirement_archive_event_id AND e.chat_thread_id = g.chat_thread_id
      AND e.seq_id = g.retirement_archive_seq_id)
  AND NOT EXISTS (SELECT 1 FROM chat_event_snapshots s
    WHERE s.chat_thread_id = g.chat_thread_id AND s.archive_schema_version = 7
      AND s.last_seq_id >= g.retirement_archive_seq_id
      AND s.object_key ~ '-[0-9a-f]{64}[.]ndjson[.]gz$');
```

All remainder/error counts must be zero. Without concurrent user clears, expected
post-state is 3,819 complete / 143 paused / 200 blocked, with 4,162 receipts.
Reconcile legitimate clears/cascades with the bounded progress counts; never
reconstruct cleared objectives. Verify fresh ordinary-message and historical
read positive controls and inspect relevant migration/API errors. The journal
and count-only completion notice must correspond to this migration, not an
unrelated deployment or chat-run completion.

## Removal point

S2 dropped its temporary procedure after success. S4 retained the physical Goal
table, receipts and `agent_runs.goal_id` while removing application consumers.
After the consumer-free S4 release and its ordinary-write repair were accepted,
S5 replayed preservation/settlement, passed the residual and preservation gates,
and dropped those physical objects and helpers. Historical events remain.

S6a retires the completed transition validators under
[MIGRATIONS.md](../turbo/packages/db/MIGRATIONS.md#retired-goal-transition-validators-2026-09-10).
The original numbered 014 README/code/exports and shipped 1093/1094/1105/1106
SQL, snapshots and journal remain unchanged as historical records. Operation
014 is complete and must not be replayed against the contracted schema. No
elapsed waiting period replaced the accepted gates.

## Literal historical projection (#32834)

The full objective is arbitrary historical text. A citation envelope, unmatched
opener, inline code, fence, Unicode, or whitespace in that suffix is not assistant
citation transport. The reader recognizes **only** the immutable 1094 format:
`output.message`, null run/revoker/context/run-event coordinates, exactly one string
`content` payload key, and the entire frozen notice with a valid UUID and the exact
status-specific explanation. Unknown formats and actual assistant copies keep the
ordinary citation filter. This support has no Goal lifecycle or lookup authority.
Do not rewrite 1093/1094, hot events, snapshots, or append another archive.

| Consumer                                 | Preservation boundary                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw history, Platform hot/snapshot cache | `chatEventFromRow` uses the strict shared raw-source projection. Raw CLI files remain unchanged.                                                                                              |
| SQL history consumers                    | `canonicalChatEventVisibleContent` carries provenance only in SELECT; `canonicalChatEventContent` retains its original text/null/regex expression for predicates and run-scoped consumers.    |
| Snapshot history and user export         | `canonicalArchivedChatEventContent` uses the same strict raw-source projection, independently of receipts or Goal tables.                                                                     |
| New shares and saved intact shares       | Hot and snapshot selection project first; the saved reader checks absence of run/group indices plus the complete frozen grammar before preserving already-projected text.                     |
| Search projection/results                | Canonical projection preserves exact whitespace; the result reader checks null run ID plus full grammar before avoiding a second filter.                                                      |
| Chat and public-share pages              | Identified runless archives use a text tree with preserved whitespace, without HTML/Markdown interpretation, generated closing tags, or action cards. Copy/export retain the original source. |

The remaining SQL content callers are run-scoped callback/session/incomplete-context
readers or input/control/followup validation.
Their selections and text/null/regex predicates retain the previous behavior.
Title/followup context selection uses the provenance-aware projection because its
thread-wide query can include runless historical output. No callback, queue,
notification, usage, budget, or native-runtime policy is changed.

Before projector repair, an old search projector could advance its watermark
after stripping objective text. The completed, bounded [014 search recovery](../turbo/packages/db/scripts/migrations/014-goal-archive-search/README.md)
reads only receipt-addressed canonical history inside the authorized repair process
and replaces only those derived search documents. Its default is read-only; its
reports contain counts and opaque cursors, never objective text. This operational
processing exception does not expand MaskDB's seven-field policy or authorize an
objective census/export.

For the intact 4,162-Goal production cohort, the sole recovery owner completed
[apply 34356992223 / job 102484085578](https://github.com/vm0-ai/vm0/actions/runs/34356992223/job/102484085578),
source `aba3bd9692db398472b6033432d802f94d0579cc`, successfully at
**2026-09-09 15:38:53 UTC** after repaired readers and projector convergence.
It repaired **four thread outcomes**; fresh final verification reported
**4,162 unchanged, every other outcome zero**, with all three complete
Goal/thread/receipt cohorts and the original ID hash intact. The historical
cancelled apply's attributable commit count remains **UNKNOWN**.

The [dated completed recovery record](goal-archive-search-recovery.md) links the
full operator/controller certificates and immutable accepted source
`30c84e22f32fb43bfc12af672fa1aec9a8969c47`. S3 #33023 removed the temporary
GitHub workflow, wrapper and dedicated tests after that acceptance. Their
dispatch instructions are retired; no further recovery execution is expected.
The controller already deleted the separate Okou S2 watcher and verified absence.
The numbered 014 operation and its exports remain as permanent historical
records. S5 subsequently contracted the physical schema; S6a retires the expired
transition validation while retaining current-schema reader coverage.

Public shares are intentionally immutable copies. A previously stripped copy is
not automatically changed or republished. Its owner can explicitly create a new
share. This repair establishes that limitation with synthetic fixtures; no affected
production public share inventory has been observed or claimed. Existing raw data
remains lossless. Merge alone establishes neither controller acceptance nor release.

## S4 application consumer removal (#33061)

S4 removes the live Goal routes/contracts, permission issuance, queue association,
continuation, settlement, marker and schema-maintenance services. Ordinary queue
locks, active-input handling, autonomy budgets, first-assistant acknowledgement,
terminal callbacks and completion automations retain their existing owners.
Unsupported captured inputs are rejected before preparation and at final claim;
queued Goal-origin runs are excluded from promotion and rechecked under the run
lock. They are not converted to manual runs or given synthetic terminal events.
Explicit ordinary cancellation remains available. Signed legacy tokens retain
unrelated known permissions; banking's unattended classification and reuse-key
rejection stay conservative.

### Physical definitions and application SQL

`@okouai/db/runtime/agent-run` is the application `agent_runs` mapping. Its shared
column factory in `src/columns/agent-run.ts` omits `goal_id`, including implicit
INSERT defaults, SELECT and RETURNING. Application imports and the runtime DB
registry use this mapping. It is outside Drizzle's unchanged `src/schema/*` glob
and is not re-exported by files under that glob.

During S4, `src/schema/agent-run-session-conversation.ts` still added the physical
`goal_id` column and retained the original FK, indexes and checks; the common
factory prevented divergent non-Goal columns. S4 preserved physical
`thread_goals` and paired receipts and added no production migration. S5 later
removed those definitions. Migration consistency still generates and compares
the complete current physical schema.

The retained `goal-schema-contraction.test.ts` fixture now runs the complete
current migration sequence in a test-owned database. Real failed-launch INSERT and
successful launch CTE, run reads/metadata, claimed terminal callback and late
usage execute there. OpenTelemetry captures the actual application statements;
the test verifies both insertion forms and the absence of obsolete SQL names.
This fixture preserves current-schema consumer and accounting coverage; it does
not perform a production migration.

### Historical provenance and accounting

New run/message admission rejects Goal input, while historical trigger sources,
message parts and saved drafts remain decodable. Generic callback grouping uses
canonical run-linked events in the owning thread. When hot rows cannot answer,
the existing checksum/schema/order-validated snapshot reader supplies retained
provenance. A stable snapshot-head check closes the READ COMMITTED race with
snapshot publication and hot retention without changing the usage advisory lock.
A retained non-Goal prompt alone does not erase a group in archived output.

Repair #33152 gives the initial queue claim the fresh server-generated run UUID
as its canonical event ID. `prepareLaunchRunIdentity` allocates that UUID;
`claimQueueFirstRunAssociation` appends the run-attributed replacement before the
same transaction inserts the run in failed, queued and pending/CTE launches.
Client event IDs identify the preceding runless input. Active-input delivery
creates separate replacement IDs; it does not reuse the run UUID. Thus an exact
hot `input.prompt` with matching event/run/thread identity and a revoke edge
establishes the run's initial physical position. Only when that position exceeds
a stable snapshot `lastSeqId` can provenance and first usage omit that archive.
`terminalSeqId`, wall clocks, trigger labels and arbitrary hot events do not
establish this bound. The pointer is rechecked across exclusion as well as reads.

This is an event identity convention, not a new payload/schema or Goal store.
Old writers/readers remain compatible with the same event and revoke grammar.
Older runs, copied identities, missing claims and already-covered claims keep
the canonical history path and its explicit errors. A necessary history read
is shared only within one usage operation under its existing per-run lock;
there is no cross-operation cache or historical event rewrite.
An omitted archive read is not reused as resolved empty history: first usage
retains the hot-before-history ordering if publication and retention move a
previously hot context after the prior-usage lookup.

Usage corrections inherit the exact prior context pointer, including null,
revocation identity, strictly later event timestamp and original settled time.
The first late usage uses available hot/snapshot provenance; absent provenance
emits legitimate ungrouped accounting rather than guessing a group or consulting
a Goal row. Pending exclusions, raw/hourly aggregation, allowance arithmetic and
per-run idempotency remain unchanged. No historical completion is replayed.

Retained Goal references are intentionally limited to:

| Purpose                  | Retained surfaces                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical compatibility | canonical context/group projections, hot/snapshot decoding, strict literal 1094 archives, draft/log annotations, search/export and immutable shares |
| Conservative security    | legacy banking unattended classification, reuse-key rejection and unsupported captured-input guards                                                 |
| Migration history        | immutable shipped SQL, snapshots/journal and original numbered 014 records; permanent current-schema consistency coverage                           |
| Historical test evidence | deliberate old-row fixtures and behavior tests; these do not expose Goal product writers                                                            |
| Separate S6 resources    | official published resources, user storage and durable instructions, outside this PR                                                                |

### Mounts and bounded captured contexts

S1 removed automatic hidden Goal mounting. S4 removes the residual seed constant
and dev-seed entry. Fresh and supported reused/new-session API preparation use the
current mount list. Runner's existing omitted-mount plan removes previously
fingerprinted paths while retaining unrelated nested skills. Pi resource
preparation constructs a durable list from current mount archives; its actual
resource loader honors that snapshot even if an omitted skill remains on disk.
Neither path blacklists an arbitrary user-owned skill named `goal`.

Already queued `execution_context` values are captured payloads, not rebuilt by
new defaults. The controller's [00:45 UTC metadata checkpoint](https://github.com/vm0-ai/vm0/issues/33061)
found zero Goal-origin and independently zero Goal-linked nonterminal runs across
the complete 4,162-Goal cohort. That is the bounded known Goal-work disposition
used for removing S1 settlement, together with the earlier full S2 certificate.
Synthetic old queued inputs, queued/pending Goal-origin runs and Pi first-turn
captures remain fail closed in S4. This does not certify every historical ordinary
payload or external deployment, and no payload, production DB/R2 object, user
instruction or durable workflow is rewritten. A specifically identified stale
ordinary payload must be assessed within its own bounded context; token TTL or
an old owner launch package is not a global drain certificate.

Controller code acceptance and normal-production verification followed merge in
separate ownership. Accepted S5 established a serving consumer-free S4 rollback
target and repeated preservation/zero-residual gates before physical contraction.
The permanent S1 ancestry floor alone is insufficient. S6 publication/storage cleanup
remains separate; Codex `features.goals=false` stays intact.

## S5 physical contraction (#33285)

The accepted combined S4 release is `4a4881bf84cb1d79723fd38c83e00f2215bb1e31`
(API 1.580.0). The current-main rollback resolver now requires both original S4
and its ordinary-write repair; see [the compatibility boundary](deployment-compatibility.md#okou-goal-retirement-rollback-floor).
Implementation merge is not production contraction or EPIC acceptance.

### Ordered migration and retry contract

This is the shipped S5 migration's historical execution and recovery contract;
its production frontier has passed the acceptance recorded above.

1. `1105_prepare_goal_metadata_contraction` adds
   `agent_runs_metadata_without_goal_check` with `NOT VALID`, retaining the
   original validated check. New writes satisfy both checks immediately.
   Separate online validation scans existing runs with a 60-second statement
   limit, without an ACCESS EXCLUSIVE scan lock. Adding the check uses a
   1-second lock / 10-second statement limit. Retry reuses the same check.
2. `1106_contract_retired_goal_schema` recreates and calls the 1094 operation:
   100 candidate threads / up to 100 revokes per commit, Goal advisory lock
   before the owning thread row, exact literal objective/original status,
   no lifecycle callbacks or accounting. The CALL retains its 15-minute total
   budget and 1-second lock limit. Receipts survive a committed-prefix retry.
   Missing paired receipts, or an unreceipted Goal whose existing archive or
   snapshot makes prior preservation ambiguous, fail closed before appending.
3. A single final `DO` statement, bounded by 10 seconds including lock waits,
   rechecks ownership, receipt shape, active/pending/reserved/actual-origin
   nonterminal residuals and preservation, then contracts atomically. ACCESS
   EXCLUSIVE locks on `agent_runs` and `thread_goals` are required for DDL.
   SHARE locks on threads, agents, events, snapshots and active delivery tables
   freeze clears, ownership changes, retention/publication and residual writers
   across verification and DROP. The backfill takes none of these table locks.
   Contention beyond one second aborts; the current physical schema survives.
4. The final transaction renames the already-validated replacement check,
   explicitly drops the named Goal FK/index/column, and drops `thread_goals`
   with `RESTRICT`. It rejects unexpected automatic column dependencies and
   stored routine references before contraction. External views/FKs that PostgreSQL
   protects with RESTRICT also roll back the entire final transaction.
   There is no visible state without a validated metadata check.

The replacement check contains every original term except `goal_id`: either all
18 remaining optional fields are null, or trigger source and autonomy budget
are both present. Autonomy bounds, launch snapshot and official provenance
constraints are unchanged. No run, session, event, share, snapshot or accounting
row is a deletion target. Snapshot IDs and historical `goal` security labels
remain inert context.

The non-transactional runner writes its journal only after all statements pass.
If interrupted after final DDL commits but before helper removal or journal
insertion, retry recreates the helper without retired row-type dependencies,
verifies complete contracted state and the validated checks, removes the helper,
and journals once. If verification/DDL fails, every destructive change rolls
back; retry performs the entire idempotent replay again. Resolve the observed
blocker before retrying through the normal authorized release path. No manual
journal edits, receipt resets, trigger relaxation, 014 replay or new DB/R2
operator is part of this recovery. One attempt is bounded by the 15-minute CALL,
60-second online validation and 10-second final statement; repeated attempts
require a resolved cause, not an increased timeout or bypass.

### Preservation evidence and verification

Hot receipts require exact identity, runless/revokerless/contextless raw-source
coordinates, one string payload key, no revocation and the complete frozen 1094
notice plus unchanged objective UTF-8 bytes. All comparisons execute inside
PostgreSQL and expose counts only. Snapshot-only receipts require a valid V7
physical/logical cursor covering the receipt and a thread/sequence-specific
content-addressed object key. Null, mismatched or missing coverage blocks DROP.

This pointer coverage is **not a fresh full-content certificate**. The
[accepted S2 certificate](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5604844349)
and unchanged canonical reader checksum/schema/order validation preserve the
external object boundary. Current-main hot/snapshot/search/share/export tests
run against the complete contracted schema and remain permanent coverage.
S6a removes only the four pre-contract API variants, their 1094/014 fixture
branches and the two expired DB validators after independent S5 acceptance.
All four recorded statuses, exact literal content, malformed provenance,
old-share immutability and ordinary continuation remain exercised.

The [historical S5 validator](https://github.com/vm0-ai/vm0/blob/1cd69b0219c6fe67b7d2fd15bcb7e914ffd8f52e/turbo/packages/db/scripts/test-goal-schema-contraction.ts)
used 4,162 Goals, 101,626 hot Goal inputs and 113,789 historical
linked runs within 271,758 total runs. It compared retained run/event/snapshot
records and unrelated constraints before/after contraction, tested actual
constraint failures, and measured online validation, replay and final lock-held
work separately. Hot-input counts do not enumerate all snapshot history.
Replay census/reconciliation and final notices report remaining counts; compare
these with legitimate concurrent clear counts without reconstructing objectives.
Production release and acceptance remain the controller and separate release
owner's responsibility.
