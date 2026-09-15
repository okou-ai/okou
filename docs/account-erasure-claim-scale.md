# Dormant account erasure claim scale

[B1-S #34204](https://github.com/vm0-ai/vm0/issues/34204) addresses the claim
gate in [the B1 foundation](account-erasure-foundation.md). It changes two
planner-visible predicates and generates migration 1130. It does not activate
an ingress, scheduler, worker, handler, or account deletion.

## Query and index contract

The old `(job_id, available_at, id)` index contains every work outcome. On an
unfinished job, an eight-item claim can scan arbitrarily many earlier terminal
rows. The deadline UPDATE has a separate subquery ordered by `id`.

The claim index now contains only `pending` and `retryable_failure`. A second
partial index `(job_id, id)` serves deadline selection. The predicate contains
only immutable state membership; neither index includes a moving time cutoff.
No row, proof, receipt, or terminal timestamp is rewritten by the migration.

Both actual queries keep their state predicate as the static SQL fragment
`state IN ('pending', 'retryable_failure')`. Other values remain Drizzle
parameters. The installed Drizzle 0.45.2 `node-postgres` session passes the
builder SQL and ordered parameters to `pg` 8.23.0. These operations do not call
`.prepare(name)`: the query config has an undefined name. `pg` uses the extended
protocol for parameterized queries, reparsing the unnamed statement on each
execution. It does not automatically promote this path to a cached named plan.

The baseline `inArray` binds both state values. A generic prepared plan cannot
prove those unknown values imply a partial-index predicate. The new literal
predicate remains visible even if a future caller names/prepares the query.
The scale check separately exercises `PREPARE` with `force_generic_plan`; no
scan type, index, cost, or `enable_*` setting is forced. This does not promise
all possible future prepared query shapes have the same plan.

The selected columns and runtime decoders, `clock_timestamp()` evaluations,
availability/id ordering, deadline id ordering, maximum eight items,
transactions, subject/job lock order, `FOR UPDATE SKIP LOCKED`, live-lease
eligibility and expiry, final CAS, retries, generation/capture isolation, and
B1-R receipt/abort behavior are unchanged.

## Reproducing the bounded check

Use a disposable local PostgreSQL database and the locked workspace dependencies.
From `turbo/packages/db`:

```sh
pnpm check:account-erasure-claim-scale \
  --migration src/migrations/1130_account_erasure_claim_scale.sql \
  --assert-bounded --output /tmp/claim-scale-after.json
```

`DATABASE_URL` must name that local database. The script creates a uniquely owned
schema from the shipped 1124 DDL, applies the supplied index migration with the
normal 1-second lock and 10-second statement timeouts, and drops only its own
schema in `finally`. Every statement has a 10-second budget. The largest fixture
contains 100,000 terminal plus 10,000 pending rows. It never reads business data.

To reproduce the original baseline, copy the check script into a detached
checkout at `3ace38cfefa54eb9df33715131a3ee8be1be3c27`, install the same locked
dependencies, and run it with `pnpm exec tsx scripts/check-account-erasure-claim-scale.ts
--output /tmp/claim-scale-before.json`, without the index migration or bounded
assertion. The claim source there is byte-identical to issue baseline
`8d01e1a9832cd0e73330d85e55709abe515acfe7`.

Each query is captured by the Drizzle logger while executing the real
`claimErasureWork` in a rolled-back transaction. The same SQL and ordered
parameters are passed to `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. The output
retains each complete plan, exact SQL, ordered parameters, environment, scans,
filters, buffers, sorts, and execution time. The deadline measurement explains
the complete UPDATE, including its selection subquery and target-row lookups.

The ordinary matrix has 16 ready items (eight pending and eight retryable) and
0/1,000/10,000/100,000 earlier mixed terminal/nonretryable items. These are
synthetic pressure levels, not production counts. Two real eight-item
claim/verification-completion batches then consume those 16 items without
changing their availability timestamps, followed by no-eligible checks in all
three branches. Large fixtures are confined to this explicit script, outside
ordinary Vitest collection.

Autovacuum is disabled only on the owned fixture table to make churn observable.
A separate read-only repeatable-read session pins an old snapshot while
100,000 pending rows transition to terminal outcomes. Claims still execute at
READ COMMITTED. Measurements distinguish the pinned snapshot, released snapshot
before vacuum, and completed `VACUUM (ANALYZE)`. Separate 10,000-item fixtures
measure eligibility filters, and a 100,000-terminal/10,000-pending case checks
the deadline ordering.

## Measured results (2026-09-15)

Primary paired run: PostgreSQL **17.11**, matching the development major version,
`plan_cache_mode=auto`, `random_page_cost=4`, `enable_seqscan=on`, fresh local
clusters and default planner costs. PostgreSQL 18.6 independently reproduced
the same terminal-prefix improvement. Timings are single warm local samples,
not latency percentiles or production performance. Buffers are total root
shared hits plus reads, not unique pages. Scanned rows below sum scan-node
outputs times loops plus filters; MVCC-invisible index visits require buffers
as an additional measure.

[Exact Drizzle SQL and ordered parameters](account-erasure-claim-sql.json) are
retained for the before/after queries. Full JSON EXPLAIN output is also included
in the implementation thread's evidence archive and can be reproduced with
the command above.

| Earlier terminal | Branch       | Scanned before → after | Filtered before → after | Buffers before → after | Execution ms before → after |
| ---------------: | ------------ | ---------------------: | ----------------------: | ---------------------: | --------------------------: |
|                0 | verification |                16 → 16 |                   0 → 0 |                  9 → 9 |               0.069 → 0.066 |
|                0 | inventory    |                16 → 16 |                   0 → 0 |                  9 → 9 |               0.097 → 0.059 |
|                0 | deadline     |                32 → 32 |                   0 → 0 |                32 → 88 |               0.228 → 0.300 |
|            1,000 | verification |              1,016 → 8 |               1,000 → 0 |                50 → 25 |               0.222 → 0.047 |
|            1,000 | inventory    |              1,016 → 8 |               1,000 → 0 |                50 → 25 |               0.232 → 0.103 |
|            1,000 | deadline     |             1,016 → 16 |               1,000 → 0 |              214 → 140 |               0.437 → 0.632 |
|           10,000 | verification |             10,016 → 8 |              10,000 → 0 |               425 → 25 |               1.795 → 0.043 |
|           10,000 | inventory    |             10,016 → 8 |              10,000 → 0 |               425 → 25 |               1.532 → 0.049 |
|           10,000 | deadline     |            10,016 → 16 |              10,000 → 0 |              656 → 169 |               1.843 → 0.258 |
|          100,000 | verification |            100,016 → 8 |             100,000 → 0 |             4,175 → 25 |              15.732 → 0.081 |
|          100,000 | inventory    |            100,016 → 8 |             100,000 → 0 |             4,175 → 25 |              15.612 → 0.050 |
|          100,000 | deadline     |           100,016 → 16 |             100,000 → 0 |            4,780 → 203 |              16.205 → 0.361 |

At 0 terminal rows the default planner uses a sequential scan and a 25–28 KiB
quicksort; no index is forced on a tiny table. At 1k/10k/100k the new ordinary
claim reads eight rows with no sort; deadline selects eight through the id
partial index and performs eight primary-key target lookups, with no sort.
The baseline verification/inventory sort only the 16 survivors but first
filter every terminal row. All 12 named/generic matrix cases also pass; at
1k/10k/100k their terminal filters are zero. No timing-speedup assertion is
used: small samples can be slower despite lower scan work.

A one-index experiment on PostgreSQL 18.6 failed the bounded gate: the generic
deadline plan filtered 1,000 terminal rows at the 1k level. With 100k terminal
and 10k pending, the default deadline plan still chose the primary key and
filtered 100,000 rows (4,727 buffers, 18.113 ms). With both indexes, the paired
PostgreSQL 17 large-pending case changes from 100,000 filtered / 4,753 buffers /
16.746 ms to 0 filtered / 163 buffers / 0.336 ms. This separate ordering evidence
is the reason for the second index.

After 100k directly inserted terminal rows, real completion batch 0/batch 1
use 14/18 buffers, versus 8,095/8,095 before. After both batches, no-eligible
verification, inventory and deadline each use one buffer and scan/filter zero
rows, versus 100,016 filtered rows before. The partial indexes retain pending
work rather than turning the eight-item limit into a table-size bound.

### Churn and residual eligibility costs

After 100k pending-to-terminal updates, all new-query terminal filters are
zero, but invisible old index entries still cost work:

| Snapshot / maintenance state | Verification buffers / ms | Inventory buffers / ms | Deadline buffers / ms |
| ---------------------------- | ------------------------: | ---------------------: | --------------------: |
| churn-pinned-snapshot        |            4,637 / 13.116 |         4,637 / 10.685 |         4,747 / 8.992 |
| churn-before-vacuum          |               629 / 0.659 |            629 / 0.560 |           739 / 0.796 |
| churn-after-vacuum           |                25 / 0.124 |             25 / 0.095 |           137 / 0.290 |

In this post-churn distribution PostgreSQL chooses the smaller deadline index
for regular claims and sorts 16 surviving rows (28 KiB). That bounded survivor
sort is acceptable. Vacuum reduces index traversal; it does not erase proof
rows. A pinned snapshot leaves thousands of page accesses and proportional
dead-entry cost even though `Rows Removed by Filter` is zero.

| Separate pending fixture | Remaining filtered rows | Buffers | Execution ms |
| ------------------------ | ----------------------: | ------: | -----------: |
| stale-generation         |                  10,000 |     808 |        1.583 |
| stale-revision           |                       0 |      28 |        0.084 |
| live-lease               |                  10,000 |     584 |        2.754 |
| future-retry-no-eligible |                  10,016 |     572 |        2.424 |
| inventory-mismatch       |                  10,000 |     825 |        1.809 |
| inventory-complete       |                  10,000 |     825 |        1.265 |

These residual fixtures contain 10,000 ineligible pending rows and 16 ready
items; the future-only case moves all 10,016 into the future. Stale capture
revision happens to use the existing capture index, while stale generation,
leases and inventory mismatches still need filtering. These are disclosed
limits, not claimed fixes for a scheduler.

### Correctness and migration verification

- 60 targeted real-PostgreSQL persistence/selector tests pass on both 17.11
  and 18.6. Existing concurrent lease, CAS, generation/revision, receipt,
  deadline/abort, capture, proof and retirement tests remain intact. New tests
  cover availability/id ordering, default eight-item batches, active leases,
  actual retry delay/reclaim and repeated deadline escalation in id order.
- The actual captured old and new SQL was replayed against the original and
  migrated schema on PostgreSQL 17: all four code/schema combinations return
  the same rows and work-state effects in verification, inventory and deadline
  (12 executions, eight selected/updated items per execution).
- Full `test:migration-consistency` passes on PostgreSQL 17, including schema
  regeneration/comparison, latest snapshot accuracy, normal timeout tests and
  consecutive reset/replay. The isolated schema/reset/replay validator also
  passes on 18.6. The full command on 18.6 stops at the unchanged SSH RESTRICT
  validator (`23001` instead of its expected `23503`); no assertion was changed.

## Rollout and remaining gates

The issue records a read-only production count of **zero work rows at
2026-09-15 02:36:07 UTC**. This source-derived risk is not an observed production
slowdown. The empty dormant table supports a normal transactional index rebuild
with no data backfill or timeout override. Recheck this premise before an
independently authorized release; unexpected growth or lock timeout requires
fresh sizing, not a longer timeout in this implementation thread.

Migration 1124 and its metadata stay unchanged. Drizzle generates the next
available migration and metadata; 1130 is not a reserved ordering claim against
other PRs. The normal runner rolls back a failed index rebuild and journals only
the committed migration. Schema comparison and reset/replay retain their normal
gates.

Old API SQL remains legal after migration: no columns, constraints, result
shapes, or work outcomes change. The new SQL is also legal before migration,
although it retains the old scan cost until the indexes exist. Normal production
deployment still migrates before API promotion. Neither outgoing nor new API
has a production caller for these dormant operations; no feature switch or
compatibility fallback is introduced.

This is not constant-time scheduling. Pending stale generations/revisions,
active leases, unavailable retries, inventory kind/capture mismatches and dead
index tuples retain distinct costs. The capture index can eliminate a stale
capture revision in the measured distribution, but arbitrary distributions are
not covered by that observation. A volatile database-clock availability filter
can scan all future retries when none is ready. Partial-index membership changes
also add index maintenance and prevent state transitions from using HOT updates.
Long snapshots can prevent vacuum from reclaiming the old entries.

Controller acceptance, separately owned release and production index readback,
B2/G2d1 activation requirements, billing isolation, domain handlers, recovery
evidence and H's complete-chain fault/scale gate remain open. The implementation
owner stops at protected-queue merge.
