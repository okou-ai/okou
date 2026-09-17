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

For #34924, the actual generated queries were checked with PostgreSQL 18.6
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
