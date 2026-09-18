# Subscription SQL coordination experiment (#35234)

The final candidate removes one SQL statement per locked snapshot. Local
measurements show **higher wall-clock latency in every measured stage at p50**.
This is a measured statement-count reduction with local client/server overhead,
not a demonstrated latency improvement. Production stage and API-to-queue
improvement remain unverified.

The candidate batches the provider and ordered account inventory within each
existing locked snapshot. A locking provider subquery supplies the parent ID to
a correlated `LEFT JOIN LATERAL` account subquery, which sorts and locks the
base account rows. The advisory wait remains a separate completed statement.
Singleton secrets and account secrets retain fresh subsequent statements.
Account authority, whole-snapshot comparison and final admission proof remain
unchanged.

## Scope and reproduction

This finite local experiment measures the exported capture, fresh preparation
and locked validation services. Its exact environment measurement calls the
same initial account lookup and coordinated read as the private environment
resolver, excluding subsequent environment/firewall assembly. It does not
measure a complete HTTP request, final admission lifecycle locks, queue insert,
OAuth, KMS, production network latency or API-to-queue latency.

From `turbo`, after preparing the locked dependencies and migrating a local
development database:

```sh
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
AXIOM_TOKEN_SESSIONS=synthetic AXIOM_TOKEN_TELEMETRY=synthetic ENV=development \
pnpm -F api exec dotenv -e .env.local -- \
  tsx src/scripts/bench-subscription-coordination.ts
```

The script rejects nonlocal hosts and nondevelopment environments. It creates
one UUID-owned provider and active connected account per provider type. Pass
`--inventory=10` to include nine additional inactive connected accounts and
their complete secret bundles; run the same mode on both revisions. This
bounded larger inventory exposes provider-row duplication and ordering costs.
Claude uses `authMethod: null` and one secret field; Codex uses `auth_json` and
four secret fields per account. The active canonical and mirror stores contain
identical, deliberately unusable synthetic cells, exercising the coherent path
without external decryption or identity requests. Cleanup deletes only the
exact synthetic owner/provider and its dependent rows. SQL parameters and
credential cells are never printed.

Each of six stages has fifty warm-up operations and one hundred measured
sequential operations. Measurements include transaction completion. SQL counts
exclude BEGIN/COMMIT; transaction-control counts are reported separately. The script
reports complete stage p50/p90, summed nonadvisory SQL durations, advisory wait
plus round-trip duration, and client-observed lock-held time. It also reports
all SQL span time and the remainder outside those spans, calculated within each
sample before summarizing. That remainder includes query construction,
decoding and other client work; it does not measure CPU directly. The fresh
proof also reports its production snapshot and bundle-proof timing actions.
These nested percentiles must not be summed into an end-to-end latency estimate.

After the preparation samples, the harness replays the captured read statements
under the same advisory transaction and obtains `EXPLAIN (ANALYZE, BUFFERS)`.
It emits parameterized statement order and a reduced execution plan containing
node/relation/index names, sorting, rows and buffers. Filters and index
conditions are omitted because PostgreSQL substitutes bound values there.
EXPLAIN execution is outside measured samples and rolls back its locks.

Use the identical harness and fixture shape in sequential baseline/candidate/
candidate/baseline order for each inventory size, against baseline main
`5db7365a036798df6f7d7b9ea0ee7ee2e0cd5921` and the candidate. Numeric per-sample
observations support pooled percentile calculations across the two runs of each
revision; do not average or subtract separately calculated percentiles. The
environment record includes source revision, dirty-worktree status, service/harness/lockfile
SHA-256, Node and PostgreSQL versions, pool size and repetition counts. A dirty
measurement checkout requires the service digest to identify the tested source.
Do not run a heavy checker or another benchmark concurrently.

## Observed coherent statement counts

| Fragment                            | Baseline | Candidate |
| ----------------------------------- | -------: | --------: |
| Concrete-account capture            |        6 |         5 |
| Null-logical capture                |        6 |         5 |
| Explicit-logical capture            |        7 |         6 |
| Exact environment database fragment |        6 |         5 |
| Fresh admission snapshot/proof      |        5 |         4 |
| Final locked validation             |        5 |         4 |

A normal four-fragment path therefore changes from 22 to 18 statements, or
23 to 19 with explicit-logical capture. Every measured sample matched these
counts for both providers and both inventory sizes. Each fragment also had
exactly two transaction-control statements. Exceptional seeding, legacy import,
metadata reconciliation and retries have additional statements.

## Concurrency interpretation

The preceding advisory statement sees a winning canonical writer's commit
before the batched statement starts. The correlated account subquery depends
on the locked provider and locks actual account rows in ID order. Historical
Codex identity hydration can update account metadata after its seed transaction; locking the
base rows returns their current READ COMMITTED tuples. Historical Claude
singleton writes and independent ciphertext rotation retain the later fresh
secret statements. A provider deletion still removes its account authority.

Execution plans can substantiate the dependency and lock/sort nodes; they do
not replace the HTTP regression cases for concurrent writers, deletion,
historical imports and admission revalidation. Local timing differences do not
establish production gains. A matched deployed production cohort remains
necessary for stage and API-to-queue claims.

## Measured results

Final runs on September 18, 2026 used Node v24.21.0, PostgreSQL 18.6, pg 8.23.0,
Drizzle 0.45.2 and a pool maximum of two. Baseline and candidate ran sequentially
in ABBA order for each inventory size, without concurrent heavy checks. Each
table cell pools the two runs' 200 raw observations and reports **p50 / p90 in
milliseconds**, including transaction completion. Both checkouts reported the
baseline HEAD with local changes; service digests identify the measured code.

- Baseline service SHA-256: `e3c3f58010d6c22730ce28fd4ec60f8611dd9e9aff48ec20a0f9944f528be0ca`.
- Candidate service SHA-256: `0b8e0e3c3a87debce23d942f34f91234720a382beeb97b3a3e0d7a0ea0f84d21`.
- Identical harness SHA-256: `e22e7d050b17427a0dff3f0c5614e63534090f7dea6d429fdc7a3951ace728f6`.
- Lockfile SHA-256: `e72000f6e8d5fd9da88517390e073a7d40739bd868010e61b8dba5d7b266b79e`.

Inventory of one active connected account:

| Provider | Fragment                 | Baseline p50 / p90 | Candidate p50 / p90 |
| -------- | ------------------------ | -----------------: | ------------------: |
| Claude   | Concrete capture         |      3.410 / 5.128 |       4.493 / 6.015 |
| Claude   | Null-logical capture     |      2.794 / 4.368 |       4.401 / 5.418 |
| Claude   | Explicit-logical capture |      2.618 / 4.365 |       5.152 / 6.137 |
| Claude   | Exact environment DB     |      1.939 / 3.072 |       4.203 / 5.141 |
| Claude   | Fresh proof              |      1.649 / 2.101 |       3.397 / 4.060 |
| Claude   | Final validation         |      1.783 / 2.668 |       3.564 / 4.292 |
| Codex    | Concrete capture         |      2.914 / 4.541 |       4.201 / 4.925 |
| Codex    | Null-logical capture     |      2.234 / 3.807 |       4.101 / 4.737 |
| Codex    | Explicit-logical capture |      2.792 / 4.837 |       4.793 / 5.468 |
| Codex    | Exact environment DB     |      2.105 / 3.596 |       4.040 / 5.016 |
| Codex    | Fresh proof              |      1.675 / 2.161 |       3.392 / 4.182 |
| Codex    | Final validation         |      1.637 / 2.304 |       3.313 / 4.075 |

Inventory of one active and nine inactive connected accounts:

| Provider | Fragment                 | Baseline p50 / p90 | Candidate p50 / p90 |
| -------- | ------------------------ | -----------------: | ------------------: |
| Claude   | Concrete capture         |      4.266 / 5.970 |       4.974 / 6.425 |
| Claude   | Null-logical capture     |      2.348 / 4.315 |       4.376 / 5.441 |
| Claude   | Explicit-logical capture |      2.665 / 4.930 |       4.868 / 6.158 |
| Claude   | Exact environment DB     |      2.382 / 4.327 |       4.300 / 5.179 |
| Claude   | Fresh proof              |      2.107 / 3.973 |       3.672 / 4.322 |
| Claude   | Final validation         |      1.738 / 2.298 |       3.613 / 4.323 |
| Codex    | Concrete capture         |      2.083 / 4.453 |       4.224 / 4.925 |
| Codex    | Null-logical capture     |      2.145 / 4.564 |       4.418 / 5.112 |
| Codex    | Explicit-logical capture |      4.169 / 6.308 |       4.717 / 5.506 |
| Codex    | Exact environment DB     |      2.194 / 4.128 |       4.381 / 5.341 |
| Codex    | Fresh proof              |      2.217 / 4.024 |       3.881 / 4.838 |
| Codex    | Final validation         |      2.254 / 3.644 |       3.853 / 4.550 |

The client remainder outside SQL spans increased too: for a one-account fresh
proof its p50 was 0.597 to 0.996 ms for Claude and 0.610 to 1.028 ms for Codex.
These are percentiles of per-sample remainders, not subtraction of the table's
percentiles. Unchanged advisory and secret statements also varied between
runs, so the entire latency difference cannot be attributed to query building.
A separate CPU-profiled probe found additional Drizzle entity checks and SQL
construction; its timings are excluded because profiling changes execution.
Dependency versions and the instrumentation/environment source matched across
checkouts. The data supports the count reduction and added local overhead;
it does not establish the outcome over a production database network.

## Plan evidence

Each final candidate plan uses an outer sort over a nested loop. Its first
subquery has `LockRows` over the provider index scan. The correlated account
subquery has `LockRows` over `Sort(model_provider_accounts.id)` over the
account index scan. Thus the account rows are sorted before their locks are
acquired, and the account scan consumes the already-locked provider. The outer
sort preserves deterministic returned inventory order. Static aliased schema
columns retain the complete row decoders while reusing selection metadata.

In the first candidate run for each inventory, provider/account shared-buffer
hits were eight for one account and eighteen for ten, with zero shared reads.
The matching baseline's separate statements used eight and seventeen/eighteen
combined hits. The candidate returned one/ten rows with the provider repeated;
neither underlying table scan repeated. Observed combined-query planning time
was 0.128–0.168 ms and execution time 0.099–0.119 ms; the corresponding baseline
statements summed to 0.094–0.138 ms planning and 0.081–0.091 ms execution.
These single EXPLAIN observations describe plan cost, not stage distributions.

Raw records are preserved as `verified-abba-inventory{1,10}-{a1,b1,b2,a2}.jsonl`
in the local issue research directory. Each contains source identifiers,
numeric observations, all six stage summaries, parameterized statement order
and reduced plan trees. CPU-profiled and earlier exploratory runs are excluded
from the reported final tables.
