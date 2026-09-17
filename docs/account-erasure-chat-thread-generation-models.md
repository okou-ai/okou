# Account erasure: direct thread image and video model writes (B2b2-R11)

Scope: [#35023](https://github.com/vm0-ai/okou/issues/35023), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences exactly two
endpoints with the existing dormant [B1 barrier](account-erasure-foundation.md):

- `POST /api/chat-threads/:id/image-model`
- `POST /api/chat-threads/:id/video-model`

It reuses the canonical parent lock contract already accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md),
[pin writes](account-erasure-chat-thread-pin.md) and
[model settings](account-erasure-chat-thread-model-settings.md). It installs no
closure decision, ingress, worker, schema, migration or production operation.

A thread's image and video model pins and the sidebar events that mirror them
are account content, not platform billing. This slice stops the two routes from
producing **new** pin state for a closed subject; pins already durable are
historical data owned by C2/D/H and are not erased here. It fences these two
writers and no other writer of the same columns.

## What these routes actually write

| Durable effect                                              | Where it comes from      |
| ----------------------------------------------------------- | ------------------------ |
| `chat_threads.selected_image_model` and `updated_at`        | the image route `UPDATE` |
| `chat_threads.selected_video_model` and `updated_at`        | the video route `UPDATE` |
| One `image_model_updated` event and its durable sequence id | `appendChatThreadEvent`  |
| One `video_model_updated` event and its durable sequence id | `appendChatThreadEvent`  |

Each route reads its own body, performs one `UPDATE`, reserves one sidebar
sequence id, appends one event with the caller-supplied `eventId` when present,
and publishes `threadListChanged` after `COMMIT`. Neither route performs any
provider request, generation, upload or model-policy bootstrap, and neither
reaches the language-model pin columns, so nothing outside the table above is
fenced or changed by this slice.

## Canonical identity and admission

Each route now calls `withChatThreadContentWrite` at its own explicit caller and
keeps its unchanged route configuration: `requireOrganization`,
`missingOrganizationStatus: 401` and the `chat-thread:write` capability.
`authorize` is each route's existing ownership contract expressed over the real
persisted identity:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`.

That matches the predicate both `UPDATE`s already used, where the organization
condition is an `EXISTS` over the Agent's `org_id` and `agent_id IS NOT NULL` is
required. Those original predicates are retained verbatim inside the admitted
transaction, so an unmatched row still produces this route's existing
`404 Chat thread not found`. The request's own `userId`/`orgId` remain
comparison inputs, never authority. At most three deduplicated subjects are
admitted: the thread user, the Agent owner when it is a different user, and the
actual organization.

No global wrapper and no parallel admission mechanism was introduced; the shared
helper is unchanged.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`), unchanged.
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. The pin `UPDATE` (its own implicit `FOR NO KEY UPDATE`).
8. The durable sequence reservation and the single sidebar event append.

The order is **subjects -> Agent -> thread -> content**, and every barrier is
retained through `COMMIT`. Unlike the model-settings route, neither route needs
an explicit `FOR NO KEY UPDATE` select: they have no sparse read/modify/write to
serialize, and the mode a plain `UPDATE` already takes is compatible with the
helper's retained `FOR KEY SHARE`, so a concurrent image and video pin on the
same thread queues on the row instead of deadlocking on a key-lock upgrade.

## Failure contract

| Outcome                                        | Disposition                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Thread missing, foreign, wrong org, null Agent | The existing `404 Chat thread not found`                      |
| B1 subject closure                             | The same existing `404`, with no write and no event           |
| Identity moved under the locks                 | Roll back and reselect, at most three attempts                |
| Attempts exhausted                             | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort            | Original database error or cancellation, propagated unchanged |

Closure reuses the existing not-found disposition, so both endpoints stay
non-oracular. Closure is **not** a success `204`, and a timeout, a blocked
parent lock, a cancelled operation or any unrelated SQL failure is **never**
reported as a fabricated `404` or `204`.

Success and validation semantics are unchanged for an admitted request: the
catalog `400` for a model outside the shared image or video catalog, the
nullable model that clears the pin, caller-supplied `eventId` reuse appending
once, the event names and payloads, `updated_at`, the `204` response, and run
token support with `chat-thread:write`. Body and model validation still run
before the transaction opens, so an invalid body is still a `400` and never
takes a subject lock.

`publishThreadListChanged` still runs only after a successful `COMMIT`, on the
existing caller `user-org:<userId>:<orgId>` channel whose identity was admitted.
A denied, invalid, cancelled or rolled-back mutation consumes no sequence id,
appends no event and publishes nothing; the next accepted update takes the very
next sidebar sequence id.

## Coverage mapping

`chat-thread-generation-model-erasure.test.ts` runs the first block against both
endpoints, over real HTTP, real PostgreSQL and the real B1 projector.

| Case                                                            | Endpoints |
| --------------------------------------------------------------- | --------- |
| Closed thread user: pin, `updated_at`, event, sequence, publish | both      |
| Closed distinct Agent owner and closed organization             | both      |
| Unrelated owner still accepted while another subject is closed  | both      |
| Writer-first `commit` barrier, closure blocked, baseline reader | both      |
| Late event-insert conflict rolls back and recovers the sequence | both      |
| Operation abort after the executed pin `UPDATE` (`rowCount`)    | both      |
| Thread deleted between selection and the retained locks         | both      |
| Held parent row lock propagates as a failure, not a closure     | both      |
| Wrong user, missing thread and null Agent keep the existing 404 | both      |
| Agent owner transferred between selection and the locks         | image     |
| Agent organization moved between selection and the locks        | video     |
| Null pin clearing with a caller event id                        | both      |
| Caller `eventId` reuse appending once                           | both      |
| Concurrent image and video pin on one thread                    | both      |

Capability, organization, auth and invalid-input contracts stay in the existing
`chat-threads-image-model.test.ts` and `chat-threads-video-model.test.ts`
suites, which are unchanged.

The writer-first case pauses the writer at `COMMIT` with the pin, the sequence
and the event already written, confirms the exclusive B1 closure is actually
blocked through `pg_blocking_pids` rather than a sleep, and asserts a separate
reader still sees the baseline pin and events with no `threadListChanged`
invalidation, while an unrelated owner's write proceeds. The cancellation case
pauses **after** the pin `UPDATE` has executed — `rowCount` is `1`, so it is not
a pre-write lock timeout — aborts the route's own operation signal, and shows
the mutation rolled back with nothing published. A raw client-side fetch
abandonment is not used anywhere as a stand-in for server cancellation, and no
claim is made about rollback after the helper's last in-transaction check or
after `COMMIT`.

## Cost

Per accepted request the admission adds ten statements inside the one existing
transaction, and only six of them touch a table at all:

| Added statement                                           | Count | Table access                                                                                 |
| --------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `SELECT set_config('lock_timeout' / 'statement_timeout')` | 2     | none; session-local settings                                                                 |
| `current_setting('transaction_isolation')` probe          | 1     | none; evaluated over a `VALUES` row                                                          |
| `pg_advisory_xact_lock_shared` per distinct subject       | 2-3   | none; lock manager only                                                                      |
| Closure lookup on `account_erasure_jobs`                  | 1     | predicate on the `(subject_kind, subject_id)` prefix of `account_erasure_subject_generation` |
| `agents` / `chat_threads` `FOR KEY SHARE`                 | 2     | one row each, by primary key                                                                 |
| Identity read, `chat_threads` left join `agents`          | 2     | one `chat_threads` row by primary key plus its `agents` parent                               |

The advisory-lock count is 2 for this slice's common shape, where the thread
user and the Agent owner are the same user, and 3 when a genuinely distinct
shared-Agent owner exists. Every statement targets at most one row, but that is
a property of the predicates, not of the access paths PostgreSQL chooses: the
`set_config`, probe and advisory-lock statements read no table, and the observed
plans for the rest are fixture-scale dependent.

The plans actually observed locally (`EXPLAIN`, PostgreSQL 18.6) on a fixture of
125 `chat_threads` rows in 5 pages, 131 `agents` rows in 10 pages and an empty
single-page `account_erasure_jobs`:

- Identity read: `Nested Loop Left Join`, with a **`Seq Scan on chat_threads`**
  and an `Index Scan using agents_pkey`.
- Closure lookup: **`Seq Scan on account_erasure_jobs`**.
- `agents FOR KEY SHARE`: `LockRows` over `Index Scan using agents_pkey`.
- `chat_threads FOR KEY SHARE`: `LockRows` over a **`Seq Scan on chat_threads`**.
- Pin `UPDATE`: `Nested Loop` with a `Seq Scan on chat_threads` and an
  `Index Scan` on `agents` for the organization `EXISTS`.

`chat_threads_pkey` and `account_erasure_subject_generation` both exist; at this
size a 5-page or 1-page table is simply cheaper to scan than to descend, so the
planner does not use them. These are therefore **local plans on a local
fixture**, not the plans a production-sized table produces, and they are
recorded here as observed evidence rather than as a claim about production
access paths.

The transaction count is unchanged at one per attempt; a reselect costs one more
bounded attempt, capped at three. `lock_timeout` stays `1s` and
`statement_timeout` stays `5s`.

Local same-fixture per-request samples are recorded on the pull request rather
than here, because they are machine- and fixture-scale specific. No universal
latency bound, suite-duration proxy, benchmark project or production throughput
claim is made or implied.

## Residual work

This is a producer fence for two endpoints only. It erases no existing pin,
sidebar event or snapshot, and it does not complete B2, A2 or account erasure.
Explicitly still unfenced, and not covered by this slice:

- Every other writer of the same two columns, including the member model
  preference route and thread creation defaults.
- Language-model preferences, message send/queue/creation, and provider calls,
  generation and uploads for images and video.
- Browser authorization and Computer Use, the sidebar snapshot projector, and
  historical cleanup or purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
