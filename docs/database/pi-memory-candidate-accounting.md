# Pi candidate reference accounting

Scope: [#33748](https://github.com/vm0-ai/vm0/issues/33748), preparation
[#33765 / #33774](https://github.com/vm0-ai/vm0/pull/33774), and retirement
[#33975](https://github.com/vm0-ai/vm0/issues/33975). Historical migrations remain
unchanged. The current schema has no candidate accounting trigger or function;
API C always accounts explicitly in the candidate lifecycle transaction.

## Ownership and ordinary locking

An actual inserted candidate retains its source once. A returned replacement
retains the new source and releases the locked old source once. An unchanged
source, exact retry, conflict or stale-source no-op changes no references.
Deletion releases only returned candidates, grouping equal hashes and updating
blobs in stable hash order with an adequate-count predicate. Missing blobs and
insufficient counts fail the whole transaction; partial retains, releases and
parent deletion roll back together. Other owners' references are preserved.

The canonical order remains **storage → candidate → blob**. Completion locks
an existing memory storage before checkpoint persistence and admission. Insert,
standalone cleanup and parent cleanup lock storage IDs in stable order.
Worker result commit locks its parent before its candidate and Phase 2 enqueue;
owner, hash, status, lease token and expiry fencing remain intact. The candidate
FK and transactional retain protect against premature blob GC, whose ordinary
write must recheck the count. Conversation multi-hash ordering and clamped
release semantics are outside this change.

C removes only B's temporary relation-lock/catalog decision and its accounting
branches. Ordinary DML still acquires its PostgreSQL relation locks; storage,
candidate row, worker and GC locks remain. Admission still checks persisted Pi
launch eligibility and the live owning user's `PiMemory` gate before reading
the source or writing a candidate.

## Writer and cleanup inventory

Re-audited on September 14 against `main@394a3c3615d2b2485646f50f718f6cb28fb48c71`,
then integrated `main@2cda87987eef35c4ae8fe75bad7c0b2dad1fff0d` after #33915 merged. Its billing migrations and
permanent inventory are preserved. Retirement is now migration 1121 after
Drizzle regeneration on `main@eb5e83ff1f4c9f65a3f56de5dae362ceedce26be` preserves #33911's Lark migration 1120.
The integration retains `main@737e752d859154f921d599412c5754ff262078e1`
and #33974: only human-interactive sources may enter admission, before the
existing live PiMemory gate and explicit C accounting.

| Path                                                                             | Ownership contract                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-webhook-complete.service.ts`                                              | Persists checkpoints under the canonical storage lock; daily scheduling owns production candidate admission after #34044.                                                                                                   |
| `pi-memory-stage1-schedule.service.ts`                                           | Daily decision selects at most two owned product Threads and calls canonical admission in the same transaction. Source Threads lock before Storage; day state locks before candidates.                                      |
| `pi-memory-stage1-candidate.service.ts`                                          | Admission, source replacement, returned-row retain/release, standalone candidate deletion, and parent storage deletion.                                                                                                     |
| `webhooks-clerk-cleanup.service.ts`                                              | User/org cleanup calls `deleteStoragesWithPiMemoryCandidates` inside the storage/candidate/reference transaction; external work stays outside.                                                                              |
| `webhooks-clerk.ts`                                                              | Cleanup remains asynchronous after HTTP 200. Failure needs investigation/provider redelivery; this is not a durable retry mechanism.                                                                                        |
| Stage 1 worker; Phase 2 job, maintenance and usage services                      | Status, output, lease, selection and usage updates only; no new source ownership. Existing fencing/parent locks remain.                                                                                                     |
| Candidate fixtures, Phase 2 fixture, `test-pi-memory-stage1-state.ts`            | Candidate insertion and parent deletion use the same canonical service. The Phase 2 cascade test also uses canonical parent deletion and checks the surviving reference; other fixture writes change status/selection only. |
| Workflow deletion, agent-instruction storage, registry sync and development seed | Their raw storage deletion targets custom-skill, instruction or system volumes, not canonical user-owned `memory`.                                                                                                          |
| Test system-storage/cache/catalog/usage cleanup                                  | Owns explicitly constructed system/usage fixtures, not a supported candidate repair writer.                                                                                                                                 |
| External migrations `006`, `007`, `008`, `015`                                   | Permanent historical records. `006` targets retired tables, `007`/`008` own skill volumes, and `015` builds version indexes. None is a current candidate repair command.                                                    |
| DB validators                                                                    | Historical baseline supplies the original function fingerprint. The transition validator replays the guarded migration; permanent schema inventory requires its absence.                                                    |

Use `insertPiMemoryStage1Candidates` for controlled fixture/repair insertion,
`deletePiMemoryStage1Candidates` for standalone retention, and
`deleteStoragesWithPiMemoryCandidates` for parent deletion. The caller owns the
transaction. No independent active production candidate backfill/repair writer
was found. Raw candidate source changes, raw memory-parent cascades and pre-B
repair tools are unsupported. For an actually deleted Clerk owner, redeliver its
provider deletion event to the current API. Do not infer permission to repair
production rows from this inventory.

Open overlaps at authoring were #33969 (Pi background model/worker tests) and
#33974 (candidate admission source gating). #33929, #33915, #33911 and #33756
also proposed new migration numbers; #33915 touches schema inventory. These
are inventory, not merge-order dependencies. #33915 merged during this work;
its new migration numbers initially required retirement number 1120. #33974
also merged; its source classification and route coverage are preserved. The
protected queue then detected an actual metadata conflict after #33911 consumed 1120. Integrating canonical main and regenerating retirement as 1121 preserves
that migration and leaves the guarded retirement SQL byte-for-byte unchanged.

## Historical B and the two-release boundary

The controller's [September 14 acceptance](https://github.com/vm0-ai/vm0/issues/33748#issuecomment-5660335068)
authorizes retirement authoring and protected merge. It records B at API 1.593.0,
artifact `0207460d4cdacbbbfaa67cd06999b80e1273a804`, deployment `6431060420`.
The accepted preparation merge is `cfdc9cd3c36cede429281e6f97ddf35a9ead2bef`.
Those are dated controller receipts, not fresh production verification by this
implementation. Release 1 is complete and must not be repeated.

B obtains a DML-compatible `ROW EXCLUSIVE` candidate relation lock, then checks
settings and catalog in independent READ COMMITTED statements. A B writer
waiting for retirement therefore sees the committed drop and accounts once;
a rollback leaves original-trigger accounting. B rejects unexpected trigger
configurations, non-origin replication and other isolation levels. Its original
function is never replaced underneath it. The test-only B insertion/decision
fixture preserves this supported transition without importing detection into C.

| API and schema          | Supported behavior                                                              |
| ----------------------- | ------------------------------------------------------------------------------- |
| B + original trigger    | Trigger owns references.                                                        |
| B + migrated schema     | B explicitly owns references; covers migration before C promotion and rollback. |
| C + migrated schema     | C explicitly owns references.                                                   |
| C + original trigger    | Unsupported: do not promote before migration commits.                           |
| Pre-B + migrated schema | Unsupported: no serving, continuation, direct repair or rollback eligibility.   |

Before release 2, the controller refreshes actual serving ancestry, canonical
API/Runner origin, eligible pre-B runs/queues and B rollback target. The accepted
B cutoff is `2026-09-14T01:11:38Z`; deployment success or quiet logs alone do not
prove drain. A separate release-only owner executes the authorized second
release after independent merge acceptance. Existing production-clone smoke
runs before real migration, which must commit before C traffic promotion.
A failed migration blocks C. If migration commits but C promotion fails, retain
or restore the verified B artifact; API rollback does not restore schema.

## Atomic retirement guard and receipt

Migration `1121_retire_pi_candidate_reference_trigger` is ordinary transactional
SQL under the unchanged runner's **1s lock / 10s statement** limits. Its journal
entry commits in the same transaction. It performs these operations:

1. A standalone statement acquires candidate `ACCESS EXCLUSIVE`. The following
   statement begins only after that lock is granted, with a new READ COMMITTED
   snapshot. Non-origin replication and unsupported isolation abort.
2. One SQL census checks catalog, every candidate's blob/storage existence,
   matching org/user, user-owned `memory` namespace, and exact candidate plus
   current-conversation ownership of each candidate hash. Related tables are
   read through MVCC only; there are no extra table or row locks.
3. The catalog must contain exactly one enabled original user trigger and one
   original public function: name, event/UPDATE column, absence of arguments,
   filters/deferral, signature, language, security/configuration/volatility and
   source MD5 `576154890be37fff1ec9f9f4c318428c` from `1078_baseline.sql`.
   Missing, renamed, extra, disabled or changed configuration aborts.
4. Valid balanced ownership passes. The sole allowed excess is the residual
   below. All missing/invalid ownership, shortfalls, negative counts and other
   excess fail with content-free errors. No reference count is changed.
5. Drop the named trigger, then its function, without `CASCADE` or `IF EXISTS`.
   Assert no candidate user trigger or named public function remains.
6. Emit `pi_candidate_retirement_v1` through PostgreSQL NOTICE and the existing
   postgres.js migration logging path. The JSON includes version, observation
   time/server version, integrity/reconciliation totals, separate residual
   count, expected pre-drop catalog counts and `post_drop_absent: true`.
   It contains no hashes, owner/run/row IDs or content.

The NOTICE deliberately says `transaction_status: pending_commit`. **A NOTICE
alone is not success.** Pair it with the successful real-production migration
job's subsequent `Migrations complete` (after the runner awaits atomic commit)
and journal frontier when accessible. Preserve separate clone and production
receipts. A post-drop statement or journal failure rolls back catalog/data;
an earlier NOTICE from that failed transaction proves no successful drop.

### Old-source deleted-run residual

[#33973](https://github.com/vm0-ai/vm0/issues/33973) separately tracks the
conversation deletion gap. A candidate hash may retain one excess reference
only if **all** of these are true in the audit snapshot:

- Exactly one candidate and an existing blob with `ref_count = 2`.
- Zero current conversations anywhere reference that hash.
- The candidate's source run is absent from `agent_runs`.
- Both candidate creation and source completion precede the fixed UTC B cutoff
  `2026-09-14T01:11:38Z` (the persisted timestamp columns store UTC).
- Storage existence, namespace and org/user ownership are valid.

Ten such hashes were observed by the controller. Ten is not a tolerance or
allowlist; classification is entirely by the conjunction above. It explains a
state pattern without reconstructing deletion history or dating the excess.
The migration preserves the ledger; subsequent candidate deletion releases
only one reference. One candidate plus one conversation at count two, or two
candidates at count two, are ordinarily balanced and pass. Negative fixtures
with additional owners retain a real excess (for example count three).

## Read-only diagnostic and verification

An authorized operator can run:

```sh
psql -X --set ON_ERROR_STOP=1 --dbname "$DATABASE_URL" \
  --file turbo/packages/db/scripts/audit-pi-memory-candidate-references.sql
```

This takes one Repeatable Read READ ONLY snapshot with 30s statement / 3s lock
limits, emits one aggregate row and rolls back. It uses the same candidate
integrity/reconciliation predicates and reports the catalog for either schema.
Before retirement, catalog counts should be 1/1/1; after retirement 0/0/0.
It does not reconcile unrelated global blob ownership or repair any data.
A timeout is incomplete evidence. Do not copy credentials into chat/runtime.

MaskDB does not expose `pg_catalog` or a snapshot shared across requests.
The controller's separate gateway observations are not this census. Exact
catalog and ownership checks are mandatory inside the migration; no new
endpoint, policy request or impossible separate catalog receipt is required.

Run `pnpm -F @okouai/db test:pi-candidate-trigger-retirement` for real migration
rollback, invalid configuration/ownership, residual and balance cases, fresh
post-lock snapshots, default timeouts and migration-log receipt delivery.
The validator uses synthetic metadata at **1,315 candidates / 310,578 blobs /
274,989 conversations** and reports elapsed time. It is included in
`test:migration-consistency`. That measurement does not substitute for the
release pipeline's production-clone smoke; clone timeout/drift blocks release
without relaxing guards or changing global timeouts.

Targeted API accounting, completion/admission, worker and Clerk tests cover C's
reference semantics, parent cleanup, feature gate, fencing and GC. B transition
coverage remains until the conditions in `turbo/packages/db/MIGRATIONS.md`
allow its retirement. Production acceptance belongs to the controller: capture
the real migration receipt/commit, actual C artifact and bounded data/log
observations before closing #33748.
