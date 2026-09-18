# Incomplete chat context

Direct web sends and queued callback sends share
`loadWebChatIncompleteContext`. It carries failed, cancelled, and timed-out
rounds that are absent from the resumed CLI session. A run whose result has a
string `agentSessionId` remains the successful-history boundary, including when
its terminal chat events have not finished materializing.

## Ordering and visibility

Each run is ordered by its first retained physical run-owned event. Later
output, terminal, follow-up, usage, and active-input events cannot move that
position. `control.interrupt` refers to its target run and does not establish
ownership. Revoked events still establish ordering; the separate visibility
predicate determines whether the run has visible history and which content can
be included. Historical `input.goal` rows provide no queue or execution
authority.

The reader walks at most 21 candidate runs in one recursive SQL statement and
stops querying older anchors as soon as it reaches a successful run. Each step
seeks below the previous anchor's sequence. It retains up to 20 subsequent
incomplete runs, then loads all visible text for those run IDs. There is no
event-sequence cutoff based on the last event of the successful run: that event
can arrive after a newer user input.
Rounds render in their selected order, with events ordered by sequence within
each round. Existing prompt projection and 4,000-character truncation remain
unchanged.

Within each step, the backward physical-event scan joins a lateral aggregate
of the run's earliest retained owned sequence. The aggregate is scoped to the
same thread and grouped by run ID. The candidate sequence is compared with
that minimum **outside** an ordered `OFFSET 0` subquery. This boundary lets
PostgreSQL reuse the minimum through a run-ID-only Memoize entry instead of
performing an earlier-event probe for every output event. Run eligibility is
checked before computing minima; visibility applies to surviving anchors.
The cache belongs to query execution; there is no application or cross-request
history cache.

Both query details matter. Moving the equality inside the subquery can put the
candidate sequence in the parameterized work and lose reuse. Omitting the
grouping lets MIN/MAX optimization choose a forward thread-sequence scan,
examining unrelated older runs before finding a recent run's first event.
Run eligibility stays inside the lateral lookup: putting its join directly in
the physical candidate scan can introduce a hash join and full-history sort
before the caller's limit, defeating early termination.
The installed Drizzle version omits `.offset(0)`, so this planner boundary uses
a small SQL wrapper around the typed candidate builder. It is not a result
limit or permission boundary.

The reader still examines physical tail events to find interleaved run anchors;
jumping directly to a seen run's first event would skip other runs. Dense
histories therefore remain more expensive than sparse histories, and planner
statistics and available memory still affect reuse. No new index is required
for this access path.

## Compatibility and retained history

This is a query-only change. It adds no schema, API, Runner, frontend, or writer
contract. It does not require the newer initial-claim identity convention
`event.id = run.id`, so old and copied event identities remain readable.

The reader continues to use the hot event table. Once archival retention
removes an old first event, the earliest retained coordinate can change; wholly
archived prompts are not recovered by this reader. This change guarantees
stability against later appends while that retained ordering history exists,
not a permanent admission coordinate across archive compaction. Extending that
contract requires canonical archive reconstruction or a durable run coordinate
with a historical backfill and rollout plan.

## Verification

`chat-callbacks.bdd.test.ts` gates the external recommended-followup response to
establish both input-before-late-success-before-failure and
failure-before-late-success sequences. Direct and queued sends must preserve
the failed prompt and attachment in both cases. Separate tests append output
to an old failed run after a later success and after 20 newer incomplete runs;
that output must neither resurrect the run nor consume a newest-20 slot.

Existing coverage retains revoked follow-ups, structured messages, truncation
and session continuation. `chat-events-history.test.ts` waits for the public
terminal event when setup requires a materialized successful anchor.

The candidate limit bounds selected rounds and subsequent text retrieval, not
the number of physical rows an index scan can examine. Long-thread plans must
be checked against `chat_events_thread_seq_unique`, `idx_chat_events_run_id`
and the revocation index; a full-history aggregate or sort must not be assumed
cheap because its output has a LIMIT.

### Matched grouped-query study (#35236)

On September 18, 2026, the original service at
`5db7365a036798df6f7d7b9ea0ee7ee2e0cd5921` was compared with service blob
`e8459e02f7e9835bfabefba597642ec4df41b574`. PostgreSQL 18.6, Node 24.21.0
and Drizzle 0.45.2 ran with `work_mem=4MB`, Memoize and JIT enabled, automatic
plan-cache mode and 128 MB shared buffers, against isolated synthetic tables with the
existing thread/sequence, run-ID, revocation and terminal indexes. Each shape
was vacuumed/analyzed, warmed, then measured in 20 alternating old/new
executions with bound parameters and unnamed statements. Both services used
their actual builders, database execution and formatting; only the old
module's import paths were relocated for the experiment. All 73 ordered
frontier parameters remained identical.

The normal fixture has 10,000 runs, 40 events per run (one prompt followed by
thinking events), and 30 failed runs at the tail. Dense variants append the
specified number of `usage.recorded` events to the latest run. Run/event IDs
are distinct deterministic UUIDs. The late-old variant appends to successful
run 9,000. The early-stop case has 20 older successful runs with 10,000 events
each and a latest success with only two events. Sparse fixtures have two
events per run; the foreign-history variant places 400,000 events in another
thread. These are matched history shapes, not production traffic samples.

Frontier query latency includes local driver/database planning and execution;
values below are **p50 / p90 in milliseconds**. Buffer hits come from a separate
`EXPLAIN (ANALYZE, BUFFERS)` execution and count accesses, not unique pages.
All recorded final plans had zero shared reads.

| History                                |    Old frontier | Grouped frontier | Shared hits, old → grouped |
| -------------------------------------- | --------------: | ---------------: | -------------------------: |
| Normal 400k events                     |     3.90 / 4.09 |      2.68 / 2.95 |                3,667 → 454 |
| +10k latest failed                     |   33.53 / 33.88 |      7.00 / 7.41 |               43,989 → 776 |
| +10k latest successful; empty context  |   31.63 / 32.50 |      6.25 / 6.58 |               40,497 → 344 |
| +100k latest failed                    | 153.22 / 156.08 |    40.34 / 41.11 |            406,919 → 3,706 |
| +100k latest successful; empty context | 150.52 / 154.10 |    39.54 / 40.22 |            403,427 → 3,274 |
| +100k latest running; skipped          |   25.27 / 25.96 |    23.55 / 23.95 |              5,496 → 2,283 |
| 10k late events from old success       |   32.18 / 32.36 |      7.00 / 7.29 |               43,857 → 789 |
| Latest success 2 events; older 200k    |     1.91 / 2.09 |      1.86 / 1.96 |                    20 → 14 |
| 20 sparse runs, tiny tables            |     2.07 / 2.34 |      2.31 / 2.49 |                  128 → 199 |
| 20 sparse runs, foreign 400k history   |     2.56 / 2.67 |      2.35 / 2.62 |                1,132 → 783 |
| +10k latest events, all revoked        |   43.40 / 43.70 |    17.60 / 18.27 |            64,562 → 21,196 |

Full `loadWebChatIncompleteContext` latency includes builder construction,
the frontier, selected visible-text retrieval when needed, and formatting.
It is measured separately from the frontier query, the surrounding prompt
context stage, API-to-queue, and the parent's API-to-spawn metric:

| History                              | Old reader p50 / p90 (ms) | Grouped reader p50 / p90 (ms) |
| ------------------------------------ | ------------------------: | ----------------------------: |
| Normal 400k events                   |               6.57 / 6.86 |                   5.70 / 5.89 |
| +10k latest failed                   |             40.71 / 41.30 |                 14.09 / 14.49 |
| +10k latest successful               |             32.53 / 33.20 |                   7.37 / 7.68 |
| +100k latest failed                  |           180.82 / 182.37 |                 68.49 / 73.08 |
| +100k latest successful              |           153.64 / 170.64 |                 41.42 / 45.99 |
| +100k latest running                 |             28.26 / 29.02 |                 26.91 / 28.23 |
| Latest success 2 events; older 200k  |               2.81 / 2.97 |                   2.87 / 3.07 |
| Empty history                        |               3.07 / 7.58 |                   3.67 / 5.50 |
| One sparse failed run                |               3.90 / 4.91 |                   4.32 / 5.09 |
| 20 sparse runs, tiny tables          |               4.71 / 5.41 |                   5.02 / 5.25 |
| 20 sparse runs, foreign 400k history |               5.31 / 5.73 |                   5.01 / 5.59 |
| Small interleaved history            |              5.98 / 13.56 |                  6.69 / 15.18 |

The small-history increases are retained adverse results. Tiny-table plans
can use sequential scans/sorts; more complex query construction also remains
part of reader latency. This is not a universal speedup or a constant scan
budget. For a latest failed run with 100k additional events, both queries
still walk 100,040 seed events and 800 events in subsequent frontier steps.
The old seed performs 100,040 earlier-event probes; the grouped seed scans
that run once and reuses its minimum. In the early-stop fixture the grouped
query reads just the latest two events, with no recursive scan or older-history
sort. EXPLAIN instrumentation changes timings: for example, its 100k-failed
execution times were 217.35 / 95.38 ms, separately from the client samples.

All 21 deterministic fixtures asserted explicit expected frontiers, identical
complete rendered strings, and identical selected-content SQL/parameters.
They include sequence gaps, retained-anchor removal, interleaved delayed
events, revoked first events, wholly revoked runs, interrupt-only targets and
foreign-thread rows. Endpoint regressions also emit 205 real assistant events
for successful and failed runs; existing direct/queued, newest-20, visibility,
rotation, archive and ownership tests cover the caller boundary. No timing
threshold is asserted in correctness tests.

Two discarded plans explain the query's structure: ungrouped MIN scanned
200,000 older rows in the early-stop fixture; hoisting the eligibility join
into the physical scan caused a full-history hash join/sort and approximately
101 ms frontier p50. Eligibility therefore stays in the grouped lateral
lookup. No new index, write cost or migration was introduced. These warm local
measurements do not establish production prompt-context savings, API-to-queue
savings or achievement of #24203's end-to-end target.

### Earlier recursive-query study

Before the grouped lateral rewrite, for #34924 the actual generated queries
were checked with PostgreSQL 18.6
`EXPLAIN (ANALYZE, BUFFERS)` on isolated temporary tables with the relevant
production indexes, 10,000 runs and 400,000 events (40 per run, latest 30 runs
failed). These are synthetic local measurements, not production latency or
inventory:

| Scenario                                         | Candidate rows | Outer event rows examined | Execution time |
| ------------------------------------------------ | -------------: | ------------------------: | -------------: |
| Long thread                                      |             21 |                       840 |         2.0 ms |
| Late success and old failure outputs             |             21 |                       842 |         2.1 ms |
| Additional 10,000 usage events on the latest run |             21 |                    10,842 |        32.0 ms |

All three plans used a backward thread-sequence index scan, run-ID index
lookups for earlier-event/visibility predicates, and the revocation index.
The final depth sort covers at most 21 frontier rows; none requires a
full-history aggregate or sort. Output-heavy tails still cost more index
probes; the 20-round result bound is not a constant physical scan budget. The
baseline reader was fast in the late-event cases because it incorrectly
stopped at the old successful run, so its timing is not an equivalent-result
performance comparison.

The successful-history case must also be measured: an earlier flat query
loaded 21 anchors before the application noticed the first success. On a
thread with two events in its latest successful run and 20 older successful
runs with 1,000 events each, it unnecessarily scanned 20,002 events (63.4 ms
median). The recursive query scans only the latest two events (0.15 ms median)
and does not execute its preceding-anchor branch. Both return empty context.
With 10,000 events per older run, the recursive query still scans two events
(0.15 ms median); the flat query exceeded a 45-second statement timeout in the
initial synthetic sample. These timings establish the need for SQL early
termination, not a production latency guarantee.
