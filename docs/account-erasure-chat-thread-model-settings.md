# Account erasure: direct thread model settings writes (B2b2-R6)

Scope: [#34863](https://github.com/vm0-ai/okou/issues/34863), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences one endpoint,
`POST /api/chat-threads/:id/model-selection`, with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the canonical parent lock
contract accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md) and
[pin writes](account-erasure-chat-thread-pin.md). It installs no closure
decision, ingress, worker, schema, migration or production operation.

A thread's model pin, its per-model reasoning effort, its Codex service tier and
the two sidebar events that mirror them are account content, not platform
billing. This slice stops the route from producing **new** settings state for a
closed subject; settings already durable are historical data owned by C2/D/H and
are not erased here. It fences this one writer and no other writer of the same
columns.

## What this route actually writes

| Durable effect                                                                                                                         | Where it comes from                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `chat_threads.selected_model`, three legacy provider pin columns, `codex_service_tier`, `model_settings`, `updated_at`                 | the route's own `UPDATE`                               |
| One `model_selection_updated` sidebar event and its durable sequence id                                                                | `appendChatThreadEvent`                                |
| One `service_tier_updated` sidebar event and its durable sequence id                                                                   | `appendChatThreadEvent`                                |
| **Lazy `org_model_policies` seeding and default repair**, with `created_by_user_id` / `updated_by_user_id` attributed to the requester | `resolveModelSelectionPin` -> `ensureOrgModelPolicies` |

The last row is the non-obvious one. `resolveModelSelectionPin` is **not** a
pure validator: for a model-first selection it calls `ensureOrgModelPolicies`,
whose slow path takes an organization-local advisory lock, inserts or repairs
the default policy and seeds the missing active models, attributing every row to
the requesting user. Before this change the route resolved that pin _before_
opening its own transaction, so a closed account could still create and repair
account-attributed policy rows even if the thread mutation itself were fenced.

## Canonical identity and admission

The route now calls `withChatThreadContentWrite` and keeps its unchanged route
configuration: `requireOrganization`, `missingOrganizationStatus: 401` and the
`chat-thread:write` capability. `authorize` is this route's existing ownership
contract expressed over the real persisted identity:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`.

That matches the predicate the `UPDATE` already used, where the organization
condition is an `EXISTS` over the Agent's `org_id` and `agent_id IS NOT NULL` is
required. The request's own `userId`/`orgId` and any stored sidebar label remain
comparison inputs, never authority. At most three deduplicated subjects are
admitted: the thread user, the Agent owner when it is a different user, and the
actual organization.

`authorize` runs before admission, and the whole write — including the pin
resolver — runs after it. No policy bootstrap, default repair or attribution
happens on a missing, unauthorized, closed or ownership-retry attempt.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. `chat_threads` **FOR NO KEY UPDATE** and the settings read.
8. `resolveModelSelectionPin`, including any `org_model_policies` bootstrap or
   repair, on a **savepoint of this same transaction**.
9. The feature-switch context, effort resolution and service-tier validation.
10. The settings `UPDATE`, then both sequence reservations and both events.

The order is **subjects -> Agent -> thread -> model policy -> content**. Every
barrier is retained through `COMMIT`.

### Why `FOR NO KEY UPDATE` replaced `FOR UPDATE`

The route previously serialized its sparse `model_settings` read/modify/write
with `FOR UPDATE`. Under the shared helper that is a deadlock: the helper
retains `FOR KEY SHARE` on the same row, `FOR UPDATE` conflicts with
`FOR KEY SHARE`, so two concurrent settings writers each wait for the other's
retained lock. `FOR NO KEY UPDATE` conflicts with another settings, rename or
pin writer — which is exactly the serialization the sparse map needs, and a
waiting writer re-reads the committed row before patching it — but it does not
conflict with a retained `FOR KEY SHARE`, so the upgrade is granted immediately
and the two writers queue instead of deadlocking. The same mode is what a plain
`UPDATE` already takes, so overlapping a settings write with a rename or a pin
write introduces no new conflict either.

Locally, reverting only this mode to `FOR UPDATE` turns the two-writer test into
`canceling statement due to lock timeout` on the admission helper's own `1s`
budget; with `FOR NO KEY UPDATE` both writes commit and both sparse entries
survive.

### Why the policy resolver comes after the thread lock

`resolvePersistedChatThreadModel` already takes `chat_threads FOR UPDATE` and
_then_ reaches `ensureOrgModelPolicies`, so **thread before model policy** is
the established order. Every other bootstrap caller —
`resolveDefaultModelFirstPin` in the welcome-thread and integration-route
services, `resolveModelSelectionPin` in thread creation and in the send path —
passes a plain connection, so its advisory lock is taken and released inside
`ensureOrgModelPolicies`'s own transaction and is never held across a thread or
Agent lock. Taking the settings row lock before the resolver therefore keeps
this route on the existing direction: no transaction can hold the
`model-policy:<orgId>` advisory lock while waiting for a `chat_threads` row, so
no cycle exists against the send-path reconciler. The resolver needs no
serialized settings value, so nothing is lost by locking first.

`ensureOrgModelPolicies` receives the admitted transaction, and Drizzle turns
its nested `transaction` into a `SAVEPOINT` on that same connection. It is
never a second connection and can never commit independently of the thread
mutation.

## Failure contract

| Outcome                                        | Disposition                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Thread missing, foreign, wrong org, null Agent | The existing `404 Chat thread not found`                      |
| B1 subject closure                             | The same existing `404`, with no write, event or policy row   |
| Identity moved under the locks                 | Roll back and reselect, at most three attempts                |
| Attempts exhausted                             | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort            | Original database error or cancellation, propagated unchanged |

Closure reuses the existing not-found disposition, so the endpoint stays
non-oracular. Closure is **not** a success `204`, and a timeout, a blocked
parent lock, a cancelled request or any unrelated SQL failure is **never**
reported as a fabricated `404`.

Success and validation semantics are unchanged for an admitted request: null
model clearing and the three null legacy provider columns, per-model sparse
effort preservation across model switches, dormant stored preferences while the
effort rollout is disabled, the `400` for an explicit effort while disabled or
an unsupported level, the retired-model and unavailable-model `400`s, the plan
`402`, the Fast-mode `400`s, explicit tier `null`, an effort-only update
retaining Fast, a legacy model-only update clearing it, both caller-supplied
event ids, the `fast` -> `priority` sidebar projection, the `204` response and
run-token support with `chat-thread:write`.

One ordering consequence is deliberate: ownership is now resolved before model
validation, so a retired or unavailable model sent against a thread the caller
does not own returns the existing `404` instead of a `400`. An unauthorized
caller no longer learns anything about the catalog, and no longer reaches the
policy bootstrap.

A validation error for an **admitted, authorized** request still commits any
policy initialization the resolver performed, exactly as before this change,
while emitting no thread update, no sidebar event and no invalidation. That
active-request behavior is preserved on purpose; what changes is that a denied
or failed request can no longer leave those policy writes behind.

`publishThreadListChanged` still runs only after a successful `COMMIT`. A denied,
invalid, cancelled or rolled-back mutation consumes no sequence id, appends no
event and publishes nothing; the next accepted update takes the very next two
sidebar sequence ids. No provider or other remote side effect runs under these
locks.

## Acceptance evidence (R6-V)

[#34897](https://github.com/vm0-ai/okou/issues/34897) closes the evidence gap in
the merged implementation. It changes no production code: the route, the shared
admission helper and the policy resolver are unchanged. Every criterion below
maps to an exact test in
`turbo/apps/api/src/signals/routes/__tests__/chat-thread-model-settings-erasure.test.ts`,
or to reused evidence that already exists.

| Original criterion                                                                                                                    | Evidence                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic same-thread overlap, both writers holding the retained `FOR KEY SHARE` before either asks for the settings row          | `serializes concurrent same-thread efforts for different models without losing either`, rebuilt on `withChatThreadContentBarriersFixture` with `stopAt: ["content-lock", "content-lock"]`                          |
| The incompatible `FOR UPDATE` mode fails for the intended conflict                                                                    | `rejects the incompatible FOR UPDATE mode against a live writer's retained KEY SHARE`, using `probeChatThreadRowLockModesFixture` against a real paused writer                                                     |
| Settings/rename overlap at a retained-lock and write boundary, without product-level serialization                                    | `overlaps a settings write with a rename under the shared helper`, `stopAt: ["content-lock", "content-update"]`, with an unrelated owner completing while both are paused                                          |
| Old state visible and nothing published while a successful transaction is paused before `COMMIT`; the notification follows the commit | `publishes nothing until the transaction commits, then exactly one invalidation`                                                                                                                                   |
| Denied and rolled-back writes publish nothing                                                                                         | `denies a model-selection update for a closed thread user ...` and `rolls the pin, effort, the first sidebar event and both sequences back when the second event fails`, both now counting `threadListChanged`     |
| Real request cancellation after the admitted write, with guaranteed rollback                                                          | `rolls the thread update, both events and the policy repair back when the request is cancelled after the write`                                                                                                    |
| Held `model-policy:<orgId>` slow path keeps its own bounded error and recovers                                                        | `propagates a held model-policy lock on the slow path instead of a fabricated response`                                                                                                                            |
| Organization move and canonical parent deletion through this route                                                                    | `re-resolves a transferred Agent organization under the locks ...` and `keeps the existing 404 after the canonical Agent parent is deleted`                                                                        |
| Owner transfer, pre-write lock failure, late second-event rollback, closure denials, policy bootstrap fencing                         | Already covered by the merged suite; unchanged and preserved                                                                                                                                                       |
| Effort levels, retired/unavailable models, Fast mode, omission/null semantics, run tokens                                             | Reused from `chat-threads-model-selection.test.ts`; no duplicate matrix was added                                                                                                                                  |
| Unchanged legacy provider columns and the `402` plan branch                                                                           | Source evidence: `chatThreadModelPinColumns` and the resolver branch are untouched by both this follow-up and the merged change. No database-read exception and no catalog/billing test project was added for them |

Three properties make the concurrency evidence deterministic rather than
probabilistic:

- The barrier binds a stop to the **connection** that issued the fenced
  transaction's identity read, not to the thread id several readers share. Each
  request is started only after the previous barrier reports it is paused, so
  every barrier belongs to one exact HTTP request.
- A barrier pauses **before** its statement is dispatched, so no lock or
  statement timer is running during the observation window, and both barriers
  are released before either writer's 1s lock budget starts. No production
  timeout is changed and no sleep or retry loop is used.
- The `FOR UPDATE` counter-case uses `NOWAIT` against a live writer's retained
  `FOR KEY SHARE`, so the conflict is reported immediately instead of being
  inferred from a timeout.

The cancellation case stops at the thread `UPDATE` and aborts there. The route's
own `throwIfAborted` then runs after the `UPDATE` and both sidebar events, while
`COMMIT` has not been sent. Aborting at the `commit` stop would be unsound
evidence: once `COMMIT` is on the wire the transaction may already have
succeeded, so such a case could not claim a rollback guarantee.

## Local cost evidence

Local synthetic measurements on one sandbox (2 vCPU class, PostgreSQL 18.6,
`vitest run` single process, warm dependency install, no Turbo cache). These are
wall-clock test timings, not production throughput, and they are not an upper
bound for any environment.

| Subject                                      | Baseline `eaf7590f51c70d79a0fdf05ac3effaa6e2026e47` | Candidate                                  |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| `chat-thread-model-settings-erasure.test.ts` | 15 tests, 17.8s file duration                       | 21 tests, 20.4s file duration              |
| Concurrency cases                            | `Promise.all` pair: 106ms + 120ms                   | barrier pair: see the per-case table below |

Per-case timings for the added and rebuilt cases, from the same run:

| Case                                                | Local time                                                |
| --------------------------------------------------- | --------------------------------------------------------- |
| Deterministic same-thread overlap                   | 157ms (baseline `Promise.all` pair: 106ms)                |
| `FOR UPDATE` / `FOR NO KEY UPDATE` probe            | 152ms                                                     |
| Settings vs rename overlap, plus an unrelated owner | 273ms (baseline `Promise.all` pair: 120ms)                |
| Paused-before-commit visibility and publication     | 178ms                                                     |
| Cancellation after the write                        | 190ms                                                     |
| Organization move under the locks                   | 235ms                                                     |
| Deleted canonical Agent parent                      | 126ms                                                     |
| Held `model-policy` key, slow path                  | 1158ms, dominated by the route's unchanged 1s lock budget |

The common policy path is already visible in the merged cases that do not stage
an unrepaired state: they complete in roughly 100-300ms with no advisory lock at
all, against the 1158ms slow-path case above whose cost is the production lock
budget expiring, not added work.

The two policy paths differ by design and by measured cost. The common path,
where the organization already has policies and a valid default, returns from
`ensureOrgModelPolicies` without taking any lock. The slow path -- an unseeded
organization or a missing default -- opens the resolver's savepoint on the
admitted transaction and takes `pg_advisory_xact_lock(hashtextextended(
'model-policy:<orgId>', 0))` before seeding or repairing. Added SQL for this
follow-up is zero: no statement, index or lock was added to the route. The only
new database work is in test fixtures, which take one advisory key or two
`NOWAIT` row locks and always roll back.

## Residual work

This is a producer fence for one endpoint only. It erases no existing model
pin, effort map, service tier, policy row, sidebar event or snapshot, and it
does not complete B2, A2 or account erasure. Explicitly still unfenced, and not
covered by this slice:

- Every other writer of the same columns: the send-path reconciler in
  `chat-thread-model.service.ts`, thread creation, the member model preference,
  and the image/video model and Computer Use host routes.
- The broader model-policy API (`PUT /api/model-policies`) and every other
  caller of `ensureOrgModelPolicies`; this slice fences only the bootstrap this
  route reaches.
- Read cursors, the generated/LLM title workflow, message create/send/edit and
  revoke, run and queue admission, and the sidebar snapshot projector.
- Historical cleanup, inventory and purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
