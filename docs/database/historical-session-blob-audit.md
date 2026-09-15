# Historical session-history blob reference audit

Scope: [#34230](https://github.com/vm0-ai/vm0/issues/34230). This is an aggregate,
read-only observation tool after the forward conversation deletion fix. It
changes no runtime accounting, schema, feature switches, object storage, or
historical counters. The issue remains open for controller acceptance and
production execution. A merged tooling PR is not a production audit or repair.

## Current ownership census

The source census began on a full repository checkout after fetch/rebase to
`main@22d0e7c82658704920587dd12c471780a9850684` and was revalidated after integrating
`main@7247fe035f88b8e5c59d0151c9a1ef44a411a238` to resolve an actual DB package
conflict with #34224. Its claim-scale command and migration 1130 are preserved.
The merged delta adds no blob owner or counter writer. The census covers tracked API, DB,
Runner, guest, contracts, scripts, tests and historical SQL, including imports,
aliases and callers. GitHub search is not the completeness boundary.

The two persisted reference owners are **each conversation row with a non-null
history hash** and **each Stage 1 candidate row**. Count rows, including duplicate
hashes, independently of metadata existence, candidate status, source-run
existence or the current PiMemory gate. A hash stored as a checkpoint, session,
watermark, selection or execution-context pointer does not acquire another
reference merely by pointing at an owner. No other live reference writer was
found at the census revision.

### Live retain, release and metadata writers

Paths in this table are under `turbo/apps/api/src/signals/`.

| Writer and actual entrance                                                                                                                                                                                                                                                                                                                              | Ownership and transaction evidence                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`services/agent-webhook-checkpoints.service.ts`](../../turbo/apps/api/src/signals/services/agent-webhook-checkpoints.service.ts), `persistAgentCheckpoint`                                                                                                                                                                                             | The sole production conversation upsert. A changed non-null hash inserts a count-one blob or increments it; replacing an old hash decrements it with the existing clamp. Conversation, checkpoint and session promotion are in the same transaction. Unchanged hashes and exact retries do not retain. The clamp is existing behavior, not audit evidence that historical counts are correct.                        |
| Same file, `persistAgentCheckpointInTransaction`, `createAgentCheckpoint$`; [`services/agent-webhook-complete.service.ts`](../../turbo/apps/api/src/signals/services/agent-webhook-complete.service.ts)                                                                                                                                                 | Standalone checkpoint and combined completion both use the canonical persistence operation, with run/checkpoint ownership and Pi validation. Combined completion can defer session promotion; this does not add another blob owner. API-first settlement enters the same checkpoint/complete path.                                                                                                                   |
| Same checkpoint file, `prepareCheckpointHistoryUpload$` → `ensureSessionHistoryBlobMetadata`                                                                                                                                                                                                                                                            | Authenticated history preparation inserts metadata with count zero and can fill unknown size/encoding. Preparation occurs before ownership and object upload may fail or remain incomplete.                                                                                                                                                                                                                          |
| [`services/pi-api-first-turn.service.ts`](../../turbo/apps/api/src/signals/services/pi-api-first-turn.service.ts), `persistIdentitySessionBlob$`                                                                                                                                                                                                        | API-first history assembly inserts count-zero metadata, fills zero-size metadata and writes the immutable identity object before checkpoint ownership. It never retains an extra reference for a prepared history.                                                                                                                                                                                                   |
| [`routes/runners.ts`](../../turbo/apps/api/src/signals/routes/runners.ts), `loadIdentityResumeSessionHistoryRepresentation$`                                                                                                                                                                                                                            | Runner execution-context loading may fill zero-size identity metadata from object length. It does not change `ref_count`. Compressed representation loading only reads metadata.                                                                                                                                                                                                                                     |
| [`services/pi-memory-stage1-candidate.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-stage1-candidate.service.ts)                                                                                                                                                                                                                     | Actual inserted candidates retain once. Source replacement retains the returned new hash and releases the locked old one. Deletion releases returned candidates grouped by hash with an adequate-count predicate. Missing metadata or insufficient counts abort the owning transaction. All statuses retain until canonical replacement/deletion.                                                                    |
| [`services/pi-memory-stage1-schedule.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-stage1-schedule.service.ts) → `admitPiMemoryStage1Candidate`                                                                                                                                                                                      | The daily decision is the current production admission caller. Interactive owned product Thread, completed Pi source, persisted generation eligibility and the owning user's live PiMemory gate precede admission. A disabled gate does not erase existing candidate ownership. `insertPiMemoryStage1Candidates` is also the canonical controlled fixture insertion boundary, not an active production backfill job. |
| [`services/conversation-history-deletion.service.ts`](../../turbo/apps/api/src/signals/services/conversation-history-deletion.service.ts)                                                                                                                                                                                                               | `deleteRunConversations` groups hashes from actual `DELETE RETURNING` rows; `releaseDeletedConversationReferences` releases them after parent/storage mutations in the same transaction, with missing/insufficient-count rollback.                                                                                                                                                                                   |
| [`services/threadless-run-cleanup.service.ts`](../../turbo/apps/api/src/signals/services/threadless-run-cleanup.service.ts), [`services/agent-deletion.service.ts`](../../turbo/apps/api/src/signals/services/agent-deletion.service.ts), [`services/agent-lifecycle.service.ts`](../../turbo/apps/api/src/signals/services/agent-lifecycle.service.ts) | Threadless sweep, authenticated Agent deletion, and Clerk user/org cleanup are the conversation-deletion callers. Parent and run locks freeze the actual accounted set. There is no independent production session-delete endpoint.                                                                                                                                                                                  |
| [`services/webhooks-clerk-cleanup.service.ts`](../../turbo/apps/api/src/signals/services/webhooks-clerk-cleanup.service.ts) → `deleteStoragesWithPiMemoryCandidates`                                                                                                                                                                                    | User/org storage cleanup owns the parent/candidate/reference transaction. Candidate `source_run_id` has no run FK: deleting a source run must not subtract the candidate owner. No independent production caller of standalone `deletePiMemoryStage1Candidates` was found; the parent helper invokes it.                                                                                                             |

### Persisted pointers, readers and excluded namespaces

| Surface                                                                                                                                                                                                                                                                                                                                                              | Evidence and treatment                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agent-run-session-conversation.ts`](../../turbo/packages/db/src/schema/agent-run-session-conversation.ts) and schema/runtime re-export files                                                                                                                                                                                                                       | `conversations.cli_agent_session_history_hash` is nullable and has no blob FK. `schema/conversation.ts`, `schema/agent-session.ts` and runtime Agent Run exports alias the same tables. Missing metadata must survive the audit join. Null hash rows own no blob; inline/null and hash-plus-inline rows are reported separately.                                                                    |
| [`checkpoint.ts`](../../turbo/packages/db/src/schema/checkpoint.ts), `agent_sessions.conversation_id`                                                                                                                                                                                                                                                                | Both reference conversations, with checkpoint cascade and session `SET NULL`. The checkpoint persistence operation writes these pointers without a second retain. Count the conversation once even if many aliases reach it.                                                                                                                                                                        |
| [`pi-memory-stage1-candidate.ts`](../../turbo/packages/db/src/schema/pi-memory-stage1-candidate.ts)                                                                                                                                                                                                                                                                  | `source_history_hash` is an independent owner with a blob FK. Its last-selected hash is constrained to equal the source hash and records selection; it does not retain again. Source-run absence is reported but is not missing ownership.                                                                                                                                                          |
| [`pi-memory-stage1-watermark.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-stage1-watermark.service.ts), [`pi-memory-stage1-schedule.ts`](../../turbo/packages/db/src/schema/pi-memory-stage1-schedule.ts)                                                                                                                                        | The per-Thread source hash is a progress watermark. The writer advances activity/hash without touching blobs; the scheduler uses it to avoid reprocessing an unchanged source. It is not independently retained.                                                                                                                                                                                    |
| [`pi-memory-phase2-job.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-phase2-job.service.ts), [`pi-memory-phase2-maintenance.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-phase2-maintenance.service.ts), [`pi-memory-phase2-worker.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-phase2-worker.service.ts) | Selected-source hashes and callback snapshots fence selection/usage against a candidate's current source. Phase 2 consumes the candidate's derived memory output. Job/checkpoint/provenance and Stage 1 usage/lease/result updates do not independently retain source blobs.                                                                                                                        |
| [`agent-run-create.service.ts`](../../turbo/apps/api/src/signals/services/agent-run-create.service.ts), [`chat-session-continuity.service.ts`](../../turbo/apps/api/src/signals/services/chat-session-continuity.service.ts), Runner execution-context contracts                                                                                                     | Continuation follows session → conversation and constructs history references in launch/queue payloads. Claim and resume readers resolve blob encoding and object URLs. Serialized `historyRef`/`resumeSession` pointers are not retain writers.                                                                                                                                                    |
| [`pi-memory-stage1-worker.service.ts`](../../turbo/apps/api/src/signals/services/pi-memory-stage1-worker.service.ts), [`user-export.service.ts`](../../turbo/apps/api/src/signals/services/user-export.service.ts), Pi API-first history loader, checkpoint validation                                                                                               | These read source metadata/history for extraction, export, continuation or checkpoint validation. A failed read does not release a reference. The audit neither downloads nor verifies these objects.                                                                                                                                                                                               |
| [`session-history-blobs.ts`](../../turbo/apps/api/src/signals/services/session-history-blobs.ts), [`guest checkpoint writer`](../../crates/guest-agent/src/checkpoint/session_history.rs)                                                                                                                                                                            | History objects use `blobs/<raw-content-hash>.blob`, `.blob.gz` or `.blob.zst` in the user storage bucket. The guest prepares/uploads/checkpoints through the API; it does not write the database ledger directly.                                                                                                                                                                                  |
| [`storage-version-registration.service.ts`](../../turbo/apps/api/src/signals/services/storage-version-registration.service.ts), [`storage-write.service.ts`](../../turbo/apps/api/src/signals/services/storage-write.service.ts), [`storage.ts`](../../turbo/packages/db/src/schema/storage.ts)                                                                      | Storage versions register `s3_key` archive metadata; storage publication writes `<s3_key>/archive.tar.gz` and resource indexes. Version IDs, HEAD pointers, mounts and lineage are a separate namespace and have no blob retain or blob FK. Even exact equality between a version ID and a blob hash creates no additional owner.                                                                   |
| Runner [`gc/storage.rs`](../../crates/runner/src/cmd/gc/storage.rs) and API cleanup routes                                                                                                                                                                                                                                                                           | Runner GC removes local storage caches under age/flock limits; API sandbox/artifact cleanup concerns its own resources. Repo-wide blob imports, SQL writes and object-key helper callers reveal no current production blob-deleting GC implementation. `idx_blobs_ref_count` and the candidate FK describe protection primitives, not evidence of a running GC job. No GC is executed by this tool. |

`pi_memory_stage1_selections` (also in `pi-memory-stage1-schedule.ts`) is a frozen daily selection, explicitly documented by its schema as metadata without extra blob references. The scheduler inserts it only after candidate admission, deletes it on the next interactive day, and the Stage 1 worker joins every frozen source field back to the current candidate. It can survive source/Storage deletion without becoming an independent owner. The validator includes such a surviving selection pointing at a positive unowned blob.

### Non-production and historical exclusions

- `routes/test-{pi-memory-stage1,teams,usage,computer-use,telegram,slack,cron-cleanup-sandboxes,cron-monitor-chat-event-queue}-state.ts`
  call [`isTestEndpointAllowed`](../../turbo/apps/api/src/signals/routes/test-endpoint-helpers.ts).
  It permits development or authorized preview and rejects production. These
  fixture/reset writers are not production deletion or repair entrances.
- `src/test-fixtures/` and `__tests__/` contain deliberately direct setup and
  corrupt-data cases. Production fixture imports are prohibited by repository
  lint. The shared run-deletion fixture uses the canonical accounting helper.
- [`dev-bench-seed.ts`](../../turbo/apps/api/src/scripts/dev-bench-seed.ts) defaults
  to a local-host allowlist. `DEV_BENCH_SEED_ALLOW_NON_LOCAL=1` overrides that
  protection, so it is not inherently safe for production. It is an operator
  development script, not a production lifecycle caller.
- DB validators own disposable databases/schemas. This PR's validator migrates
  a newly created random database; its corrupt fixtures and scale writes never
  target the database named by `DATABASE_URL`.
- `1078_baseline.sql` records the original candidate trigger/function;
  `1121_retire_pi_candidate_reference_trigger.sql` removes it. These are
  historical transition records, not live writers or commands to replay.
  Migration 1125 adds scheduling watermarks without changing blob ownership.
  External storage migrations 006/007/008/015 concern retired tables, skill
  volumes or version indexes; they are not blob-counter repair commands.
- Browser `intro-video-draft-store.ts` uses browser Blob objects in IndexedDB;
  resource registry and Rust contract fixtures use the word blob for unrelated
  data or protocol representations. Neither writes PostgreSQL `blobs`.

Reproduce and extend the census before a later execution or repair:

```sh
rg --hidden -n 'blobs|blobSchema|refCount|ref_count' turbo crates scripts .github \
  --glob '!**/node_modules/**' --glob '!**/migrations/meta/**' --glob '!**/CHANGELOG.md'
rg -n 'cliAgentSessionHistoryHash|cli_agent_session_history_hash|sourceHistoryHash|source_history_hash|historyRef|resumeSession' turbo crates \
  --glob '!**/node_modules/**' --glob '!**/migrations/meta/**' --glob '!**/CHANGELOG.md'
rg -n 'insert\(conversations|delete\(conversations|delete\(agentRuns|delete\(agentSessions|delete\(agents|deleteStoragesWithPiMemoryCandidates|deletePiMemoryStage1Candidates|admitPiMemoryStage1Candidate' turbo/apps/api/src
```

The first census overlap read found #34220, #34224 and #34234 touching the DB
package or validator chain, and #34090/#34095 competing for migration numbers.
None adds a current blob owner on the inspected main. This PR adds no migration;
package conflicts must preserve both independently required test commands.
Overlap is inventory, not a merge-order dependency.

## Running and interpreting the audit

The exact runnable artifact is
[`audit-historical-session-blob-references.sql`](../../turbo/packages/db/scripts/audit-historical-session-blob-references.sql).
The controller first verifies the deployed writer inventory, rollout floor,
schema and any out-of-repository writers. Use an already authorized read-only
PostgreSQL execution environment, in a **fresh connection**, for example:

```sh
PGSERVICE=approved_read_only psql -X --no-password --set ON_ERROR_STOP=1 \
  --quiet --tuples-only --no-align \
  --file turbo/packages/db/scripts/audit-historical-session-blob-references.sql \
  > historical-session-blob-receipt.json
```

This is not a request to obtain production credentials or create a production
clone. MaskDB cannot execute this SQL or share a transaction across gateway
requests. Missing access remains a controller-owned execution blocker.

The file sends 13 SQL statements: BEGIN, ten local settings, one aggregate
data/catalog SELECT and ROLLBACK. PostgreSQL enforces Repeatable Read READ ONLY;
the single SELECT covers the complete union of metadata and observed owners.
There are no row locks, write-intent table locks, temporary/persistent schema
objects or request/cron integration. Ordinary SELECT `ACCESS SHARE` relation
locks still conflict with exclusive DDL. `row_security=off` prevents a restricted
reader silently returning a policy-filtered population; relation configuration
is also reported.

Limits are 30 seconds per statement, 3 seconds waiting for a lock, 15 seconds
idle in the transaction, 16 MiB work memory per sort and a fixed hash-memory
multiplier of two (32 MiB per hash operation), no parallel
query workers, and JIT disabled. Work memory is not a whole-query memory cap:
multiple operators can coexist and PostgreSQL can spill to temporary files.
Do not raise limits after a timeout without reviewing a new measured plan and
execution environment. A timeout/error, missing row or unsuccessful psql exit
means incomplete evidence. Preserve the successful process exit alongside the
JSON receipt; no partial output is an accepted audit.

`historical_session_blob_references_v1` exposes scope, inventory revision,
transaction state/isolation, server version, observation/finish timestamps,
statement elapsed time, settings, cutoffs and completeness assumptions. It
contains no row IDs, hashes, paths, owner names or history contents. Catalog
drift reports `catalog_matches_inventory=false`; it invalidates completeness
without hiding the observed differences. Catalog agreement alone cannot detect
an unrecorded external writer or a new owner without a foreign key.

- `population` reports all blob rows, union/owned/shared hashes and owner
  multiplicity, including malformed hash values instead of dropping them.
- `conversations` distinguishes null, legacy-inline-only and hash-plus-inline
  history. A non-null hash owns one reference even when inline text also exists.
- `reconciliation` reports balanced owned hashes, missing metadata, negatives,
  undercounts, positive unowned counts and excess above all established owners.
  These are **overlapping observations**, not additive disjoint buckets. Missing
  metadata is reported separately from numeric undercounts.
- `unowned_zero_count_metadata` is consistent with preparation or fully released
  metadata. It proves neither a missed release nor object existence/GC safety.
- The 24-hour observation cutoff is calculated from the statement clock in UTC.
  Recent creation, candidate update/completion or an active/retryable candidate
  marks `recent_or_active`. Nonfinite timestamps are separately unknown. A
  conversation has no hash-replacement timestamp and blobs have no counter
  mutation timestamp: **older observed excess still has unknown provenance**.
- `candidate_only` preserves the original candidate audit's reconciliation
  predicates and integrity fields. Its strict old-source conjunction retains
  cutoff `2026-09-14T01:11:38Z`, with strict `<` comparisons, one candidate,
  no conversation, count two, absent source run and valid storage ownership.
  Both cutoffs are validated and visible. This is a state pattern, not deletion
  history, repair eligibility, a fixed subtraction or an allowlist. The existing
  candidate-only SQL remains unchanged and separately runnable.

## Verification and representative cost

Run from `turbo` with an authorized **test** PostgreSQL service:

```sh
pnpm -F @okouai/db test:historical-blob-audit
```

This dedicated PostgreSQL validator is included in `test:migration-consistency`.
It executes the actual psql file against the full current migrated schema,
compares unchanged rows/catalog, exercises shared aliases and archive-ID
collisions, missing conversation/candidate metadata, undercounts, negatives,
zero preparation, inline/null history, exact B cutoff boundaries, unknown time,
read-only DML/DDL/row-lock rejection, real DDL lock timeout, concurrent committed
ownership changes with repeated reads in one snapshot, and unknown-owner FK
catalog drift. It cross-checks candidate fields against the unchanged old audit.

Fresh MaskDB schema/index checks and seven separate aggregate requests at
**2026-09-15 03:46:13.720–03:46:20.717 UTC** measured 313,033 blobs, 277,197
conversations, 1,341 candidates, 33,068 storage versions, 18,194 storages,
282,658 runs and 71,876 sessions. They are separate gateway observations, not
one snapshot or a global anomaly inventory. No row contents were fetched.

The validator generates those cardinalities on the full migrated schema and
also creates 277,197 checkpoints and 71,876 conversation aliases. Version IDs
deliberately overlap blob hashes. The most expensive grouping population is
mostly distinct 64-character history hashes. It reports the real audit's
`EXPLAIN (ANALYZE, BUFFERS)` as a normalized numeric plan tree and a separate
synthetic receipt. Production row widths, cache residency, bloat, active writers,
provider storage and hardware can differ; synthetic timings are not production
latency or execution evidence.

Measured on local x86_64 PostgreSQL 18.6 at **2026-09-15 04:20 UTC**, with
128 MiB shared buffers and the script's exact limits:

| Measurement                             | Result                                                      |
| --------------------------------------- | ----------------------------------------------------------- |
| Planning / EXPLAIN ANALYZE execution    | 10.581 ms / 3,756.405 ms                                    |
| Subsequent ordinary audit statement     | 3,111.737 ms                                                |
| Top-level shared buffers, hit / read    | 7,669 / 10,056 blocks                                       |
| Top-level temporary I/O, read / written | 18,841 / 14,677 blocks (147.20 / 114.66 MiB at 8 KiB/block) |
| Largest reported hash memory / batches  | 21,210 KiB / 2                                              |
| Conversation sort disk space            | 26,600 KiB                                                  |
| Returned ordinary report rows           | 1                                                           |

The normalized [plan and synthetic receipt](./historical-session-blob-audit-cost.json)
are checked in. Buffer and temporary-I/O numbers are the top-level totals, not
sums of overlapping child nodes. Operator peaks are not whole-backend peak RSS;
shared buffers, multiple hash/sort operators and CTE materialization add costs.
Temporary bytes describe block I/O, not maximum simultaneous disk occupancy.

The actual plan scans/group-sorts conversations once (there is no history-hash
index), scans blobs once, hash-joins 18,194 storages to the small candidate cohort,
and performs 1,341 `agent_runs_pkey` index-only probes. Grouped owners merge before
the full blob join. Materialized owner/ledger results spill and are rescanned for
the different aggregates, explaining the temporary I/O. All synthetic audits
fit the unchanged 30-second statement limit. `idx_blobs_ref_count` cannot replace
a full-population join. No new index is authorized or needed by this measured
plan. Inspect the authorized production environment's plan and limits before
claiming the same cost there.

## Separately guarded repair design handoff

A later repair requires its own reviewed issue and production-write authority:

1. Revalidate the complete writer/owner/reader census at the actual serving and
   rollback revisions, plus the candidate retirement and forward deletion
   rollout floors. Exclude in-flight legacy writers using real drain evidence.
2. Obtain and independently review a successful current production dry-run
   receipt from a coherent snapshot. Resolve unknown ownership/provenance,
   recent work, invalid metadata and insufficient counts independently; do not
   convert these aggregates into a writable manifest or blanket correction.
3. For each separately justified adjustment, specify exact expected-before,
   independent-owner contribution, adjustment and expected-after counts.
   Revalidate metadata, every owner and concurrent-owner consistency inside the
   write transaction with a reviewed lock order. A historical snapshot is not
   a concurrency guard. Mismatch aborts the entire bounded unit.
4. Define an idempotency record or equivalent exact-state guard, bounded batch
   and statement/lock budgets, transaction rollback behavior and retry handling.
   Commit receipts must distinguish pending work from a durable correction.
5. Test races, retries, no-op repeat, failure rollback, shared owners and GC
   interlocks. Review the dry run and release/rollback plan before any write.

This PR authorizes none of that future repair, production SQL execution or
release work. Migrations 1121 and 1129 remain untouched.
