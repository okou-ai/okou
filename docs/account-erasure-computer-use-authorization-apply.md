# Computer Use authorization Apply account-erasure fence

## Scope

This design covers only Computer Use authorization requests stored with
`source: "chat"`. That is the canonical path used by web-chat, Slack and Teams
runs. It does not change request creation, request reads, `source: "teams"`
legacy Apply, denied legacy Slack Apply, host registration/start/stop,
provider sessions or host grants.

The authenticated request labels are locators, not authority. The canonical
thread user, its non-null Agent, the Agent owner and the Agent organization are
the authority for a write. The admitted subjects are therefore:

1. the thread user;
2. the Agent owner when distinct; and
3. the Agent organization.

A missing thread, a null or missing Agent, an authenticated identity mismatch,
an organization mismatch or B1 closure keeps the existing `scope_not_found`
response. Database errors, lock/statement timeouts and operation cancellation
propagate; they are never translated into that response.

## Lock and transaction order

Apply performs its existing unlocked token and host preflight first. The host
must still belong to the authenticated user and organization, be non-revoked,
report `online`, and have a heartbeat within the existing eligibility window.
The accepted write then uses this order inside one READ COMMITTED transaction:

1. set the existing 1-second lock and 5-second statement budgets;
2. resolve the content-free thread/Agent identity;
3. acquire the sorted shared B1 subject locks and re-read closure state;
4. retain the Agent with `FOR KEY SHARE`;
5. retain the thread with the shared helper's `FOR KEY SHARE` and re-read the
   full identity;
6. acquire a caller-local `FOR NO KEY UPDATE` thread lock and re-read its user
   and Agent;
7. re-read the fixed request id, token hash, user, organization, `chat` source
   and original thread with `FOR NO KEY UPDATE`;
8. read the accepted timestamp and recheck expiry;
9. update the thread, reserve and append the sidebar event, and complete the
   exact request; and
10. perform the operation's final abort check before COMMIT.

The caller-local thread lock is intentionally not `FOR SHARE`. Two concurrent
Apply transactions can both hold the shared helper's `FOR KEY SHARE`; making
both upgrade to `FOR SHARE` before their later UPDATE creates an avoidable
upgrade deadlock. `FOR NO KEY UPDATE` is compatible with the existing retained
KEY SHARE and is already the mode required by the non-key thread UPDATE, so
same-thread applies serialize without that cycle.

If a non-key thread identity change commits before the caller-local lock, the
locked re-read raises `ChatThreadContentOwnershipChangedError`. The shared
helper rolls back and reselects identity and subjects, for at most three whole
attempts. It never widens subjects under retained business locks. The Agent lock
retains owner and organization while the request pin waits. The request lock
then prevents deletion or any identity mutation through completion. Request
revalidation failure never follows a replacement request or thread.

There is deliberately no run existence or activity check. A request remains
repeatable after completion, and a valid request can still be applied after its
originating run is terminal or absent.

## Atomic state and cancellation

For canonical chat Apply, one transaction owns all of these writes:

- `chat_threads.computer_use_host_id`, `cloud_browser_enabled` and `updated_at`;
- the per-user/organization durable sidebar sequence;
- the `computer_use_host_updated` event; and
- the authorization request's `completed_at` and `updated_at`.

The timestamp is read only after all required thread and request waits. That one
value is used for the thread, event and completion. A request that expires while
waiting is therefore `expired` without any partial write.

The operation signal is checked after each database wait and mutation, and the
shared helper performs the final in-transaction check. Cancellation observed by
that check rolls every executed write back. Cancellation after that final check
can race a successful COMMIT: durable state may exist while the caller loses the
response and the post-commit invalidation. This boundary is explicit and no
publication retry is fabricated.

`threadListChanged` is published only after a successful COMMIT, to the exact
authenticated `user-org:<userId>:<orgId>` channel. Denial, expiry, rollback and
failed completion publish nothing.

## Post-authentication SQL inventory

The inventory below is for the canonical chat Apply source in this change. It
counts every SQL statement the driver issues, including `BEGIN` and `COMMIT` (or
`ROLLBACK`). The first B1 subject-lock statement includes the READ COMMITTED
isolation guard introduced by #35245; there is no separate isolation probe.

Before the transaction, a live request performs exactly two statements:

1. token/user/organization request locator; and
2. unchanged host ownership, revocation, status and heartbeat preflight.

The accepted transaction contains the following statements:

| Phase                                                         |   Statements | Cardinality                               |
| ------------------------------------------------------------- | -----------: | ----------------------------------------- |
| `BEGIN ISOLATION LEVEL READ COMMITTED`                        |            1 | fixed per attempt                         |
| Local deadlines                                               |            2 | fixed                                     |
| Unlocked canonical identity                                   |            1 | fixed                                     |
| B1 shared subject locks, with isolation folded into the first |       2 or 3 | same owner or distinct shared-Agent owner |
| Fresh closure lookup                                          |            1 | fixed                                     |
| Agent KEY SHARE                                               |            1 | fixed for accepted non-null Agent         |
| Shared-helper thread KEY SHARE                                |            1 | fixed                                     |
| Locked canonical identity re-read                             |            1 | fixed                                     |
| Caller-local thread NO KEY UPDATE and re-read                 |            1 | fixed                                     |
| Exact request NO KEY UPDATE and TTL source                    |            1 | fixed                                     |
| Thread selection UPDATE                                       |            1 | fixed                                     |
| Sidebar sequence UPSERT                                       |            1 | fixed                                     |
| Sidebar event INSERT                                          |            1 | fixed                                     |
| Exact request completion UPDATE                               |            1 | fixed                                     |
| `COMMIT`                                                      |            1 | `ROLLBACK` replaces it on failure         |
| **Accepted transaction total**                                | **17 or 18** | subject cardinality                       |
| **Accepted total including the two locators**                 | **19 or 20** | subject cardinality                       |

A closed subject stops after deadlines, identity, subject locks and the closure
lookup: 8/9 statements in the transaction, or 10/11 including the two preflight
reads. An initially missing or unauthorized identity uses five transaction
statements, or seven including preflight. A request missing or expired at its
retained pin uses 13/14 transaction statements, or 15/16 including preflight,
and performs no mutation.

The longest ownership-change retry reaches the caller-local thread re-read in a
12/13-statement failed transaction, including its `BEGIN` and `ROLLBACK`. With
the fixed three-attempt bound, two such failures followed by success use at most
43 statements for a same-owner Agent or 46 for a distinct shared owner,
including the two unrepeated preflight reads. Database and request-pin failures
are not retried by this ownership loop. These counts were recalculated from the
merged runtime at validation baseline `a686e46b0f2a149b0519582e066ec2d752f798de`;
the validation changes do not modify runtime SQL. They are source-derived
statement counts, not endpoint or production latency.

### Local planner evidence

A rolled-back local PostgreSQL 18.6 fixture seeded 50,000 authorization requests
and 50,000 erasure jobs, then ran `EXPLAIN (ANALYZE, BUFFERS)` on the runtime
query shapes. The exact `request_token_hash = $hash LIMIT 1 FOR NO KEY UPDATE`
predicate used `idx_computer_use_auth_requests_token_hash`; because that index
is unique, both the rows returned and index candidates are bounded to zero or
one. The hit/miss plans touched 5/3 shared buffers.

The fresh closure predicate is an OR of exact `(subject_kind, subject_id)` pairs
for the canonical thread user, distinct Agent owner and Agent organization. It
used a bitmap OR of three `account_erasure_subject_generation` prefix scans;
the one-generation synthetic hit/miss plans touched 10/9 shared buffers. Its
`LIMIT 1` bounds only rows returned to zero or one. It does **not** bound
historical rows scanned: the unique index suffix is `generation`, so every
stored generation for any matching subject remains an eligible index candidate.
The local plan confirms intended index choice and predicate shape, not a
constant scanned-row bound, benchmark, route latency or production latency.

## Host and residual boundaries

Apply takes no host lock after thread admission and does not recheck the host in
the transaction. This preserves the existing preflight and its known race:
eligibility can change after preflight. Host stop/revocation takes the host `FOR
UPDATE` before clearing bound threads; adding thread-to-host locking here would
invert that order. Host-grant/revocation linearization remains separate work.
The direct host setter's documented offline-allowed behavior is not imported;
Apply keeps its stricter online and heartbeat requirements.

Legacy Teams Apply still uses route/connection authority and its existing
separate completion write. Authorization reads, legacy source handling and host
lifecycle/grant behavior remain parent residuals. This change makes no claim
that those paths or the host preflight race are repaired.

## Regression evidence

The focused route suite uses real PostgreSQL and production HTTP entry points.
Its fixtures pause actual statements, inspect real `pg_blocking_pids` edges and
own every holder, Apply, closure, mutation, competitor, trigger and transaction
through teardown. Fixture setup failures reach the caller, and registered
asynchronous cleanup always releases and joins the outer transaction. An
expected-early-exit regression starts both Apply and closure before abandoning
the barrier callback, then proves Apply settled, removes the exact closure row
and reacquires the real thread lock before the test can finish.

The 25 focused cases cover canonical web, Slack and Teams creation;
three-subject closure/recovery; writer-first and closure-first ordering; missing,
deleted and foreign canonical threads; exact request deletion and every stored
identity mutation; thread-user, Agent-owner and Agent-organization pre-admission
and post-resolution reselection; null Agent; lock-wait expiry; concurrent
same-thread requests; scoped completion failure; cancellation before and after
the final check; timeout propagation; absent runs; repeat Apply; and exact
per-owner publication counts plus complete channel lists.

The request-pin coverage has two distinct windows. The retained post-pin case
proves thread/Agent identity cannot move after Apply owns the request. A separate
real PostgreSQL request-row holder now forces Apply to wait before it can own the
request; while it waits, recursive `pg_blocking_pids` evidence proves the
transitive holder → Apply → thread-user/thread-Agent and Agent-owner/Agent-org
blocker chains. An unrelated owner completes and publishes in that window, and
the target publishes exactly once only after release.

At this validation baseline, the focused suite passed 25/25 with one Vitest
worker against local PostgreSQL 18.6. The reported 25.63-second Vitest process
wall time included transform/import/setup work; test execution occupied about
52% of that process. The existing 26 request-creation cases and 24 Computer Use
BDD cases remain unchanged and are part of the focused verification. Every such
local duration is a development-environment measurement, not endpoint or
production latency evidence.

### Fresh hook evidence

The validation used the repository toolchain's Lefthook 1.12.3 and the unmodified
`lefthook.yml` above. The complete staged pre-commit hook ran from
2026-09-18T09:58:37.076Z to 10:00:56.352Z and exited 0 in 139.22 seconds.
Prettier and style-policy passed in 0.77 and 4.15 seconds; platform static assets
and all Rust/Python jobs correctly skipped because no matching file was staged;
Knip found no issues; the 14-package TypeScript check passed in 103.863 seconds
under its unchanged 300-second budget; and file-size passed in 0.01 seconds. A
same-staged-files Knip timing run completed in 35.87 seconds under its unchanged
60-second budget.

The first hook launch exposed a sandbox device problem (`/dev/ptmx` could not
open), before any job executed. After mounting the already-provided `devpts`, an
unmodified retry reached Knip but its default V8 heap exhausted after 46.40
seconds (maximum process-tree RSS 2,242,760 KiB), so the piped type check did not
start. The successful complete retry kept every hook command and timeout
unchanged and set only the process heap ceiling to 3,072 MiB; it observed a
2,582,500 KiB maximum process-tree RSS, zero swap and no timeout. These are fresh
repair-environment results and resource failures, not reconstructed historical
R14 evidence.

### Historical evidence limits

R14 merged as `0c5d2d7ec8f90cb0dca0c3f58fe8dbafbe00237a` from reviewed head
`6147a664dc70fc8d77bd868dd235e4336bc0fc54`. The available GitHub record has no
review object; its `LGTM` marker was posted by `lancy`, the PR author. It is useful
review text but is not evidence of a genuinely independent reviewer. The
`lefthook.yml` at that head is byte-identical to this validation baseline
(SHA-256 `7f6c626681c07ae766cd5e6478217383d69194fac92fa9df717fb2a0b141c3b4`),
but no complete historical transcript was available to prove the exact
Lefthook binary version, executed hook set or job budget. Therefore this
validation relies on its own full-HEAD independent review, current hooks and
protected CI rather than upgrading those historical artifacts into claims they
do not support.
