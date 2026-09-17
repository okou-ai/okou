# Account erasure: cloud browser authorization apply (B2b2-R10)

Scope: [#34975](https://github.com/vm0-ai/okou/issues/34975), under
[#33745](https://github.com/vm0-ai/okou/issues/33745).

Accepted [R8](account-erasure-chat-thread-computer-use.md) fenced the direct
`POST /api/chat-threads/:id/computer-use-host` route. Approving an existing
cloud-browser authorization link writes the same thread selection state through
a different service, and that path kept a plain transaction. This slice fences
`POST /api/browser/authorization-requests/:requestToken/apply` and its coupled
completion write with the existing dormant [B1 barrier](account-erasure-foundation.md),
reusing the canonical parent lock contract accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md),
[pin writes](account-erasure-chat-thread-pin.md),
[read cursors](account-erasure-chat-thread-read-state.md),
[model settings](account-erasure-chat-thread-model-settings.md) and
[direct Computer Use settings](account-erasure-chat-thread-computer-use.md).

It installs no closure decision, ingress, worker, schema, migration, capability
or production operation, and it fences no other browser writer.

## What this path actually writes

| Durable effect                                                                | Where it comes from                        |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `chat_threads.computer_use_host_id = NULL`, `cloud_browser_enabled = true`, `updated_at` | the service's own `UPDATE`       |
| One `computer_use_host_updated` sidebar event and its durable sequence id      | `appendChatThreadEvent`                    |
| `browser_authorization_requests.completed_at`, `updated_at`                    | the completion `UPDATE`                    |
| One content-free `threadListChanged` invalidation                              | `publishThreadListChanged`, after `COMMIT` |

Nothing else. This apply issues **no** provider or Browser Use request, starts
and stops no session, and none was added here.

## Canonical identity and admission

The opaque token, and the `user_id`/`org_id` stored on the request row, decide
only **which** request was presented. They are not ownership. The service keeps
its existing preflight — token hash plus request user, request organization and
TTL — and then uses the request's `chat_thread_id` purely as a locator for
`withChatThreadContentWrite`.

`authorize` is expressed over the real persisted identity:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`, where `identity.orgId` is the canonical
  Agent's organization.

At most three deduplicated subjects are admitted: the thread user, the Agent
owner when it is a different user, and the actual organization. `authorize` runs
before admission, so an unauthorized request never takes another account's
subject locks, and the subject set is never widened after the business locks.

### Explicit behavior correction

The previous `UPDATE` matched on thread id, thread user and a non-null Agent
only. It had **no organization predicate**, so a request minted while a thread
belonged to organization A still applied after the thread's Agent moved to
organization B, and published a `computer_use_host_updated` event carrying the
stale request organization.

That is now out of scope: the apply returns the route's existing
`404 Cloud browser authorization scope not found` and writes nothing. This is a
deliberate change, not preserved parity; a case covers it.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The service's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. Re-read **this exact request** — same row id, token hash, user, organization
   and thread — **FOR NO KEY UPDATE**, and recheck its TTL.
8. The thread `UPDATE`, the sequence reservation, the event insert and the
   completion `UPDATE`.

The order is **subjects -> Agent -> thread -> request -> content**, and every
barrier is retained through `COMMIT`.

### Why the request pin, and why this mode

Step 7 runs before any content mutation, so a request that was deleted or that
lapsed between the preflight and the write produces the existing `404`/`410`
with **no** partial commit: no thread update, no consumed sidebar sequence, no
event and no completion stamp. The service never writes first and reports
failure afterwards.

`FOR NO KEY UPDATE` is the weakest mode that still blocks a concurrent `DELETE`
of the row, and it is exactly the lock the completion `UPDATE` in step 8 takes,
so the pin never upgrades mid-transaction.

The lock order has no inverse. Every statement that touches
`browser_authorization_requests` anywhere in the repository lives in
`browser-authorization.service.ts`: the creation `INSERT`, the token lookup both
read paths share, and this completion `UPDATE`. Nothing deletes the row — no
endpoint revokes one, the table declares no foreign key that could cascade it
away, and no cleanup job sweeps it — and none of those statements takes a
canonical Agent or thread lock, so no other writer can acquire this row before
`agents` or `chat_threads`.

`chat_threads` keeps taking its own `FOR NO KEY UPDATE` through the selection
`UPDATE`, which does not conflict with the retained `FOR KEY SHARE`, so no new
self-deadlock is introduced and unrelated threads are never serialized.

## Timestamps

The preflight keeps its own clock reading for the TTL check it already
performed. Inside the admitted transaction one further reading is taken and used
for **all** of the write: the TTL recheck, `chat_threads.updated_at`, the event
`created_at` and `completed_at`/`updated_at` on the request. The existing
invariant that those written timestamps share a single value is preserved; the
value is now read at the moment of the write rather than before admission, which
is what lets a TTL that lapses during a lock wait or a bounded reselection be
caught instead of applied.

## Failure contract

| Outcome                                                     | Disposition                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| Unknown token, or token for another user or organization    | The existing `404 ... request not found`                      |
| Request expired at the preflight                            | The existing `410`                                            |
| Request deleted between the preflight and the write         | The same `404`, nothing written                               |
| Request expired between the preflight and the write         | The same `410`, nothing written                               |
| Thread missing, foreign, organization-foreign or Agent-less | The existing `404 ... scope not found`                        |
| B1 subject closure                                          | The same scope `404`, with no update, event or completion     |
| No organization on the session                              | The existing `401`, from unchanged `requireOrganization`      |
| Identity moved under the locks                              | Roll back and reselect, at most three attempts                |
| Attempts exhausted                                          | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort                         | Original database error or cancellation, propagated unchanged |

Closure reuses the existing scope-not-found disposition without revealing which
subject closed, so the endpoint stays non-oracular. Closure is **not** a success
`200`, and a timeout, a blocked parent lock, a cancelled request or any
unrelated SQL failure is **never** reported as a fabricated `404` or `410`.

The route configuration is unchanged: `requireOrganization: true`,
`missingOrganizationStatus: 401`, no `chat-thread:write` capability, and the
success body is still `{ ok: true, cloudBrowserEnabled: true }`. Repeat apply is
unchanged — the token is not consumed and stays usable until its TTL — and a
completed request is therefore still a live writer that closure denies, not a
bypassing no-op.

`publishThreadListChanged` runs only after a successful `COMMIT`, to the
admitted user and organization. A denied, rolled-back, paused or cancelled
request consumes no sequence id, appends no event and publishes nothing.

## Evidence

`turbo/apps/api/src/signals/routes/__tests__/browser-authorization-erasure.test.ts`
holds sixteen cases at the real HTTP boundary against real PostgreSQL and the
real dormant B1 projector. Requests are created with a real run token through
the real create endpoint and applied with a real authenticated session.

- Closure denial for the thread user, for a **legitimately distinct** shared
  Agent owner — a second member of the same organization who owns the Agent from
  the moment it is created, so no transfer is needed to produce the subject —
  and for the organization. Thread state, completion, durable events, sequence
  and outbound invalidation are all unchanged, and the first denied case then
  retires the closure and proves the next accepted apply takes the very next
  sequence id.
- An unrelated eligible owner still applies while another subject is closed.
- A completed request re-applied after a later closure is denied, so the
  existing repeat path cannot bypass closure.
- Writer-first: the apply pauses at `COMMIT` with every write executed; an
  exclusive closure is proved blocked through `pg_blocking_pids`; an independent
  reader still observes the old thread state, a null `completed_at`, the old
  event list and zero invalidations; an unrelated owner applies normally
  meanwhile; after release exactly one invalidation per accepted apply is
  published and the landed closure then denies the next apply.
- Identity gaps: an Agent owner transferred under the locks, a thread deleted
  under the locks, and a cross-organization transfer before the apply.
- Request window: deletion after the preflight, and a TTL that lapses after the
  preflight, both rechecked with no partial write; and the pin itself, where a
  concurrent `DELETE` is observed blocked on the apply's own row lock through
  `pg_blocking_pids` and can only land after `COMMIT`.
- Atomic failure: holding the next `(user_id, org_id, seq_id)` slot makes the
  event insert fail on its own bounded budget after the thread `UPDATE` and the
  sequence reservation, and all four effects roll back together.
- Real operation cancellation **after an executed write**: the barrier pauses
  after the completion `UPDATE` and asserts its `rowCount` is 1, so the thread
  update, the sequence, the event and the completion had all run and were still
  uncommitted; the abort then reaches the writer's existing pre-`COMMIT` check
  and everything rolls back. This is server-side cancellation of the operation,
  not an abandoned client fetch, and it is not a claim about undoing anything
  after `COMMIT`.
- A held parent thread lock propagates as a real failure, not a closure `404`.
- Parity: unknown token, another member's token, a foreign owner's token, an
  unauthenticated caller, an organization-less session, a thread without an
  Agent, and a lapsed TTL all keep their existing dispositions; run-token
  creation, clearing a selected Computer Use host, the exact success body, the
  `completed_at` stamp, repeat apply and a second link minted from the same run
  all still work.

### Baseline failure and candidate pass

Same tree, same fixture, one blob different: the candidate is the fenced
service, the baseline is the identical tree with only
`turbo/apps/api/src/signals/services/browser-authorization.service.ts` reverted
to current `main`'s `491c13c3a8978d45e36679dee5dba3e8da2d24a1`.

| Build     | Result                          |
| --------- | ------------------------------- |
| Baseline  | 14 failed, 2 passed, 284.67 s   |
| Candidate | 16 passed, 19.91 s              |

The two cases that pass on both builds are exactly the parity cases — the
unchanged token/ownership/expiry/Agent dispositions, and run-token creation with
host clearing and repeat apply — which is the intended separation: they assert
behavior this slice preserves. Every fence, atomicity, window and cancellation
case fails on the baseline. The closure cases fail with
`Expected API response status to be one of 404, received 200. Body: {"ok":true,"cloudBrowserEnabled":true}`;
the cross-organization case fails the same way; the expiry-window case fails with
the same shape against `410`. The barrier-driven cases time out on the baseline
because the baseline transaction never issues the identity read the barrier
selects on, and the held-parent-lock case times out because a plain transaction
sets no `lock_timeout`.

## Measured local cost

Local PostgreSQL 18.6 with the repository migrations applied, the API test
harness at its real HTTP boundary, one organization / user / Agent / thread and
four authorization links minted from one run, single process, requests issued
sequentially. Both builds share that fixture and differ in exactly one blob.

### Round-trip inventory

Statements counted per request from the driver, four traced applies per build:

| Request               | Baseline | Candidate |
| --------------------- | -------: | --------: |
| Apply an authorization |       7 |        18 |

Both builds keep the same preflight token lookup, the same thread `UPDATE`, the
same sequence reservation, the same event insert, the same completion `UPDATE`
and one `COMMIT`. The eleven added statements per admitted apply are the two
`set_config` calls, the identity read, the isolation probe, two
`pg_advisory_xact_lock_shared` calls, the `account_erasure_jobs` closure lookup,
`agents FOR KEY SHARE`, `chat_threads FOR KEY SHARE`, the revalidating identity
re-read and the request pin. A thread whose Agent belongs to a different owner
adds one further advisory lock, for three subjects, giving 19.

### Query plans

`EXPLAIN (ANALYZE, BUFFERS)` inside one transaction that had already set the
`1s` and `5s` deadlines, second (warm) execution, on the local fixture:

| Added statement              | Plan                                                                     | Rows | Buffers | Execution |
| ---------------------------- | ------------------------------------------------------------------------ | ---: | ------: | --------: |
| Identity read (left join)    | Nested Loop Left Join, `agents_pkey` Index Scan over a `chat_threads` Seq Scan | 1 | 4 hits | 0.055 ms |
| B1 closure lookup            | Seq Scan on the empty `account_erasure_jobs`                             |    0 |  1 hit  |  0.017 ms |
| `agents` FOR KEY SHARE       | LockRows over `agents_pkey`                                              |    1 |  3 hits |  0.033 ms |
| `chat_threads` FOR KEY SHARE | LockRows over a `chat_threads` Seq Scan                                  |    1 |  4 hits |  0.021 ms |
| Request pin                  | Limit over LockRows over a `browser_authorization_requests` Seq Scan     |    1 |  3 hits |  0.026 ms |

The sequential scans are a property of the fixture, not of the statements: the
local `chat_threads` table held 3 rows, `browser_authorization_requests` 2 rows
for this owner and `account_erasure_jobs` was empty, so the planner preferred a
single heap page. Re-planned with `enable_seqscan = off`, the request pin uses
`uq_browser_authorization_requests_token_hash` (Index Scan, 3 buffer hits,
0.020 ms) and the closure lookup uses the
`account_erasure_subject_generation` `(subject_kind, subject_id)` prefix
(BitmapOr of two Bitmap Index Scans, 2 buffer hits, 0.015 ms). Every added
statement resolves at most one row and none sorts, aggregates or scans a range.
The advisory locks touch no relation at all.

These are bounded local observations on a two-core sandbox with empty erasure
tables. They are not production throughput, not a universal overhead bound, and
not evidence that the added cost is irreducible. The baseline and candidate
suite durations above are whole-suite wall clock dominated by the baseline's
`30 s` case timeouts; they are not a per-request cost comparison.

## Residual work

This is a producer fence for one endpoint only. It erases no existing binding,
cloud-browser flag, sidebar event, authorization request or snapshot, and it
does not complete B2, A2 or account erasure. Explicitly still unfenced, and not
covered by this slice:

- Authorization **request creation** (`POST /api/browser/authorization-requests`)
  and the **read** endpoint. Creation still inserts a row for any subject, and
  the read is unfenced. Both are deliberately left to a later slice.
- `stopComputerUseHost$` and its `clearComputerUseHostThreadBindings`, the
  direct settings route's own retained host-revocation race, thread creation and
  the chat ingress services, and every other writer of thread content: the
  send-path model reconciler, member model preferences, image and video model
  routes, the generated and LLM title workflow, message create/send/edit/revoke,
  run and queue admission, and the sidebar snapshot projector.
- Browser session and provider lifecycle: session creation, resume, stop,
  reconciliation, profiles, egress and every remote provider-side artifact, plus
  Computer Use host registration and revocation and the Teams flows.
- Historical cleanup, inventory and purge of already durable selections,
  completed authorization requests and expired rows.
- Closure ingress, worker activation, independent recovery authority and any
  production erasure, deletion, canary or backfill operation.
