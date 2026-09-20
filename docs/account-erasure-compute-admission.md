# Account erasure: compute admission (B2b1)

Scope: [#34275](https://github.com/vm0-ai/vm0/issues/34275), under
[#33745](https://github.com/vm0-ai/vm0/issues/33745). This connects the accepted
[B1 transaction contract](account-erasure-foundation.md) to actual compute
commits. It does not activate deletion ingress, a journal bridge, a collector,
or a worker. There is no schema migration, production backfill, billing cutover,
or production operation in this change.

## Admission and ownership

`compute-erasure-admission.service.ts` resolves the actual run/acting user,
organization, session owner and agent owner before acquiring **all** B1 subject
locks. Private maintenance additionally resolves the actual job and Storage
owner. Identity domains remain distinct (`user` versus `organization`); the
optional `users` table is never consulted. Sharing an agent does not transfer
ownership, and closing a member does not close the organization.

Each transaction uses the existing READ COMMITTED connection and real
`assertErasureSubjectWritable`. Ordinary writers acquire shared subject locks;
closure and erasure mutations retain exclusive locks. Sorted transaction advisory locks precede
resource, catalog, organization-concurrency, thread, run, session and provider
business locks and remain held through COMMIT. Agent/Storage `FOR KEY SHARE`
protects their composite identity/organization/owner unique keys against transfer
or deletion. Existing thread -> run -> session -> provider ordering is retained;
claims retain run -> queue ordering. No `SKIP LOCKED` behavior is introduced.

After acquiring those locks, writers re-read the ownership they resolved. An
observed change aborts the transaction and permits at most three fresh attempts,
each with a newly sorted complete subject set. A prepared payload from an old
agent owner is rejected rather than attributed to the new owner. Missing
resources are unavailable. Only the exact B1 `account_erasure:subject_closed`
error is a closure denial; infrastructure errors propagate.

Private `agentId === null` work remains valid. Claim/poll revalidation uses the
actual `lockPiMemoryPhase2MaintenanceCleanupProtection` validator after locking
the run, session and maintenance job. It checks owner, current lease, sandbox
token, revisions, selection digest and the immutable internal callback binding.
An expired or incorrectly owned lease cannot authorize a claim.

## Actual callers and commit points

Paths below are relative to `turbo/apps/api/src/signals/`. Earlier preparation
and preflight transactions do not grant admission to any later transaction.

| Caller chain                                                                                                                                                                                                              | Actual transaction / commit point                                                                                               | Closure behavior and ordering                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-events.command.ts`, `workflow-automation-launch.service.ts`, `internal-chat-run-callback.service.ts` -> `agent-runs-create.service.ts:createQueueFirstAgentRun$` -> `agent-run-create.service.ts:completeAgentRun$` | `commitPreparedLaunch` -> `commitPreparedLaunchUnderLock` -> actual pending/queued run, session, callback and queue persistence | Subjects first, then resource and existing catalog/org/thread/session/provider locks. Reject with conflict before content writes.                                                                                                                          |
| `pi-api-first-turn.service.ts` completion paths -> `completeAgentRun$`                                                                                                                                                    | Same `commitPreparedLaunch`, including its actual queued retry                                                                  | The first transaction can return `queue-payload-required` without writes. KMS encryption happens outside the transaction; the second transaction must acquire and validate admission again. Closure can win this gap.                                      |
| `pi-memory-phase2-worker.service.ts` -> `createAgentRun$` -> `completeAgentRun$`                                                                                                                                          | Same successful/queued transaction, plus the existing private source admission and lease binding                                | Resolve real user/org/Storage owner even without an agent. Preserve existing maintenance admission.                                                                                                                                                        |
| `createAtomicLaunchRun$` preparation error paths                                                                                                                                                                          | `commitFailedLaunch` -> **separate** `persistFailedLaunch` transaction -> `insertLaunchRunRows`                                 | Same subjects-first rule, before private/catalog/concurrency/thread/session locks or inserts. A denied failure does not create a failed run, prompt/error snapshot, session, callback or job and does not dispatch completion.                             |
| `agent-run-lifecycle.service.ts:drainOrgQueue$` (completion drain, capacity drain, stale queue recovery) -> `run-queue.service.ts:promoteNextQueuedRun$`                                                                  | `promoteQueuedCandidate` -> `promoteQueuedCandidateInTransaction`, including credit-failure persistence                         | Subjects before org/thread/run/session/queue/provider locks. Revalidate both the actual run and resource snapshot. Closure uses the separate disposition below and never becomes `insufficient_credits`. Genuine open-payload corruption remains an error. |
| `routes/runners.ts` poll                                                                                                                                                                                                  | Bounded candidate loop, each candidate's own admission transaction and fresh locked queue read                                  | At most eight candidates per request, existing reuse/priority/time/ID ordering retained. No prompt/vars leave the route before its transaction commits. Closed candidates are stopped; later eligible candidates can proceed.                              |
| `routes/runners.ts` successful claim                                                                                                                                                                                      | `transitionClaimedJobToRunning`, immediately before the existing run/queue CTE                                                  | Subjects and ownership validation before actual running transition and queue deletion. The original claim CTE, Runner attribution and queue expiry semantics remain. Denial returns unavailable without credentials/capabilities.                          |
| `routes/runners.ts` invalid execution context fallback                                                                                                                                                                    | `failPoisonQueuedJob`                                                                                                           | The actual failed-state/queue-write transaction has the same guard. Closed candidates do not reach ordinary completion scheduling.                                                                                                                         |
| `routes/runners.ts` resume-history load failure fallback                                                                                                                                                                  | The same `failPoisonQueuedJob` transaction                                                                                      | Same protection despite occurring before the successful claim transition. No fabricated credit failure.                                                                                                                                                    |

If a claim transaction commits before closure, that claim is admitted work even
when its response arrives later. The database barrier does not revoke already
admitted credentials or establish an egress boundary.

## Narrow queue disposition and retained settlement

Only an individually selected, locked **pending or queued** closed candidate
transitions to `cancelled`, with `error = account_erasure:subject_closed` and a
completion timestamp. Repeating it is a no-op; running work is untouched. This
is neither a cancellation campaign nor ordinary run completion.

The dedicated operation lives in the terminal transition service, but does not
invoke ordinary completion cleanup. It retains the run, session, callback,
Runner/agent queue, encrypted payload, diagnostic registrations, provider/account
identity and `creditAdmitted`. It does not create a replacement run, notify a
completion callback, rewrite billing identity, or clear a credit admission.
Promotion reads skip marked rows. Both queue TTL cleaners retain marked queue
rows so later capture can still find their payload and cleanup locators.
Runner TTL cleanup locks runs before queue deletion, revalidates after waits,
and handles at most 100 rows per pass. Diagnostic-registration cleanup also
excludes the marker.

These retained rows require the parent epic's coordinated capture/erasure path;
they are not a deletion-completion proof. Other old APIs and cleanup producers
remain part of that inventory, including generic threadless retention and
credential retirement. This slice does not certify their capture behavior.
Existing usage ingress and admitted-work
settlement are unchanged, including exactly-once usage identities.

## Verification and cost boundaries

Initial B2b1 verification used PostgreSQL 18.6 in an isolated local database, the actual B1 projector,
actual create/promotion services and actual Runner HTTP routes. Only synthetic
identities and infrastructure fixtures are used. The exact-file ESLint exception
documents why the dormant projector and PostgreSQL lock observations have no
public API boundary. External KMS/S3 fixtures remain outside database transactions;
admission, projection and writers are not mocked.

The matrix observes `pg_blocking_pids` to establish writer-first and closure-first
order for pending, actual queued, failed-preparation, promotion, claim and both
poison fallbacks. Additional cases cover the no-write queued retry gap, ownership
transfer before revalidation, absent optional users, subject-domain separation,
shared agents/surviving organizations, corrupt queued payloads, queue/poll
liveness, retained locators, and valid/closed/expired/wrong-owner maintenance.
Lease expiry is also changed while the actual claim waits on the maintenance job
lock. An admitted maintenance claim still settles repeated/concurrent usage
batches exactly once after projection, preserving canonical attribution.

The existing claim/cancel deadlock, equal-timestamp queue ordering, queued
feature propagation and provider/account/billing regressions are run as focused
tests. Complete local suites and a dev server are not used; full suites belong
to PR CI.

The unchanged B1 subject predicate remains eligible for the existing
`account_erasure_subject_generation` index. Local `EXPLAIN (ANALYZE, BUFFERS)` on
an empty closure table naturally selected a sequential scan (0.281 ms execution).
An explicitly forced **index-eligibility probe**, not a natural-plan throughput
claim, used that index with one search/one shared buffer (0.129 ms execution).
Existing [B1-S scale evidence](account-erasure-claim-scale.md) remains the source
for its separate worker/index workload; it is not a compute throughput result.

The original finite actual-claim experiment measured two concurrent requests, twice with
shared user/org subjects and twice with separate subjects. It reports local
end-to-end durations, including HTTP/fixture network overhead, without a CI
latency threshold. On 2026-09-15 the two shared-subject pairs took 49.51/29.14 ms;
the two separate-subject pairs took 49.01/24.41 ms (eight successful claims).
This sample cannot isolate the guard's incremental cost or establish a
production percentile. That experiment predates the shared-admission correction
in [#34441](https://github.com/vm0-ai/okou/pull/34441). Ordinary writers now share
subject locks; independent work can still contend on its actual business rows.

### Admission query consolidation (#34570)

Ordinary Agent admission reads run/session/Agent ownership together, using a
LEFT JOIN so a missing Agent does not discard the observed run/session. This
read only discovers subjects. Agent/Storage KEY SHARE and run/session FOR UPDATE
rereads still validate ownership in the original order; a changed owner retries
in a fresh transaction with a new complete subject set. Null-Agent maintenance
keeps its separate job/Storage authority and live-lease checks. Expected resource
and captured cleanup owners remain subjects, including deferred Pi cleanup.

After **all** sorted subject locks complete, one separate READ COMMITTED SELECT
checks for any matching closure job. It matches complete kind/ID pairs and does
not filter out any job state or generation. Keeping it separate from lock
acquisition gives it a new statement snapshot after a blocking closure commits.
All matching closure/retirement mutations require the same exclusive locks, so
they cannot change those subjects until the admitted transaction finishes.

| Prelude before the ordinary claim CTE         | Before | After |
| --------------------------------------------- | -----: | ----: |
| Initial run/session and Agent ownership reads |      2 |     1 |
| Isolation check                               |      1 |     1 |
| Sorted subject locks                          |      S |     S |
| Closure reads                                 |      S |     1 |
| Resource, run and session locked rereads      |      3 |     3 |
| Total                                         | 6 + 2S | 6 + S |

For two distinct subjects, this is **10 to 8 statements**. Counts describe the
successful ordinary Agent path and exclude BEGIN/COMMIT, response preparation,
the final claim CTE and maintenance/deferred-specific work. The claim timestamp,
queue ownership/expiry, retry policy, terminal disposition, billing and cleanup
locators are unchanged. Shared-helper consumers also include late run content
and Pi inference-object publication. No protocol, schema, cache, lock namespace
or hash changes; old shared/exclusive participants still coordinate and rollback
restores the extra reads.

Local PostgreSQL 17.11 measurements on 2026-09-16 compared baseline
`c26dba999576111eed64fefa08d3e4684255fa23` with this change using identical
temporary instrumentation: two warmups and ten real admission transactions on
API-created fixtures. Every sample confirmed 10 versus 8 prelude statements.
Finite HTTP claim-pair samples varied substantially; they do not establish a
latency improvement or separate RTT, execution and lock waiting. No timing
threshold, production logging or instrumentation is added to CI/runtime.

The initial join retained point-index lookups on run/session and the Agent owner
index (12 shared buffer hits versus 8 + 4 for separate reads in a same-session
probe). A 4,096-row transaction-local closure fixture used two existing-index
bitmap probes for the common two-subject predicate (0.015 ms execution). The
maximum 64-subject probe chose a local sequential scan (1.226 ms); query count
reduction does not imply constant execution cost. The fixture was rolled back;
these synthetic plans and single samples are not production throughput evidence.
There is no global lock, timeout increase or production operation.

### Locked session observation reuse (#34720)

Successful thread snapshot validation reads the expected session's conversation
and user/org/Agent ownership together under the existing `FOR UPDATE` lock.
Final new-run ownership validation reuses that observation only when its opaque
transaction identity and session ID match the current transaction and actual
insertion session. The observation is immutable, local to that admission, and
never derived from preparation or the initial pre-lock subject discovery.

Ordinary reused-session admission therefore performs one locked session SELECT
instead of two. Both snapshot and ownership predicates still run. Stale binding
or conversation results, missing prepared resolution, different insertion
sessions and threadless launches retain independent ownership reads. New
sessions retain their existing no-owner-read behavior; rotation still validates
the old expected session. Failed-preparation persistence and private maintenance
retain their separate admission. A queued-payload retry creates a fresh
transaction and cannot reuse the earlier observation.

Subject/resource/catalog/org/thread/session/provider ordering, account-closure
checks and ownership-error precedence over stale-snapshot retry are unchanged.
No schema, persisted proof, credential cache or client/Runner contract changes;
rollback restores the extra query. Query-count reduction does not establish a
production latency improvement.

Local PostgreSQL 18.6 statement capture compared main
`d1312dca7973bcd5615ca7a55123e4e5ee4906da` with this change on September 16.
Ten successful reused-session admissions in each suite run executed two locked
session SELECTs before the change and one afterward. Rotation retained its
expected-session read. API/Runner regressions cover queued reuse through
promotion and user/org/Agent changes committed while admission waits on the
session lock, both with and without a concurrent conversation change. Query
capture stays outside runtime and CI assertions; no timing threshold is added.

### New-run ownership observation (#34721)

Ordinary new-run persistence with an existing session observes the Agent and
session in one statement. A singleton `SELECT 1` independently LEFT JOINs their
requested primary keys, so either missing row still preserves the other owner
and its subjects. Structured schema-column selections decode each missing
object as null; a present session with a null Agent binding remains present.
New-session admission retains its one resource read. Null-Agent maintenance
retains its independent Storage/session reads and lease authority.

The observation only discovers subjects. Actual and expected owners still
contribute domain-separated user/organization locks, acquired individually in
sorted order. The closure query remains a separate READ COMMITTED statement
after all locks. Resource KEY SHARE rereads, bounded fresh-transaction retries,
prepared-owner rejection and the later session FOR UPDATE validation are
unchanged in both successful and failed-launch persistence. No schema, protocol,
cache, lock identity, concurrency or fairness change is involved.

For a writable ordinary Agent and existing session, admission changes from
`5 + S` to `4 + S` statements, where `S` is the distinct subject count. With two
subjects this is **7 to 6**. New-session admission stays at **6**. These counts
exclude BEGIN/COMMIT and subsequent launch persistence, including the later
session validation; they are not counts for the complete create-run request.

A finite local PostgreSQL 18.6 experiment on 2026-09-16 compared baseline
`d1312dca7973bcd5615ca7a55123e4e5ee4906da` with the candidate using identical
synthetic Agent/session fixtures, three warmups per variant/path and twenty
alternating samples. All samples confirmed the counts above. Existing-session
transaction medians were 5.352 ms baseline and 4.651 ms candidate; no-session
medians were 1.869 and 2.215 ms. These include local transaction/driver overhead
and are not a production percentile or a reliable savings estimate.

The generated candidate SQL bound Agent ID first and session ID second. Runtime
probes verified all four present/missing combinations and a present unbound
session. `EXPLAIN (ANALYZE, BUFFERS)` retained the Agent owner index and session
primary-key index, with five shared buffer hits versus three plus two for the
separate reads. The join adds two singleton LEFT nested loops. Single execution
samples were 0.144 ms combined versus 0.014 and 0.019 ms separately; fewer
statements do not mean identical planning/execution costs. No latency threshold
or experiment instrumentation is added to production or CI.

Behavioral coverage extends closure-first/writer-first and Agent-transfer races
to both existing-session persistence consumers, and checks the later session
ownership reread. Narrow infrastructure cases additionally prove that missing
and unbound observations still wait for closure on the surviving actual or
expected subjects. Preparation prechecks cannot expose those intermediate
missing/mismatched pairs through an endpoint; these cases use the existing
real-database admission exception rather than mocking the query or locks.

### Isolation check with the first subject lock (#35235)

The first sorted subject lock now also checks the transaction's isolation level.
A SQL `CASE` evaluates the advisory-lock scalar subquery only for READ COMMITTED
and returns the isolation text through the existing schema-column decoder.
Unsupported isolation neither acquires an uncontended lock nor waits for a held
one. Every subsequent subject is still locked in its own awaited statement;
the closure lookup is still a separate statement after **all** subject locks.
A closure committed while the first or a later lock waits therefore remains
visible. Both shared admission and exclusive erasure mutations use this helper.

The full subject list is validated before locking. Invalid subject inputs now
fail before the isolation query; if both inputs and isolation are invalid, the
subject error takes precedence. The lock namespace, domain-separated identities,
hash seed, sorting, modes and transaction lifetime are unchanged. Old and new
participants continue to exclude each other. Resource KEY SHARE rereads, final
session validation, ownership retries, private maintenance and failed-launch
persistence retain their existing contracts. No schema, protocol or stored proof
changes are required; rollback restores the standalone isolation query.

For `S` distinct subjects, the lock stage changes from `1 + S` statements to
`S`. Ordinary new-run admission, with either a new or existing session, changes
from `4 + S` to `3 + S`: **6 to 5** for one user and one organization. These
counts exclude checkout, BEGIN/COMMIT, optional catalog admission and later
organization/thread/session/provider work. They are not whole-request counts.

Real PostgreSQL regressions cover repeatable-read and serializable rejection
for both lock modes, including a conflicting held lock and inspection before
rollback. Closure-commit races cover both the first organization lock and the
later user lock. Existing B1 and actual compute tests retain writer-first,
closure rollback, shared writers, ownership transfer, missing resources,
new/existing sessions, queued retries, failure persistence and maintenance.

#### Finite local attribution

On 2026-09-18, PostgreSQL 18.6 and Node 24.21.0 on loopback compared main
`5db7365a036798df6f7d7b9ea0ee7ee2e0cd5921` with this change. The experiment
replayed the unchanged ownership SELECT and resource KEY SHARE reread around
the actual baseline/candidate `assertErasureSubjectWritable` implementations.
It did not invoke an HTTP endpoint or the full compute service. Each variant
and session shape had ten warmups and 100 samples, alternating order per pair,
with one pool connection, 64 rotating synthetic Agent/session pairs and 2,000
unrelated closure rows. There was no injected network delay or concurrent load.

All values below are p50/p90 milliseconds, calculated from complete per-replay
samples. The replay interval starts after BEGIN and ends after the resource
reread. The last column sums checkout, BEGIN and admission durations within each
replay before calculating percentiles; it is not a separately timed continuous
interval or a sum of percentile columns.

| Session  | Variant   | Statements | Checkout    | BEGIN       | Admission replay | Per-replay component sum |
| -------- | --------- | ---------: | ----------- | ----------- | ---------------- | ------------------------ |
| New      | Baseline  |          6 | 0.020/0.026 | 0.067/0.217 | 1.233/3.009      | 1.322/3.086              |
| New      | Candidate |          5 | 0.019/0.026 | 0.067/0.151 | 1.172/2.771      | 1.262/3.088              |
| Existing | Baseline  |          6 | 0.019/0.025 | 0.065/0.189 | 1.475/3.398      | 1.583/3.545              |
| Existing | Candidate |          5 | 0.019/0.024 | 0.065/0.155 | 1.451/3.540      | 1.556/3.653              |

For existing sessions, non-overlapping client SQL stages were:

| Stage                                                | Baseline p50/p90 ms | Candidate p50/p90 ms |
| ---------------------------------------------------- | ------------------- | -------------------- |
| Ownership observation                                | 0.280/0.534         | 0.289/0.580          |
| Standalone isolation probe                           | 0.131/0.397         | Absent               |
| Isolation plus first lock                            | Absent              | 0.203/0.571          |
| Remaining subject-lock statements, summed per replay | 0.189/0.495 (two)   | 0.103/0.333 (one)    |
| Post-lock closure lookup                             | 0.183/0.464         | 0.189/0.492          |
| Resource KEY SHARE reread                            | 0.150/0.386         | 0.146/0.366          |
| COMMIT, after the replay interval                    | 0.314/0.573         | 0.315/0.630          |

These stage timings include driver/transport and event-loop overhead; they are
not pure SQL execution or isolated lock waits. Optional catalog work is absent
in both ordinary paths. Contended wait correctness is established by the
database-synchronized races above, not by these uncontended latency samples.
Local JavaScript/query construction is included in the enclosing replay and is
not an additional SQL stage. COMMIT follows the replay immediately here; real
launch transactions do substantially more work after organization admission.

Separate `EXPLAIN (ANALYZE, BUFFERS)` runs used each captured SQL/binding pair
ten times in fresh rolled-back transactions. The combined statement adds one
scalar InitPlan with one Function Scan: median server planning/execution was
0.015/0.006 ms, versus 0.005/0.002 ms for the old isolation probe and
0.004/0.002 ms for its separate first lock. All three touch zero data buffers.
The candidate Function Scan executes once under READ COMMITTED and zero times
under REPEATABLE READ. Bound lock keys and subsequent SQL are unchanged.
Ownership keeps the Agent owner index and, for existing sessions, the session
primary-key index (three/six shared hits). Closure uses BitmapOr over the
subject-generation index (four hits); the resource reread retains LockRows
over the Agent owner index (four hits). These cached fixture plans had no
physical buffer reads.

The deterministic result is one fewer statement, not a demonstrated latency
gain: medians decrease slightly, but existing-session p90 increases by 0.142 ms
in this finite run. Warm caches, local transport, fixture sizes and lack of
contention limit extrapolation. A fixed-seed, 10,000-resample paired bootstrap
of the existing observations gives median-delta 95% intervals of
[-0.036, +0.019] ms (new) and [-0.065, +0.016] ms (existing), both spanning zero;
this is descriptive within-run uncertainty, not a non-inferiority proof.
No production API-to-queue candidate percentile
is available before deployment. Independently, the
[historical production investigation](https://github.com/vm0-ai/okou/issues/24203#issuecomment-5726341029)
reported pre-org-lock p50/p90 **4.29/8.36 -> 24.61/55.48 ms** and API-to-queue
**495/825 -> 769/1259 ms** for September 14/18 complete Web/direct cohorts.
Each run had one unambiguous API identity and no preparation retry, but the
daily cohorts mixed revisions/workloads. Neither interval is a causal savings
estimate. The queue boundary remains the pre-CTE `runnerJobQueue.createdAt`;
full transaction or lock-held spans must not be subtracted from it.

### Ordinary Agent claim locked rereads (#35418)

The successful ordinary, non-deferred Agent claim keeps the initial ownership
observation, every sorted shared subject lock and the separate post-lock closure
lookup above. After that lookup, one bound statement now validates the three
business rows through dependency-linked materialized CTEs:

1. `locked_resource` takes the Agent `FOR KEY SHARE` lock and returns its
   current owner.
2. `matching_resource` permits `locked_run` only when that owner still matches
   the subject observation. `locked_run` retains the `status = 'pending'`
   predicate and takes the run `FOR UPDATE` lock.
3. `matching_run` permits `locked_session` only when the locked run still has
   the observed owner and session. `locked_session` then takes the session
   `FOR UPDATE` lock and returns its current owner and Agent.

The final projection consumes every materialized result, so the lock dependency
is Agent -> pending run -> session. If cancellation changes the run before the
run lock is obtained, PostgreSQL rechecks the pending predicate, the session CTE
receives no input and the claim returns unavailable without waiting on the
session. A changed or deleted Agent, changed pending-run owner/session, or
changed/deleted session retains the bounded fresh-transaction ownership retry.
A stale expected resource owner retains its previous locked-unavailable result.

For `S` distinct subjects, the ordinary claim prelude before the unchanged final
run/queue CTE changes as follows. The isolation check is already part of the
first subject-lock statement described in #35235.

| Prelude before the ordinary claim CTE        | Before | After |
| -------------------------------------------- | -----: | ----: |
| Initial run/session and Agent ownership read |      1 |     1 |
| Sorted subject locks, including isolation    |      S |     S |
| Separate post-lock closure lookup            |      1 |     1 |
| Resource, run and session locked rereads     |      3 |     1 |
| Total                                        |  5 + S | 3 + S |

The usual user-plus-organization path therefore changes from **seven to five
statements**, excluding BEGIN/COMMIT and the final claim CTE. A real PostgreSQL
driver-level regression captures the selected claim transaction and checks one
ownership observation, two subject locks, one closure lookup, one combined
locked reread and the existing final CTE. Closure-first/writer-first, Agent/run/
session ownership changes, Agent deletion, cancellation/session-lock ordering,
closed-candidate retention and concurrent-claim regressions exercise the same
actual route.

Null-Agent maintenance and deferred claims retain the generic separate locked
rereads and their additional authority checks. Polling, run persistence,
promotion, cleanup and every other shared admission consumer are unchanged. The
final claim CTE still owns queue expiry/deletion, the pending-to-running update,
Runner attribution and the database claim timestamp. No schema, protocol,
lock namespace, cache or rollout switch changes, and mixed API versions still
coordinate through the same subject and row locks. Statement reduction alone
does not establish production latency improvement; exact containing API/Runner
observation remains required.

## Remaining boundaries and activation gates

- Preparation may already write provider/storage artifacts before the guarded
  run commit; claim history preparation can backfill blob metadata. Rejection
  does not prove those external effects stopped or were cleaned up.
- Cancelled runs can still materialize late output. Output/callback content,
  chat, automation, uploads, credentials, storage and egress remain B2b2/D/E/G2.
- Existing signed PUT and multipart capabilities last **48 hours**. Cancellation
  does not revoke them and does not prevent output materialization.
- Old API/Runner/queued producer versions need a separately verified drain and
  activation plan. A newly guarded deployment does not fence old writers.
- B2a's independent event/journal bridge, complete G2d1b/B2b2 prerequisites,
  independent controller acceptance and coordinated publication remain required.
  This implementation owner stops at the unique PR's protected merge and does
  not release, deploy, enable deletion ACK/ingress, change policy/keys, delete
  accounts/resources, or perform billing cutover.
