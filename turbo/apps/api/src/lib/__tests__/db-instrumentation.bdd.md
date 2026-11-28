# db-instrumentation

## db-instrumentation-001

- Vitest: "instrumentPgPool > attributes new, idle, and queued acquisition to each query span"
- Mode: run
- Intent: review
- Given: An instrumented single-connection Postgres pool records query spans on a real database.
- When: One query runs on a fresh pool, a second runs after it, and a third is queued while the only client is checked out and then released.
- Then: Exactly one query waits, all three return one row, and their spans record acquisition paths `new`, `idle` and `queued` with a non-negative acquisition duration. Only the `new` span carries connection telemetry (non-negative socket-connect duration, `ipv4`/`ipv6` address family, and consistent optional lookup and attempt counts); the idle and queued spans carry none.

## db-instrumentation-002

- Vitest: "instrumentPgPool > captures pool acquisition paths per concurrent manifest lookup"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool and two separate acquisition captures.
- When: The first capture runs two sequential queries, then the only client is held while one query under each capture is queued, and the client is released.
- Then: Two queries wait, the first capture records paths `new`, `idle`, `queued` and the second records only `queued`, each with finite non-negative durations and finite finish times.

## db-instrumentation-003

- Vitest: "instrumentPgPool > captures pool acquisition without a recording query span"
- Mode: run
- Intent: review
- Given: An instrumented pool whose tracer does not record spans, and an acquisition capture.
- When: One query runs inside the capture.
- Then: The query returns one row, the capture holds exactly one `new` acquisition with numeric duration and finish time, and no spans are exported.

## db-instrumentation-004

- Vitest: "instrumentPgPool > isolates callback and Promise query captures across queued requests"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool with a non-recording tracer, and separate acquisition and query-execution captures for two requests.
- When: The first request runs one callback-style pool query, then while the client is held the first request checks out a client and runs a Promise query, the second request runs a pool query, and an uncaptured query is also queued before the client is released.
- Then: Three queries wait and all return one row. The first request records acquisitions `new`, `queued` and two query executions; the second records one `queued` acquisition and one execution, all with finite non-negative durations; no spans are exported.

## db-instrumentation-005

- Vitest: "instrumentPgPool > captures failed Promise acquisition without inventing SQL execution"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool with a 25 ms connection timeout whose only client is held.
- When: A checkout is attempted inside acquisition and query-execution captures, then the client is released and a further query runs.
- Then: The checkout fails with "timeout exceeded when trying to connect", the acquisition capture records one `queued` acquisition, the execution capture records nothing, and the next query returns one row.

## db-instrumentation-006

- Vitest: "instrumentPgPool > reserves idle and new capacity for earlier synchronous queries"
- Mode: run
- Intent: review
- Given: An instrumented two-connection pool warmed by one query.
- When: Three queries are issued synchronously in a burst.
- Then: All three wait initially and each returns one row; the warm-up span is `new`, and the burst spans are `idle`, `new` and `queued` in issue order.

## db-instrumentation-007

- Vitest: "instrumentPgPool > classifies replacement connections while older queries remain queued"
- Mode: run
- Intent: review
- Given: An instrumented two-connection pool with both clients checked out and two queries queued.
- When: One client is retired with an error (leaving one connection, no idle clients and two waiters), a third query is issued, and the other client is released.
- Then: All three queries return one row; the two earlier queries record `queued` and the later query records `new`.

## db-instrumentation-008

- Vitest: "instrumentPgPool > keeps concurrent queued measurements on their originating traces"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool whose only client is held.
- When: Two queries are queued under separate parent spans `parent-a` and `parent-b`, then the client is released.
- Then: Two queries wait; both query spans record `queued`, each has its own parent's trace ID and parent span ID, and the two parents have different trace IDs.

## db-instrumentation-009

- Vitest: "instrumentPgPool > preserves acquisition measurements on Workers query spans"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool used under a Workers request runtime whose native tracer creates the query spans.
- When: Two queries run sequentially, then two more are queued while the only client is held and then released.
- Then: Two queries wait and both return one row; the four spans record `new`, `idle`, `queued`, `queued`, and exactly four spans exist, all from the Workers runtime tracer.

## db-instrumentation-010

- Vitest: "instrumentPgPool > retains Workers acquisition failures and allows the next query"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool with a 25 ms connection timeout under the Workers request runtime, with the only client held.
- When: A query is attempted, the client is released, and another query runs.
- Then: The first query fails with "timeout exceeded when trying to connect" and its span records `queued`; the next query returns one row with an `idle` span; exactly two spans exist.

## db-instrumentation-011

- Vitest: "instrumentPgPool > preserves acquisition and query failures and releases clients"
- Mode: run
- Intent: review
- Given: One instrumented pool with a 25 ms connection timeout whose only client is held, and a second instrumented pool.
- When: A query on the first pool is attempted inside an acquisition capture; then a query against a missing table runs on the second pool through the pool and through a checked-out client inside an execution capture, followed by a valid query.
- Then: The first query fails with "timeout exceeded when trying to connect", its span has ERROR status and `queued` path, and the capture records one `queued` acquisition. Both missing-table queries fail, the execution capture records two executions, the failing pool span has ERROR status and `new` path, and the recovery query returns one row with an `idle` span.

## db-instrumentation-012

- Vitest: "instrumentPgPool > preserves direct callbacks and instruments reused clients only once"
- Mode: run
- Intent: review
- Given: An instrumented single-connection pool.
- When: A callback-style checkout receives and releases the client, then the same client is checked out twice via Promise and runs one query each time.
- Then: The callback form returns undefined with no error and receives the same client; both checkouts get the same client; each query returns one row and produces exactly one span, and neither direct-client span carries an acquisition path.

## db-instrumentation-013

- Vitest: "instrumentPgPool > releases abandoned checkouts and drains queued queries before shutdown"
- Mode: run
- Intent: review
- Given: The test's resource owner manages an instrumented two-connection pool with one held client, one abandoned checkout and one queued query.
- When: Resource cleanup starts.
- Then: The queued query still returns one row, cleanup completes, releasing the held client afterwards does not throw, a second cleanup is harmless, and the pool rejects new checkouts with "Cannot use a pool after calling end on the pool".

## db-instrumentation-014

- Vitest: "instrumentPgPool > releases a queued checkout delivered after cleanup starts"
- Mode: run
- Intent: review
- Given: The test's resource owner manages an instrumented single-connection pool with one held client and one queued checkout.
- When: Resource cleanup starts before the queued checkout is delivered.
- Then: The queued checkout rejects with "PG test resources are closing", cleanup completes, and the pool rejects new checkouts with "Cannot use a pool after calling end on the pool".
