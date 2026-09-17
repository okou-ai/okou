# Account erasure: durable run output (B2b2-O)

Scope: [#34352](https://github.com/vm0-ai/vm0/issues/34352), under
[#33745](https://github.com/vm0-ai/vm0/issues/33745). This uses the existing
[B1 barrier](account-erasure-foundation.md) and preserves the accepted
[compute admission](account-erasure-compute-admission.md) contract. It installs
no closure decision, ingress, worker, schema, migration or production operation.

## Ownership and transaction ordering

`run-content-erasure-admission.service.ts` reads the persisted run user/org,
run-to-session/thread bindings, session user/org/agent, destination thread
user/agent, and both applicable agent owners/orgs. Agent-null private maintenance
uses the immutable run's `memory` writeback mount and its current Storage owner.
The maintenance job clears `maintenanceRunId` on completion; neither that job nor
an unexpired compute lease is an authority for historical content. The optional
`users` table is not consulted. User and organization identifiers are separate
subject domains. A member closure never creates an organization closure.

Every actual write transaction sets READ COMMITTED, a 1-second lock timeout and
5-second statement timeout. These are the existing output transaction limits;
the independent callback/acknowledgement transactions now use the same limits.
All distinct subjects go to the real `assertErasureSubjectWritable`, which
sorts domain-separated transaction advisory locks. Its locks remain held until
COMMIT, including when closure is concurrently waiting.

The complete order is **subjects -> resources -> output projection -> thread ->
run -> session**. Agent and Storage composite owner keys receive KEY SHARE;
thread/run/session rows are locked before ownership is re-read. Resource IDs are
sorted. No subject lock is acquired after any business lock. Only an observed
ownership race rolls back and retries, at most three fresh transactions. Each
attempt resolves the complete subject set again. Prepared content remains pinned
to its original ownership snapshot; a transfer cannot redirect it to a new owner
or destination, even if that new owner is open.

Existing assistant balance-error presentation receives `modelProvider` from
the locked run after ownership is revalidated.

Preparation captures ownership before asynchronous history reads. Historical
run-group resolution, including any R2 archive read, happens outside the guarded
write transaction. Only database reads/writes happen while subjects are held.
The snapshot grants no write permission: history, fallback and acknowledgement
transactions each acquire current admission independently.

## Writer and caller coverage

| Actual entry and caller                                                                                                                                                | Independent transaction                                                | Covered durable state                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks-agent-events.ts` -> `receiveAgentEvents$` -> `materializeRunOutputEvents$`                                                                                   | `withRunContentWrite` around `materializeAdmittedRunOutputEvents`      | Assistant/thinking/balance-error `chat_events`, thread sequence reservations, latest result/output, normalized memory citations and its existing in-transaction acknowledgement |
| `handleChatInternalCallback$` and `handleChatInternalCallbackWithoutCcstate` -> `materializeCompletedChatResult` -> `insertAssistantEvents$` / `insertAssistantEvents` | Each standalone assistant insertion owns a fresh `withRunContentWrite` | History items or result fallback, event identity/deduplication and sequence reservation                                                                                         |
| `insertAssistantEvents` -> `publishFirstAssistantEventCreatedSafely` -> `recordFirstAssistantEventAcknowledgement`                                                     | A later, separate `withRunContentWrite` under `waitUntil`              | Conditional `firstAssistantEventAcknowledgedAt` update                                                                                                                          |
| Threadless agent output and private maintenance                                                                                                                        | Same required output projection transaction                            | Latest result/output and citations without a chat projection                                                                                                                    |

Current `loadCompletedChatOutput` reads canonical database output and constructs
an empty `assistantItemsToInsert` array. Its result-fallback path is live. The
historical-items branch shares the fenced standalone writer; tests exercise
prepared history through that actual writer without inventing a production
history producer or mocking admission. Both real callback implementations also
have result-fallback/retry coverage. This distinction is not evidence that every
callback transaction is fenced.

`insertAssistantEventsInTransaction` is called only by the two admitted writers
above. Generic `insertChatEvents` / `insertChatEvent` do not acquire subjects;
other callers may already hold thread/run locks. The previous output-only thread
lookup became unused and was removed. Generic metadata writers remain unchanged.

## Disposition and preserved behavior

Only the exact B1 `account_erasure:subject_closed` error becomes closure denial.
The required webhook projection returns `ignored-closure`; its existing HTTP 200
ignored-delivery response contains no `acceptedEvents`, so that batch starts no
optional consumers. This is delivery disposition, not an erasure-completion ACK
and not a claim that prior egress stopped. Missing runs and timeouts retain their
ignored disposition. Other database failures, lock timeouts and aborts remain
failures/backpressure. Closure may be returned before supplied snapshot or
destination mismatches are checked. Every admitted write validates the pinned
identity; a closed outcome grants no write capability.

Open-account running, completed and ordinarily cancelled runs remain eligible.
Event IDs, sequence allocation/deduplication, out-of-order latest-result
selection and citation normalization retain their existing contracts. The
webhook keeps its existing in-transaction acknowledgement semantics. The separate
assistant wrapper still captures its timestamp **after** awaiting publication
registration and schedules a later transaction. Realtime publication is already
best effort: this timestamp does not prove delivery to Ably or a client. It has
not been moved into the first insertion transaction. The later metadata attempt
has a 20-second owner deadline and reacquires admission using the pinned identity.

No usage, provider/run attribution, `creditAdmitted`, settlement or ledger writer
is changed. Genuine already-admitted usage can settle after closure. Financial
connector business content has no platform-billing retention exemption.

## Verification and cost boundaries

The focused admission matrix extends the existing dormant-projector PostgreSQL
suite without expanding ESLint exceptions. Synthetic runs are created through
real APIs. There is no public deletion ingress or API for observing lock waits,
private citations or acknowledgement metadata; those checks use actual B1,
actual writer entry points and real concurrent PostgreSQL sessions.

Deferred barriers and `pg_blocking_pids` establish both commit orders, ownership
changes and the independently scheduled acknowledgement gap. Tests inspect
covered content tables, sequence state and acknowledgement fields. They also
cover result fallback/retries through both callback implementations, ordinary
cancellation, domain separation, surviving owners, missing optional users,
threadless completed maintenance after job/lease retirement, infrastructure
failure and no optional effects after denial. Existing compute, settlement,
callback and output-locking regressions are retained. Full suites belong to PR
CI; no full local Vitest or development server is required.

Controller-provided read-only MaskDB observations, **2026-09-15
09:13:53–09:14:08 UTC**, are non-atomic whole-table counts: `chat_events`
**1,681,806**, `chat_threads` **157,749**, `agent_runs` **283,349**. The two
`run_output_*` tables are unexposed and their live sizes remain **unknown**.
There is no historical scan, schema change or policy expansion in this slice.

Admission resolves one run/session/thread, at most two agents and one private
memory Storage using existing primary/composite indexes. The subject set has a
fixed bound (at most eleven distinct subjects); no global lock is introduced.
History preparation retains its existing signal/reader contract outside the
write transaction. Repeated indexed reads and exclusive B1 locks add real cost:
all writers sharing a user **or organization** necessarily serialize, including
different runs. Local pair measurements and index plans are finite evidence,
not an isolated incremental-cost benchmark or proof of production throughput.
Production contention remains a controller acceptance/observation obligation.

On local PostgreSQL **18.6**, UTC, eight actual concurrent output requests in
four pairs took **51.72/50.36 ms** with shared subjects and **39.64/49.92 ms**
with separate subjects. These include HTTP/test-harness overhead and do not isolate
the guard's incremental cost. Primary-key lookup probes for runs, sessions and
agents used their indexes (0.110/0.044/0.017 ms execution, one shared buffer each).
The tiny 27-row thread table naturally chose a sequential scan (0.087 ms);
a transaction with 10,000 additional synthetic threads, ANALYZE and the same
predicate selected `chat_threads_pkey` (0.024 ms, two shared buffers). That
transaction was rolled back. These are finite local plans, not live production
planner or cache measurements; no forced plan or new index is required.

## Remaining obligations

Terminal lifecycle/error markers, integration completion placeholders and
transactionally coupled delivery/sidebar writes are covered by
[B2b2-T](account-erasure-terminal-callback.md). Summaries, followups and automation
results remain B2b2-R. The lifecycle-owned `insertIntegrationCompletionFallback`
is outside this B2b2-O assistant history/result projection. The durable chat
search producer is fenced separately by
[B2b2-R2](account-erasure-chat-search.md); its already durable rows remain
historical data. Chat input/creation/editing, activity/
sidebar/archive copies and previously admitted optional consumers also remain
outside this slice. Files/sites,
credentials, remote sessions, transient Ably/provider egress and existing
48-hour signed upload/multipart capabilities remain B2b2-R/D/E/G2. Already-running
old API/Runner/client producers need independently verified drain. The change
alters no public protocol or persisted schema and does not establish a writer
fence for those older versions.

This is not a full account-write fence or A2 readiness. Controller acceptance,
separate release qualification/publication, authority/activation gates, billing
independence, domain erasure and H remain separate. The implementation owner
stops at its sole PR's protected merge; it does not activate or probe deletion in
production, and the recovered September 12 account is excluded from fixtures.

## Required-output backpressure attribution (B2b2-P)

[#34432](https://github.com/vm0-ai/vm0/issues/34432) adds three optional fields to
only the existing required-output `55P03` backpressure record. Both HTTP webhook
and Pi API-first callers use the same invocation-owned capture. There is no new
record, success stream, sink, identifier, payload, SQL or driver-error field.
The record's existing finite lifecycle remains part of G2/H; this does not
create a permanent non-billing audit exception.

`outputPhase` is a fixed operation-group enum: `preparation`,
`transaction_setup`, `ownership_snapshot`, `subject_admission`,
`resource_identity_locks`, `output_advisory_lock`, `thread_lock`, `run_lock`,
`session_lock`, `ownership_recheck`, `projection_write`, `transaction_finalize`.
The subject group includes the unchanged shared B1 advisory acquisition and its
single closure lookup, so it waits behind an exclusive erasure or first-closure
holder rather than behind another ordinary writer.
It identifies no particular user, organization or blocking session.
Preparation includes ownership/status preparation and historical run-group reads;
transaction setup includes connection/BEGIN and the existing deadline statements.

Each awaited group is marked before execution. The transaction callback freezes
its original thrown object's receipt before Drizzle rolls back. A rejection
returned by the transaction must be that same object to reuse the receipt; a
different rollback error discards unavailable attribution. After a successful
callback, the pending COMMIT is explicitly `transaction_finalize`, including
any driver rollback before that transaction rejection becomes observable.
No error is wrapped or mutated, and `cause.code` and abort identity are retained.

`outputPhaseElapsedMs` and `outputAttemptElapsedMs` use `performance.now()`,
independent of business timestamps. They are finite, nonnegative rounded
milliseconds capped at **60,000 ms**; invalid durations are omitted. They measure
operation/attempt elapsed time, including scheduling and execution, rather than
pure lock wait or lock hold. Preparation and each of the existing three maximum
ownership attempts start fresh timing. Success, closure and abort clear capture;
the handler consumes a failure receipt once. No timer, added query, timeout,
retry, disposition or billing decision uses these measurements.

The existing PostgreSQL infrastructure harness covers held user/org, resource,
output, thread, run, session and projection locks, rollback without partial output,
HTTP 503 followed by an idempotent retry, both closure orders, shared-org and
unrelated liveness, ownership retries, abort identity and ordinary errors. Its
exception also permits connection-local deferred constraints and terminating a
test-owned connection to exercise commit/rollback failures, which production
APIs cannot request. It observes the same minimal capture the handler consumes,
without logger or Axiom assertions. All normal output/closure/billing regressions
remain applicable. A bounded four-layout baseline/candidate observation is
reported with exact production SHAs and environment in the PR; it establishes
neither production throughput nor a causal guard regression.
