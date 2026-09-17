# Account erasure: generated chat titles (B2b2-R4)

Scope: [#34838](https://github.com/vm0-ai/okou/issues/34838), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). This fences the eager
generated chat-title workflow with the existing dormant
[B1 barrier](account-erasure-foundation.md), reusing the admission helper
accepted for [direct draft and manual title writes](account-erasure-chat-thread-content.md)
and the asynchronous ownership-pin contract accepted for
[activity copies](account-erasure-run-activity.md). It installs no closure
decision, ingress, worker, schema, migration or production operation.

The accepted R3 contract names the generated/LLM title workflow as residual and
does not fence it. This slice closes that one residual producer.

## The covered writer

| Entry point                                                                                               | Writes                                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `scheduleChatThreadTitleGeneration` -> `waitUntil` -> title provider -> `persistGeneratedChatThreadTitle` | `chat_threads.title`/`updated_at`, one `renamed` sidebar event and its sequence |

Two production schedulers reach it: the inline web send route
(`chat-events.command.ts`) and the queued-claim drain
(`internal-chat-run-callback.service.ts`). Both go through the same service
function, so the fence sits in the service and neither caller changed. The
issue's inventory named only the first; the second exists at the audited commit
and is covered by construction.

Before this change the late persistence opened a bare transaction that updated
the title on `id`, `title IS NULL`, `renamed_at IS NULL` and
`agent_id IS NOT NULL` alone, then appended a title-bearing `renamed` event and
advanced the durable sidebar sequence — with no B1 admission, no canonical
parent lock, and no comparison against the identity the title was generated
for. The eligibility check that preceded generation read title and `renamed_at`
by thread id only, so it granted no closure or ownership authority at the point
the provider answered. The provider request routinely outlives the HTTP
response, so a closed account could still receive a new title and a new sidebar
event minutes after closure.

## The ownership pin

A generated title is content prepared for the account that owned the thread when
generation started. Resolving ownership only after the provider answers would
re-attribute that prepared content to whoever survives an ownership change, so
the workflow freezes a **content-free** pin at initiation:

```
{ chatThreadId, userId, agentId, agentOwner, orgId }
```

It carries no prompt, title or draft, which is what allows it to be resolved and
admitted before any account content is read. It is transient: it never reaches a
provider prompt, a public contract, telemetry or a persisted copy.

`agents.org_id` and `agents.owner` are `NOT NULL`, so a resolved Agent always
carries both; they are nullable in the resolved identity only because it
left-joins a nullable parent reference. The generated-title writer requires a
resolved Agent — unlike the legal null-Agent draft thread — so a thread whose
Agent does not resolve has no complete pin and keeps its existing omission.

Comparing the **whole** pin is load-bearing. An Agent owner transfer inside the
same organization moves `agentOwner` alone: a check that stopped at user and
organization would hand a title generated for the previous owner to the
survivor, and would also print the survivor's label on the sidebar event.

## Transaction order

### Initiation: bounded capture and admission

One bounded `READ COMMITTED` transaction, through a read-only sibling of the R3
helper:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution by primary key, left-joining Agents.
3. The scheduling caller's own contract: its `userId` and `orgId` must equal the
   real persisted parents, and the Agent must resolve.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. Title eligibility (`title IS NULL AND renamed_at IS NULL`) and the bounded
   prior-round context read, then `COMMIT`.

A subject already known closed therefore never begins another title generation,
and the identity is fixed before any account content is read. The transaction
commits before the provider await: **no database transaction is held across the
provider request.**

This gate takes **no business lock**, and that is deliberate rather than an
omission. This workflow is scheduled from inside the request that holds the chat
queue's own `FOR UPDATE` on the same thread, which conflicts with `FOR KEY
SHARE`. A gate that took the parent locks would contend with the very request
that scheduled it and delay every eager title behind a bounded lock wait — long
enough for the next scheduler on that thread to still observe it untitled and
start a second, wasted provider call.

The consequence is stated rather than glossed: taking no lock means this gate
carries **no authority**, and the pin it returns is a candidate, not a
permission. A canonical parent can move the instant it commits, and the bounded
context read can cross that move. Nothing is written on its word. Every
guarantee is re-established at completion, where the whole pin is compared again
under retained locks before any row changes.

This is a local initiation boundary only. It is not external-provider fencing
and it proves nothing about provider-side deletion.

### Completion: fresh admission under the frozen pin

The late persistence starts a **fresh** bounded `READ COMMITTED` transaction
through the full R3 write helper, with `authorize` comparing the entire frozen
pin. The order is: deadlines -> identity -> pin comparison -> B1 admission ->
`agents` KEY SHARE -> `chat_threads` KEY SHARE -> revalidation -> the title
`UPDATE`, the durable sidebar sequence and the `renamed` event, all in that one
transaction with every barrier retained through `COMMIT`.

Because `authorize` compares the pin rather than the current owner, a retry can
only ever re-admit the identity this title was generated for. A canonical parent
that moved is simply no longer authorized on the next attempt and the title is
discarded; the pin never rebinds to the survivor, on any attempt. The sidebar
`user_id`/`org_id` and the post-commit invalidation are built from that admitted
identity, after equality with the pin, not from the caller's captured labels.

The existing `title IS NULL AND renamed_at IS NULL AND agent_id IS NOT NULL`
CAS is preserved, so a concurrent manual rename still wins over a late
completion and two concurrent title completions still append exactly one
`renamed` event and consume exactly one sequence id.

## Background lifetime

The scheduler dispatches through `waitUntil` and has no request signal. The R3
helper requires one, and the request's own signal is the wrong source: the send
response is already delivered, so that signal would cancel a legitimate late
completion the moment the client disconnects.

Each fenced transaction instead carries its own `AbortSignal.timeout`, sized as
an outer bound (`30s`) on the helper's own budget of at most three attempts,
each statement capped at `5s` and each lock wait at `1s`. It is a real abort
source and a bound on this background work — not a never-aborting wrapper, and
not a cancellation channel this workflow claims to support. It does not fence
the provider request, whose existing optional-generation semantics, telemetry
and failure classification are unchanged.

Because the inner per-statement budgets are an order of magnitude smaller, the
outer deadline is not the barrier a test observes; the bounded budget the fenced
transaction actually runs under is asserted directly instead.

## Failure contract

| Outcome                                     | Disposition                                                     |
| ------------------------------------------- | --------------------------------------------------------------- |
| B1 subject closure                          | Discarded: no title, timestamp, event, sequence or invalidation |
| Thread missing, moved or no longer eligible | Discarded, with nothing recreated or upserted                   |
| Identity moved under the locks              | Roll back and reselect, at most three attempts                  |
| Attempts exhausted                          | Discarded as an ownership change, not reported as erasure       |
| Lock wait, statement timeout, abort         | The workflow's existing failure handling, unchanged             |

Closure-first means no title, timestamp, event, sequence or invalidation.
Writer-first means an admitted completion commits one coherent title and event,
and the closure waits behind the retained barrier instead of racing it.

This asynchronous optional workflow does not manufacture the manual route's
`404`: the originating send has already succeeded and no title is owed. Closure,
a missing thread and an ownership change are therefore safe discarded results,
while a real timeout, blocked parent lock, cancellation or database error keeps
the workflow's existing failure handling and is never laundered into a
fabricated erasure success.

## Egress is not covered

A provider request already in flight can still complete, and the provider keeps
whatever copy it already received. This fence discards the **new database copy**;
it cannot recall that pre-existing egress. Provider erasure and drain remain B2
and G2 obligations. The prompt truncation, the at most ten visible prior rounds
and the existing auxiliary telemetry are unchanged: no prompt, title or owner
copy was added, and no new retention exception was created.

## Residual work

This is a producer fence only. It erases no existing title, sidebar event or
snapshot, and it does not complete B2, A2 or account erasure. Still open:

- Shared and public snapshot titles, and the sidebar snapshot projector.
- Create, send, edit and revoke message flows, and pin/read/model/browser
  thread metadata.
- Provider egress closure and drain, and the remaining `appendChatThreadEvent`
  producers outside this workflow.
- Historical cleanup, inventory and purge of already durable content.
- Closure ingress, worker activation and any production erasure operation.
