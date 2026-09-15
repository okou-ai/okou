# Conversation history deletion accounting

This is the forward-only fix for [#33973](https://github.com/vm0-ai/vm0/issues/33973).
The implementation census starts at `2d18df55c4a751a296808d8393a2e77241b54641`
and was revalidated after integrating `5b5de1c241` to resolve a real migration
number collision. Drizzle regenerated this change as migration 1129.
It does not repair historical excess references, change checkpoint replacement,
or change the accepted candidate trigger retirement in #33748.

## Ownership and transaction boundary

A hash-backed conversation owns one blob reference. A Pi candidate independently
owns another; its `source_run_id` has no run foreign key. Removing the source run
therefore releases only the conversation contribution. Null/legacy-inline
history releases nothing.

`conversation-history-deletion.service.ts` requires locked target runs. It deletes
their conversations with a builder `DELETE ... RETURNING` CTE and groups the
actual removed rows by hash. The caller then completes run/parent cascades and
storage mutations. Finally, the same transaction releases the grouped counts
with `ref_count >= release_count`. A missing blob, insufficient count, lost
locked run, or later transaction failure rolls everything back. No-op deletion
produces no release. There is no pre-delete count used as accounting evidence.
Every target blob must exist in the actual lock result; another owner's later
INSERT cannot stand in for a missing historical retain at UPDATE's new snapshot.

The transaction returns only numeric counts. Its caller logs `Conversation
history deletion committed` at info level **after** the transaction promise
resolves, with `source`, `deletedConversations`, `releasedReferences`, and
`releasedHashes`. Rollback cannot emit that receipt. No deleted row means no
receipt, so a quiet window is not proof of runtime acceptance. Existing error
boundaries report failures; helper database errors retain only SQLSTATE because
Drizzle otherwise includes hashes in SQL parameters. Accounting mismatch errors
contain no identifiers, hashes, or conversation content.

Axiom drops debug events at its transport threshold. The existing lint mechanism
therefore allows this exact info message in this one helper; the general info
logging rule remains enforced. Receipts are bounded by committed deletion
transactions (at most 20 in a threadless sweep), not by reads or empty sweeps.

## Production census

| Entry                                                                       | Accounted deletion scope                                         | Preserved behavior                                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `threadless-run-cleanup.service.ts`                                         | The revalidated, locked run                                      | 20-candidate sweep, cancellation recovery, callback blockers, usage drain and Phase 2 maintenance ownership  |
| `agent-deletion.service.ts`                                                 | Every run under the locked agent's sessions                      | Permissions, default-agent guard, active-run rejection, canonical agent lock and existing conflict responses |
| `agent-lifecycle.service.ts`, called by `webhooks-clerk-cleanup.service.ts` | UNION of directly scoped runs and runs under locked owned agents | Clerk user/organization lifecycle, indirect cross-user cascades, external cleanup sequencing                 |

There is no independent production session-delete endpoint. Agent deletion
cascades through sessions and runs. Clerk's union deduplicates direct/indirect
overlap and includes a different user's run under an owned agent. It deletes
only the frozen locked run set and revalidated owned agents, not a later broad
ownership predicate that could consume an unaccounted concurrent insert.

Agent/session parent locks stop FK child inserts before discovery. Run locks
serialize conversation creation/replacement. Foreign keys still implement
session `SET NULL`, conversation/checkpoint deletion, and the remaining parent
cascades. S3, Clerk, subscriptions and other external cleanup stay outside the
database transaction.

### Exclusions and their actual gates

- `test-{teams,usage,computer-use,telegram,pi-memory-stage1,slack,cron-cleanup-sandboxes,cron-monitor-chat-event-queue}-state.ts`
  call `isTestEndpointAllowed`. It allows development and authorized preview
  requests and rejects production. These reset/source-deletion endpoints are not
  production lifecycle callers. The cron checkpoint fixture now requests real
  checkpoint-capable mounts; it does not manufacture reference counts.
- `test-fixtures/chat-events.ts` and `test-fixtures/legacy-default-agent.ts` have
  test consumers, with production fixture imports forbidden by repository lint.
  The shared `test-fixtures/run-deletion.ts` now uses the transaction helpers so
  concurrency fixtures cannot silently bypass accounting.
- `src/scripts/dev-bench-seed.ts` is an operator development script with a local
  hostname allowlist. `DEV_BENCH_SEED_ALLOW_NON_LOCAL=1` explicitly overrides that
  gate; it is not unconditionally production-safe and is not a production
  deletion entry point.
- `packages/db/scripts/test-billing-attribution.ts` creates its own temporary
  schema and sets `search_path` before deleting synthetic runs.
- Direct deletes in test suites belong to isolated fixtures. The candidate
  accounting suite uses per-test schemas with the real relevant FK definitions.

## Lock composition and overlap

Existing checkpoint and combined-completion admission use checkpoint advisory
ownership and a run row lock; combined completion also owns its chat-thread
boundary. Checkpoint persistence can retain a blob before promoting the session.
Candidate cleanup takes storage ownership before releasing candidate references.

Agent deletion retains canonical mutation advisory -> agent -> sessions -> runs,
with existing NOWAIT and 100 ms behavior. Clerk revalidates agents after canonical
mutation ownership, then locks sessions and the deduplicated run set in ID order,
retaining its 100 ms lock timeout. Threadless cleanup retains its run and Phase 2
maintenance barriers. The new helper never acquires the checkpoint advisory lock
after acquiring the run.

All parent cascades and storage mutations finish before blob release. Hashes are
sorted globally and locked in that order. Blob locks use `FOR UPDATE NOWAIT`:
a checkpoint on a _different_ run can already hold a shared blob and then wait
for a surviving session locked by deletion's `SET NULL`. Waiting for that blob
would reverse the session/blob order. NOWAIT aborts deletion with SQLSTATE 55P03
and preserves the existing conflict/retry boundary instead of enlarging a
timeout. Deterministic tests exercise this exact checkpoint operation with
transaction gates and observed database blocking, then verify a successful retry.

In-flight old deletion code can still leak until it drains. It cannot make the
new helper decrement twice: run locks and actual removed rows arbitrate ownership.
Candidate cleanup remains independent of source-run deletion. The census found
no production blob-deleting GC implementation; tests cover transaction visibility
with a zero-count GC delete and the existing candidate FK protection, not a
claimed production GC job execution.

## Query bounds and measured cost

The helper batches 500 run IDs per conversation CTE and run delete, aggregates
hash multiplicity across all batches, then locks/releases 500 distinct hashes
per batch. Release uses one JSON parameter with `jsonb_to_recordset` and guarded
`UPDATE ... FROM`; it does not issue one query per conversation or hash. Each
helper query has at most 500 scalar parameters (release has one). At 64-character
hashes, a 500-hash release parameter is about 50 KB. Memory is proportional to the
target run/hash set; the transaction remains atomic across batches.

Clerk discovery uses indexed user/org predicates UNION indexed owned-session
lookups, then primary-key run locks. Agent IDs use one UUID-array parameter;
session IDs stay in SQL subqueries rather than an unbounded placeholder list.

Local synthetic PostgreSQL 18 measurements on 2026-09-15 used 282,246 runs,
71,721 sessions, 276,822 conversations (276,693 hash-backed), 276,822 checkpoints,
and 312,649 blobs. Counts mirror the issue's scale, not private production data.
The real helper ran inside rollback transactions with the relevant actual FKs.
These single-host measurements are cost evidence, not production latency targets.

| Target runs / distinct hashes | Statements including BEGIN, run lock, ROLLBACK | Elapsed    |
| ----------------------------- | ---------------------------------------------- | ---------- |
| 20 / 20                       | 7                                              | 98.4 ms    |
| 500 / 500                     | 7                                              | 182.2 ms   |
| 5,000 / 5,000                 | 43                                             | 1,088.2 ms |

The benchmark's initial run lock used its explicit synthetic ID list; production
Clerk discovery uses the bounded scope/subquery shape above. The 5,000-target
helper statements still each stay within 500 parameters. A representative Clerk
UNION selected 321 direct/indirect runs in 59.9 ms using scope, session and run
indexes.

Captured Drizzle SQL re-executed with `EXPLAIN (ANALYZE, BUFFERS)` for 500 targets
used the run primary key, unique conversation-run index and blob primary key:
conversation CTE 12.0 ms, run deletion 6.4 ms, blob lock 2.2 ms, guarded release
7.9 ms. There were no temporary blocks. FK session-nullification and checkpoint
cascade probes used the new indexes.

### Necessary additive index migration

The schema originally lacked `agent_sessions(agent_id)`,
`agent_sessions(conversation_id)` and `checkpoints(conversation_id)` indexes.
At the scale above, representative probes scanned 71,721/276,822 rows and took
7.2/5.7/29.2 ms respectively; a cascade repeats these probes for every removed
conversation. With the indexes, the same probes took 0.15/0.24/0.21 ms and
12/3/5 shared buffers. This measured FK amplification requires three additive
indexes beyond the initially proposed API-only scope.

The Drizzle-generated migration builds them concurrently with bounded lock and
statement timeouts. Its explicit nontransactional restart first drops only its
own new index names concurrently, recovering partial/invalid builds. It changes
no columns, foreign keys, triggers, public API contracts or historical counts.
Schema comparison verifies the generated snapshot/journal and complete replay.

Old API SQL remains valid after the indexes are installed. New API SQL is
structurally valid before migration, but the indexes must be present before
promotion for the bounded-cost guarantee. This is an ordinary additive migration
before API rollout, with no dual writer or ownership switch. Rolling back the
API retains valid decrements and the indexes, and resumes the old missed-release
behavior. Existing candidate retirement rollback floors still apply.

## Verification and ownership handoff

Targeted ledger tests cover 2 -> 1 -> 0 independent ownership, run/session/agent
cascades, shared hashes across batches, survivors, inline/null history, no-op,
missing/insufficient ledger rollback, late failure, candidate contention and GC
visibility. API tests use actual Agent deletion, verified Clerk webhooks,
checkpoint/combined-completion and threadless sweep. Existing Agent interlock,
Clerk, browser and cron regressions cover neighboring lifecycle behavior.

Local validation limitations: four expanded browser/Clerk/storage regressions
fail before deletion with `Job not found in queue`, identically on the unchanged
base checkout. The new API scenarios pass. The full migration-consistency command
stops in unchanged SSH credential coverage because PostgreSQL 18 emits `23001`
for `ON DELETE RESTRICT` while that test expects `23503`; the same failure occurs
on the base checkout. All other migration-consistency components, including the
final complete schema comparison, pass separately. Required PR and merge-group
CI remain the authoritative repository gates; neither limitation is suppressed
by changing tests or checks.

Implementation ends at protected merge. The controller owns independent merged
code acceptance, release coordination, serving-artifact/drain evidence and
production observation. Quiet logs or successful release alone do not establish
runtime accounting coverage. Existing excess references remain for a separately
designed historical-repair task; this change does not reinterpret the 10/13 cohort
or edit the exact guarded candidate-retirement conditions.
