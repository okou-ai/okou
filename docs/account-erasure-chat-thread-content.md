# Account erasure: direct draft and manual title writes (B2b2-R3)

Scope: [#34725](https://github.com/vm0-ai/okou/issues/34725), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the two
direct chat-thread content writers with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the canonical parent lock
contract accepted for [run output](account-erasure-run-output.md) and the
[chat search projection](account-erasure-chat-search.md). It installs no closure
decision, ingress, worker, schema, migration or production operation.

A composer draft, its attachment descriptors and a manual thread title are
account content, not platform billing. This slice stops both writers from
producing **new** content for a closed subject; content that is already durable
is historical data owned by C2/D/H and is not erased here.

## The two covered writers

| Entry point                                               | Writes                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PATCH /api/chat-threads/:id` -> `updateChatThreadDraft$` | `chat_threads.draft_user_message`, `chat_threads.draft_attachments`         |
| `POST /api/chat-threads/:id/rename`                       | `chat_threads.title`/`renamed_at`/`updated_at`, one `renamed` sidebar event |

Before this change the draft writer ran a single `UPDATE` matched only on thread
id and requesting user, with no transaction, no B1 admission and no canonical
parent lock. The rename route already used one transaction for the title, the
durable sidebar sequence and the `renamed` event, and already checked user,
organization and Agent existence, but it took no B1 admission either. A closed
account could keep writing new drafts and new titles through both.

## Canonical identity and its nullable parent

`withChatThreadContentWrite` resolves a **content-free** identity from the real
persisted parents by primary key: the thread's own `user_id` plus, when the
thread has an Agent, that Agent's id, `owner` and `org_id`. Carrying no title,
draft or attachment is what allows admission to run before any content write.

`chat_threads.agent_id` is nullable and the draft writer accepts an owned thread
without an Agent, so such a thread has a **thread-user subject only**. The draft
endpoint deliberately requires no organization, and that stays true: a null
Agent is not turned into an organization requirement, and it is not rejected.

A **non-null** `agent_id` that does not resolve is the opposite case: a missing
canonical parent. `agent_id` cascades from `agents`, so the only way to observe
it is the READ COMMITTED window in which that cascade has committed. The
resolution raises `ChatThreadContentOwnershipChangedError` and the attempt
reselects; it never degrades to admitting the thread user alone.

The request's own `userId`/`orgId` and any stored sidebar label are never
authority. They are compared against the resolved identity through the caller's
`authorize` predicate, which is each route's existing ownership contract:

- draft: `identity.userId === auth.userId`, nothing more.
- rename: `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`, on top of the unchanged `requireOrganization`
  and `chat-thread:write` route configuration.

`authorize` runs before admission, so an unauthorized request never takes
another account's subject locks. It is a pure function of the identity that
revalidation compares field by field, so the locked re-read needs no second
evaluation. User and organization remain separate subject domains, and a shared
Agent's owner is a user subject distinct from the thread user, so at most three
subjects are admitted.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE** when present, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. Only then the draft `UPDATE`, or the title `UPDATE` plus the sidebar sequence
   reservation and the `renamed` event insert.

The order is **subjects -> Agent -> thread -> content**, matching the run-output
writer and the search projector. Every barrier is retained through `COMMIT`, so
a closure that arrives after admission waits for this writer to finish instead
of racing it.

`agents` carries the `(id, org_id, owner)` unique key, so KEY SHARE conflicts
with an owner or organization transfer and with Agent deletion, which cascades
the thread. `chat_threads` KEY SHARE conflicts with the `FOR UPDATE` that
`deleteChatThread$` takes before removing the row, and with the cascade from an
Agent delete. Neither conflicts with the `FOR NO KEY UPDATE` that this
transaction's own title or draft `UPDATE` takes, so unrelated draft and rename
traffic is never serialized: two writers on the same thread still queue on that
row update exactly as they did before, and writers on other threads do not
interact at all. Nothing takes a global lock, scans a table or orders a lock
after `chat_threads`, so no cycle is introduced against thread deletion, Agent
transfer or deletion, the search projector, the run-output writer or the sidebar
sequence consumers, which all reach `chat_thread_event_sequences` after the
thread.

## Failure contract

| Outcome                                 | Disposition                                                   |
| --------------------------------------- | ------------------------------------------------------------- |
| Thread missing, foreign or unauthorized | Each route's existing `404 Chat thread not found`             |
| B1 subject closure                      | The same existing `404`, with no write and no event           |
| Identity moved under the locks          | Roll back and reselect, at most three attempts                |
| Attempts exhausted                      | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort     | Original database error or cancellation, propagated unchanged |

Closure reuses the existing not-found disposition, so the endpoint stays
non-oracular: a caller cannot distinguish a closed account from a thread that
was never theirs. Closure is **not** a success `204`, and a timeout, a blocked
parent lock or a cancelled request is **never** reported as a fabricated `404`.

Success semantics are unchanged. Draft overwrite, clear, null fields and
attachment descriptors behave exactly as before, and the draft path still
publishes no sidebar event or invalidation. Rename keeps title, `renamed_at`,
`updated_at`, the caller-supplied event id, the durable sidebar sequence and the
`renamed` event in one transaction, and `publishThreadListChanged` still runs
only after a successful commit. A denied or rolled-back rename consumes no
sequence id and appends no event; the next accepted rename takes the very next
sidebar sequence. This adds no permanent erasure exemption for sidebar records.

## Residual work

This is a producer fence only. It does not erase any existing draft, title,
attachment descriptor, sidebar event or snapshot, and it does not complete B2,
A2 or account erasure. Still open in the parent epic:

- The generated/LLM title workflow and its late completion callback.
- Create, send, edit and revoke message flows, and send-coupled draft clearing.
- Pin, read state, model, service tier, browser and other thread metadata.
- The sidebar snapshot projector, shared and public titles.
- File upload and delete, provider egress, and other remote side effects.
- Historical cleanup, inventory and purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
