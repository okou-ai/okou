# Canonical authorization read admission

Browser authorization GET and canonical Computer Use `source:chat` GET use the
shared chat-thread content-erasure transaction. This document records the R15-R
lock repair and the final post-authentication SQL contract. It changes no API
shape, schema, isolation level, timeout, host lifecycle, creation or Apply
contract.

## Lock order and concurrency

Both GET callers opt into the shared helper's narrow `threadLock: "update"`
mode. Every other caller keeps the default thread `FOR KEY SHARE` mode.

The canonical GET order is:

1. sorted, deduplicated B1 subjects (thread user, distinct Agent owner and Agent
   organization), using shared advisory locks;
2. Agent primary-key `FOR KEY SHARE`;
3. thread primary-key `FOR UPDATE` as the **first** thread row lock;
4. canonical identity re-read;
5. caller-local same-thread `FOR UPDATE` recheck and projection;
6. exact request `FOR SHARE`;
7. Computer Use host projection, when applicable, without a host row lock.

The caller-local thread statement repeats a lock already held by the same
transaction. It is not a KEY SHARE-to-UPDATE upgrade. Two same-thread GETs can
therefore no longer each retain KEY SHARE before waiting on the other's UPDATE:
one waits at step 3 before it can acquire a later business-row lock.

The following compatibility audit uses actual current callers:

| Caller                                                              | Thread/request/host order                                                                                                  | R15-R effect                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Browser and Computer Use request creation                           | default helper subjects -> Agent KEY SHARE -> thread KEY SHARE; caller thread SHARE -> run SHARE -> INSERT                 | unchanged; SHARE remains compatible with the default retained lock                                            |
| Browser Apply                                                       | default helper through thread KEY SHARE -> request NO KEY UPDATE -> thread update/event/completion                         | GET-first holds UPDATE before Apply can retain KEY SHARE; Apply-first makes GET wait before its request pin   |
| Computer Use Apply                                                  | default helper through thread KEY SHARE -> thread NO KEY UPDATE -> request NO KEY UPDATE -> thread update/event/completion | GET-first holds UPDATE before Apply can retain KEY SHARE; Apply-first makes GET wait at its first thread lock |
| Direct thread settings and other shared-helper writers              | default helper mode and caller-specific lock                                                                               | unchanged; no global lock-strength widening                                                                   |
| Thread deletion                                                     | thread UPDATE before delete                                                                                                | deletion and GET serialize on the same thread row                                                             |
| Host lifecycle                                                      | host lock -> clear thread bindings                                                                                         | unchanged; GET takes no host row lock, so there is no thread -> host lock edge                                |
| Standalone host list                                                | host read only                                                                                                             | unchanged                                                                                                     |
| Legacy persisted Computer Use `source:slack` / `source:teams` reads | legacy scope lookup and standalone host list                                                                               | unchanged; only canonical `source:chat` opts in                                                               |

Canonical Slack- and Teams-triggered requests are still persisted as
`source:chat` and use this transaction. The originating run is not required by a
GET. The fixed request ID/hash/user/organization/run/thread/source labels remain
pins, not authority and never retarget a request.

## SQL inventory

The transaction remains `READ COMMITTED`. These stages are counted as database
statements, including transaction control. `s` is the number of deduplicated B1
subjects (`1 <= s <= 3`); the three-subject case is a distinct thread user,
distinct Agent owner and organization.

| Stage                 | Statement, predicate and lock                                                                                        | Existing index or bound                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| locator               | request-token hash plus exact authenticated `org_id` and `user_id`; no lock; at most one row                         | unique `uq_browser_authorization_requests_token_hash` or `idx_computer_use_auth_requests_token_hash`; additional actor predicates cannot widen the unique hit                                     |
| begin                 | `BEGIN ISOLATION LEVEL READ COMMITTED`                                                                               | unchanged isolation                                                                                                                                                                               |
| controls              | transaction-local `lock_timeout = '1s'`, then `statement_timeout = '5s'`                                             | two statements; no longer budget                                                                                                                                                                  |
| canonical identity    | thread PK lookup with Agent join; at most one thread/Agent pair                                                      | `chat_threads` and `agents` primary keys                                                                                                                                                          |
| first B1 subject      | one folded statement: a guarded shared advisory lock scalar subquery plus `current_setting('transaction_isolation')` | the lock runs only for READ COMMITTED and the returned isolation must be `read committed`                                                                                                         |
| remaining B1 subjects | one shared advisory-lock statement per sorted remaining subject                                                      | at most two additional statements                                                                                                                                                                 |
| closure lookup        | OR over every exact `(subject_kind, subject_id)`                                                                     | `account_erasure_subject_generation` begins with those columns; `LIMIT 1`                                                                                                                         |
| Agent identity        | Agent PK `FOR KEY SHARE`; at most one                                                                                | Agent primary key                                                                                                                                                                                 |
| thread identity       | thread PK `FOR UPDATE`; at most one                                                                                  | thread primary key; this is the repaired first thread lock                                                                                                                                        |
| identity recheck      | same thread PK + Agent join and field-for-field comparison                                                           | primary keys; movement raises the bounded ownership-change retry                                                                                                                                  |
| local projection      | same thread PK `FOR UPDATE`, exact retained user/Agent comparison, browser flag or selected host ID                  | at most one; same-transaction lock retention, not an upgrade                                                                                                                                      |
| request pin           | request PK plus original hash/org/user/run/thread and Computer Use `source = 'chat'`; `FOR SHARE`; at most one       | primary key after the unique-hash locator                                                                                                                                                         |
| clock                 | `nowDate()` after every potentially waiting request lock                                                             | no SQL statement; one clock for TTL and Computer Use heartbeat eligibility                                                                                                                        |
| host projection       | exact org/user, `revoked_at IS NULL`, `ORDER BY last_seen_at DESC`; no lock, limit or pagination                     | `idx_computer_use_hosts_org_user`; its actor/org prefix has seven fixture candidates, the SQL returns six nonrevoked rows and the route returns their five online members; no physical-plan claim |
| finish                | final signal check and `COMMIT`, or `ROLLBACK` on error/retry                                                        | B1, Agent, thread and request locks remain transaction-bound                                                                                                                                      |

### Statement counts

The counts below use the maximum three-subject identity and include the locator,
`BEGIN`, `COMMIT`/`ROLLBACK`, both controls and every stage above.

| Outcome                                           | Browser | Canonical Computer Use | Explanation                                                                                     |
| ------------------------------------------------- | ------: | ---------------------: | ----------------------------------------------------------------------------------------------- |
| wrong actor/org, missing token or locator-expired |       1 |                      1 | exits after the locator; exact actor/org sees expiry before canonical scope                     |
| missing/unauthorized canonical identity           |       6 |                      6 | locator + begin + two controls + identity + commit                                              |
| closed canonical identity                         |      10 |                     10 | adds three B1 lock statements and one closure lookup, then commits without business-row locks   |
| accepted, first attempt                           |      15 |                     16 | Computer Use adds the final host projection                                                     |
| exact request missing/moved or post-pin expired   |      15 |                     15 | request pin is reached; Computer Use does not query hosts after rejection                       |
| one latest-stage ownership retry, then accepted   |      27 |                     28 | one 12-statement rolled-back transaction plus the accepted transaction; locator is not repeated |
| two latest-stage retries, third attempt accepted  |      39 |                     40 | maximum successful bounded retry path                                                           |
| three latest-stage failures                       |      37 |                     37 | maximum exhausted path; all three 12-statement transactions roll back                           |

For fewer subjects, subtract one statement per absent B1 subject from each
transaction attempt. The latest reachable ownership movement is the helper's
identity recheck: after the first thread `FOR UPDATE` succeeds, the retained row
cannot move before the caller-local projection. Earlier movement detection uses
fewer statements. The helper still allows at most three whole attempts and
reuses the original fixed request locator; it does not catch/retry SQL timeout
or deadlock errors.

## Host response bounds

The complete-host route fixture creates nine host rows:

- seven for the exact actor/organization: five online, one nonrevoked offline
  installation and one revoked host;
- one same-organization foreign-user host;
- one foreign-organization host.

The fixture's logical actor/organization index-key scope contains seven
candidates. The SQL predicate returns and serializes all six nonrevoked rows,
and the route returns all five online rows in standalone-list order; no
`EXPLAIN`-based physical-plan claim is made. The fixed fixture's serialized
successful JSON body is **2,605 UTF-8 bytes**. It includes every existing host
field: ID, names, App/OS versions, capabilities, nested permissions, status,
`lastSeenAt` and `createdAt`. A separate zero-host control returns an empty list.
Host cardinality remains deliberately unbounded; no truncation, pagination or
active-run requirement is introduced.

Both empty and populated GETs are read-only: no thread/request/host mutation,
sidebar sequence or realtime publication occurs. Suite wall time is reported
only as local suite time and is not endpoint or production latency.
