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
are not retried by this ownership loop.
These are source-derived statement counts, not endpoint or production latency.

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
own every holder, competitor, trigger and transaction through teardown. It
covers canonical web, Slack and Teams creation, three-subject closure/recovery,
writer-first and closure-first ordering, exact request deletion and identity
mutation, lock-wait expiry, thread/Agent
identity movement, null Agent, concurrent same-thread requests, scoped
completion failure, cancellation before and after the final check, timeout
propagation, absent runs, repeat Apply and exact publication channels.

The existing 26 request-creation cases and 24 Computer Use BDD cases remain
unchanged and are part of the focused verification. Local suite wall times are
development-environment measurements only; they are not endpoint or production
latency evidence.
