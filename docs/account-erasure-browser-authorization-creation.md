# Account erasure: cloud browser authorization request creation (B2b2-R12)

Scope: [#35096](https://github.com/vm0-ai/okou/issues/35096) under
[#33745](https://github.com/vm0-ai/okou/issues/33745).

This slice fences `POST /api/browser/authorization-requests`. It reuses the
dormant [B1 subject barrier](account-erasure-foundation.md) and the canonical
[chat-thread content admission](account-erasure-chat-thread-content.md). The
related authorization-link [apply path](account-erasure-browser-authorization-apply.md)
was fenced separately; its behavior is not redesigned here.

It adds no closure ingress or decision, schema, migration, request cleanup,
active-run requirement, browser activation, provider call, compute lease or
production operation.

## Retained data and why the locator is not authority

A successful call inserts exactly one `browser_authorization_requests` row:

- SHA-256 of a newly generated opaque request token;
- authenticated organization and user;
- the exact run and canonical thread captured by the initial lookup;
- one-hour expiry plus equal creation/update timestamps; and
- a null completion timestamp.

Only the hash is stored. The raw token is returned inside the configured
`APP_URL` after the transaction commits. Creation appends no chat event,
reserves no sidebar sequence, publishes no realtime message and does not start
or enable a browser.

`browser_authorization_requests.run_id` and `.chat_thread_id` deliberately have
no foreign keys. Therefore the initial run lookup is only a locator. It selects
the run's thread and non-null trigger discriminator under the authenticated
run/user/organization labels, without a row lock, and the admitted transaction
must prove the original tuple still exists before inserting. It never follows a
run that was rebound to another thread.

The canonical authority is resolved from `chat_threads` and its real Agent:

- thread user must equal the authenticated run user;
- the thread must have a resolvable, non-null Agent; and
- that Agent's organization must equal the authenticated run organization.

Admission covers at most three deduplicated subjects: thread user, a genuinely
distinct shared-Agent owner, and organization. An unauthorized or incomplete
identity is rejected before another account's subject locks are acquired.

## Lock order and identity retry

Every accepted attempt is one bounded `READ COMMITTED` transaction. Its order
is:

1. configure the existing `1s` lock timeout and `5s` statement timeout;
2. resolve the content-free canonical thread identity;
3. authorize it and take sorted shared erasure-subject advisory locks;
4. read the closure projection after all subject waits;
5. retain Agent `FOR KEY SHARE`;
6. retain thread `FOR KEY SHARE` and re-read the canonical identity;
7. locally upgrade this thread to `FOR SHARE` and re-read its user/Agent tuple;
8. retain the **exact original run** `FOR SHARE`, matching id, user,
   organization, original thread and original non-null trigger discriminator;
9. compute validity timestamps, insert the request, run the helper's final
   in-transaction abort check, then `COMMIT`.

The effective order is **subjects -> Agent -> thread -> run -> INSERT**, with
all acquired barriers retained through `COMMIT`.

The shared helper's thread `FOR KEY SHARE` is intentionally not strengthened for
other callers. It blocks deletion but permits a non-key `chat_threads.user_id`
or `.agent_id` update. That was sufficient before this caller added a possible
run-lock wait, but it could leave this creation attempt holding admitted subjects
for an old thread identity. Creation therefore acquires `FOR SHARE` before the
run pin and compares the locked row to the identity already admitted.

If that tuple changed, it throws the helper's existing
`ChatThreadContentOwnershipChangedError`. The whole transaction rolls back and
the helper starts a fresh attempt, resolving and admitting any newly discovered
subjects before taking business-row locks. There are at most three attempts.
The original run locator is fixed across retries, so retry can never silently
retarget the request.

`agent_runs FOR KEY SHARE` would be ineffective here: PostgreSQL permits
non-key updates to run user, organization, thread and trigger while that mode is
held. `FOR SHARE` conflicts with those row updates and with deletion. A test
changes non-key `trigger_source` and proves the updater is blocked by the
retained pin; another deletes the run and observes the same blocker relation.
This mode can briefly contend with status and heartbeat updates to the same run.
The request keeps the shared helper's existing per-statement timeout bounds and
contains no external call while the locks are held.

The order agrees with existing Agent/thread-before-run paths. Creation inserts a
fresh authorization row only after the run pin. Apply locks an existing request
only after subjects, Agent and thread. Token reads take no row lock. There is no
request-before-Agent/thread inverse.

## Complete SQL and cost inventory

The table below is source inventory, not an `EXPLAIN` estimate. Every selection
returns bounded cardinality; where matching historical rows can exceed that
returned cardinality, the table says so explicitly. There is no page, batch,
recursive query or application loop over database rows.

| Order | Statement shape                                                                                                                            | Table/index and returned cardinality                                                                                                                                                              | Lock or cost note                                                                                          |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
|     0 | `SELECT chat_thread_id, trigger_source FROM agent_runs WHERE id = ? AND org_id = ? AND user_id = ? AND trigger_source IS NOT NULL LIMIT 1` | `agent_runs` primary key on `id`; zero or one row, remaining labels revalidated as filters                                                                                                        | Outside the transaction and unlocked; locator only. No status predicate.                                   |
|     1 | `BEGIN ISOLATION LEVEL READ COMMITTED`                                                                                                     | No table                                                                                                                                                                                          | One per attempt.                                                                                           |
|     2 | `SELECT set_config('lock_timeout', '1s', true)`                                                                                            | No table; one scalar row                                                                                                                                                                          | Transaction-local existing bound.                                                                          |
|     3 | `SELECT set_config('statement_timeout', '5s', true)`                                                                                       | No table; one scalar row                                                                                                                                                                          | Transaction-local existing bound.                                                                          |
|     4 | Thread/Agent identity `SELECT` with `chat_threads LEFT JOIN agents`, by thread id, `LIMIT 1`                                               | Primary-key lookup on each table; zero or one joined row                                                                                                                                          | Unlocked authorization read; content-free fields only.                                                     |
|     5 | `SELECT current_setting('transaction_isolation') FROM (VALUES (1)) AS erasure_isolation_probe`                                             | No table; exactly one scalar row                                                                                                                                                                  | Verifies `READ COMMITTED` before any subject lock is taken.                                                |
|     6 | `SELECT pg_advisory_xact_lock_shared(hashtextextended(...))`                                                                               | No table; one call for each sorted deduplicated subject                                                                                                                                           | Two calls for an Agent owned by the thread user; three for a distinct shared-Agent owner.                  |
|     7 | `SELECT id FROM account_erasure_jobs WHERE (kind,id) ... LIMIT 1`                                                                          | Exact pairs use the `(subject_kind, subject_id)` prefix of `account_erasure_subject_generation`; zero or one row is returned. Each of at most three pairs can have multiple matching generations. | New `READ COMMITTED` statement after every advisory wait.                                                  |
|     8 | `SELECT id FROM agents WHERE id = ? FOR KEY SHARE`                                                                                         | Agent primary key; exactly one for an accepted identity                                                                                                                                           | Retained through commit; protects canonical Agent key/transfer/delete semantics used by the shared helper. |
|     9 | `SELECT id FROM chat_threads WHERE id = ? FOR KEY SHARE`                                                                                   | Thread primary key; zero or one row                                                                                                                                                               | Retained through commit; blocks deletion.                                                                  |
|    10 | Repeat the content-free thread/Agent identity `SELECT`                                                                                     | Same primary-key plan and zero/one cardinality as order 4                                                                                                                                         | Detects changes committed while earlier locks were acquired.                                               |
|    11 | `SELECT user_id, agent_id FROM chat_threads WHERE id = ? FOR SHARE`                                                                        | Thread primary key; zero or one row                                                                                                                                                               | Creation-only stronger pin; blocks every thread row update/delete and closes the non-key identity window.  |
|    12 | `SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND org_id = ? AND chat_thread_id = ? AND trigger_source = ? LIMIT 1 FOR SHARE`    | Run primary key; zero or one row, all original labels are residual exact predicates                                                                                                               | Retained effective run pin; no retarget and no active-status check.                                        |
|    13 | `INSERT INTO browser_authorization_requests (...) VALUES (...)`                                                                            | One row; primary key generation and unique token-hash index maintenance. Run/thread columns cause no parent lookup because they have no foreign keys.                                             | Happens only after every admission and identity pin.                                                       |
|    14 | `COMMIT`                                                                                                                                   | No table                                                                                                                                                                                          | Releases advisory and row locks together. A failed attempt uses `ROLLBACK` instead.                        |

For the ordinary same-owner Agent path, one accepted attempt has **15 SQL
statements inside the transaction**: seven no-table/control statements (`BEGIN`,
two `set_config`, the isolation probe, two advisory locks and `COMMIT`) plus
eight table statements. With the unlocked locator, the request has 16
statements. A distinct shared-Agent owner adds exactly one advisory-lock
statement: 16 inside and 17 including the locator.

Early dispositions cost less:

- malformed run ids issue no SQL;
- a missing/foreign run or null trigger issues only the locator;
- an initially null-thread run issues only the locator and preserves `409`;
- missing, foreign or Agent-less canonical identity runs `BEGIN`, both settings,
  one identity lookup and `COMMIT` after the locator;
- closure executes the isolation probe, two or three advisory calls and one
  indexed projection lookup, without taking Agent/thread/run locks or inserting;
  including control statements, commit and the locator, that is 10 statements
  for a same-owner Agent or 11 for a distinct shared owner.

An ownership-change retry repeats the bounded transaction, including subject
admission, and ends the failed attempt with `ROLLBACK`. In the longest local
thread-identity mismatch path, a same-owner failed attempt has 13 statements;
a distinct-owner attempt has 14. With two such failed attempts followed by one
success, the absolute source-count ceiling is 42 statements including the
single locator for the same-owner path, or 45 for a distinct shared owner. This
is a statement-count ceiling, not a latency claim.

## Token, timestamps and cancellation boundary

The opaque token is generated before admission, but only its hash can reach the
database. Reusing that in-memory token across a bounded ownership retry is safe:
a failed attempt rolls back, only one accepted attempt inserts its hash, and no
URL is exposed before commit.

The creation time is read once, after subject, Agent, thread and run waits have
completed and immediately before the insert. `created_at` and `updated_at` use
that value; `expires_at` is exactly one hour later. A run-lock wait therefore
does not consume the link's validity window.

The helper checks the real operation signal after the callback has executed and
before dispatching `COMMIT`. An abort observed there rolls the executed insert
back. If an abort arrives after that final in-transaction check, `COMMIT` may
still persist the row while the later signal check suppresses the success
response. That is the explicit committed-row/lost-response boundary; this slice
does not claim that cancellation can roll back a dispatched commit.

## Failure and compatibility contract

| Condition                                                     | Result and durable effect                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Malformed, missing or authenticated-label-foreign run         | Existing `404 Run not found`; no row.                                                    |
| Trigger is null at the initial lookup                         | Existing run-not-found `404`; no row.                                                    |
| Thread is null at the initial lookup                          | Existing unsupported-context `409`; no row.                                              |
| Run disappears or any original run label changes after lookup | Non-disclosing `404`; no stale row and no retarget.                                      |
| Canonical thread missing, foreign or Agent-less               | Non-disclosing `404`; no row.                                                            |
| Thread user/Agent or Agent owner/organization changes         | Locked re-read/retry; safe `404` when the fresh identity is not authorized or is closed. |
| Thread user, distinct Agent owner or organization is closed   | Non-disclosing `404`; no row.                                                            |
| Lock timeout, statement timeout, SQL error or operation abort | Original failure propagates; never translated into `404`/`409`.                          |
| Abort before the final in-transaction check                   | Insert rolls back.                                                                       |
| Abort after that check                                        | Row may commit while the response is lost, as documented above.                          |

Sandbox and Agent run credentials remain accepted, including an Agent token
with no browser capability. Run status is deliberately absent from both the
locator and retained predicates, so a completed run keeps the prior creation
contract. URL construction, token opacity and the one-hour TTL are unchanged.

## Evidence

`turbo/apps/api/src/signals/routes/__tests__/browser-authorization-erasure.test.ts`
uses the real route, PostgreSQL and dormant B1 projection. Creation coverage
includes:

- sandbox and capability-free Agent credentials, an explicitly completed run,
  configured URL, opaque hash-only persistence, exact attribution and TTL;
- initial malformed, missing and authenticated-label-foreign runs at `404`, an
  initially null-thread run at `409`, and a foreign canonical thread at `404`;
- open/closed/restored controls for thread user, a real distinct same-org
  shared-Agent owner, and organization;
- writer-first pause after the real insert reports `rowCount === 1`, proves the
  row is invisible from another session, proves closure is blocked by that
  writer with `pg_blocking_pids`, and lets an unrelated owner create;
- closure-first commit, followed by the waiting creation's fresh projection
  read and zero inserts;
- locator races for run deletion and exact user, organization, thread and
  trigger changes, plus foreign canonical thread, null Agent and Agent
  owner/organization changes; thread deletion races use the production delete
  route and separately account for its legitimate tombstone publication;
- non-key thread-user and Agent rebinds that commit under the shared helper's
  `FOR KEY SHARE`, are caught by the local `FOR SHARE` re-read and force a whole
  attempt retry; a newly discovered closed owner is denied, and a separate
  distinct open same-org owner rebind demonstrates a successful retry;
- retained run non-key update and delete blockers, retained canonical thread
  update and delete blockers, and simultaneous unrelated-run progress;
- TTL sampled after a proved run-pin wait, with a second proved blocker edge
  from this transaction's thread `FOR SHARE` to a non-key thread update;
- a real `INSERT` timeout on a run-scoped temporary-trigger advisory lock that
  unrelated request rows never acquire, operation-signal rollback after an
  observed insert, and the post-final-check committed-row/lost-response boundary;
  and
- unchanged request count, thread fields/timestamp and observable events, plus
  exact realtime channel/topic absence for every denial or rollback; and
- for each thread-user, distinct Agent-owner and organization closure denial,
  reopening and creating a request is followed by a production apply whose
  durable event takes exactly the next sidebar sequence. This follow-up writer,
  rather than the prior highest emitted sequence alone, proves those denials and
  creations reserved no hidden sequence.

Ordering assertions use no sleep. Barrier pauses either hold the result of an
executed statement or stop before a named dispatch boundary; PostgreSQL blocker
edges establish actual waiting relationships.

The successful open-owner rebind case establishes that a whole-attempt retry can
succeed; the closed-owner case separately observes the newly discovered closure
projection. The fresh subject admission and three-attempt bound remain enforced
by the shared helper's source. The suite does not dynamically exhaust all three
attempts, so the 42/45 statement ceilings above are source-derived ceilings, not
claims of a measured three-attempt run. Denial and rollback cases outside the
three closure controls assert the observable event set and exact realtime
channel/topic absence; they do not treat the highest emitted sequence alone as
proof about an unobserved reservation.

Local measurements are reported only as test-run measurements, not endpoint or
production latency. On the implementation worktree's local PostgreSQL 18.6
database after current migrations, the complete final file passed all 44
creation and apply cases in **28.40 seconds** wall clock. That measurement
includes fixture creation, HTTP test setup, closure projection, barrier polling
and cleanup, so it is not a per-request benchmark or a production bound.
