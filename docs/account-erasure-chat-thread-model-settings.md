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
