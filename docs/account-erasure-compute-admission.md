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
`assertErasureSubjectWritable`. Sorted transaction advisory locks precede
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

Tests use PostgreSQL 18.6 in an isolated local database, the actual B1 projector,
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

The finite actual-claim experiment measures two concurrent requests, twice with
shared user/org subjects and twice with separate subjects. It reports local
end-to-end durations, including HTTP/fixture network overhead, without a CI
latency threshold. On 2026-09-15 the two shared-subject pairs took 49.51/29.14 ms;
the two separate-subject pairs took 49.01/24.41 ms (eight successful claims).
This sample cannot isolate the guard's incremental cost or establish a
production percentile. Existing exclusive subject locks necessarily serialize work
for the same user **or organization**, including polls. No global lock, wider
runtime timeout, historical scan, or unmeasured production-throughput claim is
introduced. Controller acceptance must evaluate production contention separately.

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
