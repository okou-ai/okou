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

| Case                                                                 | Endpoints |
| -------------------------------------------------------------------- | --------- |
| Closed thread user: pin, `updated_at`, event, sequence, publication  | both      |
| Closed distinct shared-Agent owner, with its open-owner control      | both      |
| Closed organization: pin, `updated_at`, event, sequence, publication | both      |
| Unrelated owner still accepted while another subject is closed       | both      |
| Writer-first `commit` barrier, closure blocked, baseline reader      | both      |
| Late event-insert conflict rolls back and recovers the sequence      | both      |
| Operation abort after the executed pin `UPDATE` (`rowCount`)         | both      |
| Thread deleted between selection and the retained locks              | both      |
| Held parent row lock propagates as a failure, not a closure          | both      |
| Wrong user, missing thread and null Agent keep the existing 404      | both      |
| Agent owner transferred between selection and the locks              | image     |
| Agent organization moved between selection and the locks             | video     |
| Null pin clearing with a caller event id                             | both      |
| Caller `eventId` reuse appending once                                | both      |
| Concurrent image and video pin on one thread                         | both      |

Capability, organization, auth and invalid-input contracts stay in the existing
`chat-threads-image-model.test.ts` and `chat-threads-video-model.test.ts`
suites, which are unchanged.

### Publication is proved per channel, not per topic

A `publish("threadListChanged")` call and a `channels.get(<channel>)` call are
two independent facts; neither on its own shows that a given owner's
notification is the one that reached that owner's channel. Every publication
assertion therefore pairs each `publish` with the `channels.get` that routed it,
recovered from the mock's real invocation order by the canonical shared
`helpers/realtime-publications.ts`, first extracted by #35069 and already used
by the browser-authorization and generated-title suites. This suite consumes
that same interface instead of adding a parallel helper.
`publishChatDatabaseSignalNow` performs the `get` and the `publish` in one
expression with no await between them, so the pairing is exact.

Each case asserts both a per-owner count on `user-org:<userId>:<orgId>` and the
full list of channels that carried a `threadListChanged` at all, so an extra
copy on the right channel and a copy misrouted to a wrong channel are both
visible. During the writer-first pause the paused caller's channel stays at
zero while the unrelated owner's accepted write shows exactly one on its own
channel; after release each of the two channels has exactly one and no third
channel appears; the closure rejection that follows adds none.

Two temporary, test-only falsifications were run against the writer-first case
and then removed — neither is committed and neither mutated production code:

| Injected fault                                        | Old topic-only assertion | New scoped assertion                                   |
| ----------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| Duplicate publication on the caller's **own** channel | still satisfiable        | fails: `expected 2 to be 1`                            |
| Extra publication misrouted to a **third** channel    | still satisfiable        | fails: channel list has 3 entries where 2 are expected |

The misroute also leaves both per-owner counts at one, which is why the
cross-channel list is asserted alongside them rather than instead of them.

### Closure matrix and the distinct owner

All three subjects — the thread user, a legitimately distinct shared-Agent owner
and the organization — record the pin, `updated_at`, the event list and the
sidebar sequence before the denial, then show no mutation and no notification,
and then prove the next controlled valid request consumes exactly baseline + 1.

The distinct owner is a **second real member of the same organization**, created
through `bdd.user({ orgId })` and seeded into that organization's membership,
who owns an organization-visible (`public`) Agent created **before** the thread
exists. The caller remains the thread's own user and the Agent stays in the
caller's organization, so the route's unchanged `authorize` — thread user
matches auth, non-null Agent, Agent organization matches auth — is satisfied
throughout. The case runs an **open-owner control** first: with that owner open,
the identical request is accepted, appends exactly one event and publishes
exactly once on the caller's channel. Only then is the owner closed. That is
what separates B1 closure from an ownership or visibility denial reaching the
same `404`; a synthetic `user_<uuid>` assigned to a private Agent after the fact
would prove neither.

### Cancellation and concurrency boundaries

The writer-first case pauses the writer at `COMMIT` with the pin, the sequence
and the event already written, confirms the exclusive B1 closure is actually
blocked through `pg_blocking_pids` rather than a sleep, and asserts a separate
reader still sees the baseline pin and events, while an unrelated owner's write
proceeds.

The cancellation case aborts the route handler's **own operation signal** — the
signal `updateImageModelInner$` and `updateVideoModelInner$` receive and hand to
the admission helper. A raw client-side `fetch` abandonment is a different thing
that the server never observes, and it is not used anywhere in this slice as a
stand-in for cancellation. The barrier pauses **after** the pin `UPDATE` has
executed — `rowCount` is `1`, so it is not a pre-write lock timeout — and before
the helper's last in-transaction abort check, which is the only window in which
that check can still convert the abort into a rollback. Nothing is claimed about
an abort arriving after that final check or during `COMMIT`: such a `COMMIT` can
still succeed, and establishing otherwise would require a runtime cancellation
redesign that this slice does not request.

The concurrent image-and-video case is an **observed outcome of two overlapping
requests**: both pins land and take two adjacent sequence ids instead of
deadlocking, because the mode a pin `UPDATE` takes is compatible with the
helper's retained `FOR KEY SHARE`. It does not pin the interleaving and is not
evidence that both transactions held their locks at one deterministic instant;
proving that would need its own barrier and is a separate concurrency question.

## Cost

Measured on a local PostgreSQL 18.6 with a temporary, uncommitted recorder that
proxied `Client.prototype.query` on a freshly opened pool and counted every
statement an accepted request issues, `BEGIN` through `COMMIT`. The fixture was
125 `chat_threads` rows in 5 pages, 131 `agents` rows in 10 pages, 328
`chat_thread_events` rows, 131 `chat_thread_event_sequences` rows and an empty
single-page `account_erasure_jobs`, with one organization, one Agent and one
thread per case, all created through the product routes. The raw evidence was
first recorded on [PR #35030 comment 5717215837][cost-comment], whose
`docs`-facing arithmetic this section corrects; the samples, method and fixture
scale below are that comment's, unchanged.

[cost-comment]: https://github.com/vm0-ai/okou/pull/35030#issuecomment-5717215837

Counting `BEGIN` and `COMMIT`, an accepted request goes from **5 statements to
15** on both endpoints — 16 when a genuinely distinct shared-Agent owner adds a
third subject. The admission therefore adds **ten** statements inside the one
existing transaction, and they split **five and five**:

| Added statement                                           | Count | Touches a table? | Access                                                                                       |
| --------------------------------------------------------- | ----- | ---------------- | -------------------------------------------------------------------------------------------- |
| `SELECT set_config('lock_timeout' / 'statement_timeout')` | 2     | no               | session-local settings                                                                       |
| `current_setting('transaction_isolation')` probe          | 1     | no               | evaluated over a `VALUES` row                                                                |
| `pg_advisory_xact_lock_shared` per distinct subject       | 2 (3) | no               | lock manager only                                                                            |
| Identity read, `chat_threads` left join `agents`          | 2     | yes              | the unlocked resolution and the locked revalidation                                          |
| `agents` / `chat_threads` `FOR KEY SHARE`                 | 2     | yes              | one row each                                                                                 |
| Closure lookup on `account_erasure_jobs`                  | 1     | yes              | predicate on the `(subject_kind, subject_id)` prefix of `account_erasure_subject_generation` |

So of the ten added statements **five touch no table at all** — the two
`set_config` calls, the isolation probe and the two advisory subject locks — and
**five touch a table**: the two identity reads, the two parent `FOR KEY SHARE`
locks and the closure lookup. The advisory-lock count is 2 for this slice's
common shape, where the thread user and the Agent owner are the same user; a
distinct shared-Agent owner adds a third lock, which makes it six no-table and
five table-touching added statements out of eleven.

Most of these statements target at most one row because of their predicates. The
closure lookup is the exception and must not be described that way: its
predicate is only `(subject_kind, subject_id)` OR-ed across the two or three
subjects, with no generation column, so several rows can match. It returns at
most one row because the query carries **`LIMIT 1`** — it only needs to know
whether any closure exists — not because its predicates identify a single
generation or subject.

The plans actually observed locally (`EXPLAIN`, same fixture):

- Identity read, and the locked revalidation: `Nested Loop Left Join`, with a
  **`Seq Scan on chat_threads`** and an `Index Scan using agents_pkey`.
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

### Per-request samples

Ten sequential accepted image-model pins on the same warm fixture, same command
and same process (milliseconds of wall clock around the request), in the order
they were taken:

- Baseline (audited `main` routes): 14.4, 5.2, 5.2, 5.1, 5.1, 6.2, 5.3, 6.3,
  6.1, 4.6
- Candidate: 23.1, 12.6, 11.9, 11.5, 11.5, 11.5, 10.5, 11.8, 11.8, 8.0

|           | min | median | max  | n   |
| --------- | --- | ------ | ---- | --- |
| Baseline  | 4.6 | 5.25   | 14.4 | 10  |
| Candidate | 8.0 | 11.65  | 23.1 | 10  |

Both medians are recomputed from the raw numbers above as the mean of the fifth
and sixth sorted samples: baseline `(5.2 + 5.3) / 2 = 5.25` and candidate
`(11.5 + 11.8) / 2 = 11.65`. The original comment rounded these to `5.3` and
`11.8`; the values here supersede that rounding. The first sample in each row is
a cold outlier and is kept rather than dropped.

These are small raw local samples on one developer container against a loopback
database, with the sequential-scan plans above rather than production plans.
They are **not** a latency bound, a suite-duration proxy, a benchmark project or
any claim about production throughput or overhead, and no production access path
or cost is inferred from them.

## Verification history

The implementation PR #35030 landed without the repository's configured hook
runner installed: its owner reported running the hook jobs by hand, including a
docs-only final commit, so the original TypeScript surface was never checked by
`lefthook` itself. Installing the runner for this follow-up does not change what
happened then. This evidence repair installs `lefthook` normally and genuinely
stages its changed TypeScript test surface, which matches the normal Turbo glob
and runs the unmodified Prettier, style-policy, Knip and full-workspace
TypeScript jobs under their configured 60-second and 300-second budgets. The two
production route blobs and the shared admission helper remain byte-identical to
canonical `main`. This later verification does not retroactively turn the
earlier manual job selection into a normal hook run.

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
