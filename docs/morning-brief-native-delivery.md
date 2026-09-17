# Morning Brief native delivery

How an accepted `simple-morning-brief` result reaches Chat and email without a
Run. Generation and its platform cost are described in
[the generation contract](morning-brief-generation.md); thread provenance is in
[Morning Brief chat provenance](morning-brief-chat-provenance.md).

## What delivery is

One transaction, one input. The input is a reference to a result that
generation already persisted — never Markdown, a recipient, a thread, an owner,
an Agent or a model supplied by the caller. Delivery never collects, prompts,
calls a provider, starts a Run or touches credits, and it never renders a
second version of the brief: Chat, the plain-text email and the HTML email all
carry the exact Markdown that was accepted.

`POST /api/morning-brief/preview/delivery` is the only entrypoint today. It is
registered in the ordinary API route table and gated by
`isPreviewEndpointAllowed` **before authentication**, so production answers 404
even when `simpleMorningBrief` is enabled for the caller.

## Resolving the result reference

The request carries the opaque `attemptId` the generation preview returned. It
is resolved against `morning_brief_generations` scoped to the authenticated
organization and user, so another member's reference does not exist. The row
must additionally be `execution_purpose = 'preview'`, `state = 'succeeded'`,
`decision = 'deliver'`, carry a title and Markdown, and still be inside its own
`expires_at`. A skip, a failure, a reserved slot and an expired result are all
undeliverable, and an expired result is never recreated to repeat a delivery.

No index is added for that lookup. The generation primary key starts with
`(org_id, user_id)`, so the scan is bounded to one member's own occurrences —
on the order of one per day — rather than the table.

## The delivery transaction

In order, inside one transaction:

1. `lockCollectionOwner` — erasure admission, then the durable
   `org_members_metadata` row, the same order collection and generation take.
2. Resolve the deliverable result (above).
3. Return the existing delivery for this occurrence, if there is one.
4. Re-read the occurrence and require the **frozen** `membership_id` recorded on
   the generation to still match it. A member who left and rejoined is a
   different owner even though the identifiers match.
5. Read the live canonical Morning Brief state and require it installed,
   enabled, and still pointing at the same installation and Agent.
6. `ensureWorkflowUserAutomationThread` — reuse the member's existing Morning
   Brief thread, or create it race-safely under `FOR UPDATE`. No Run, credit or
   provider admission is involved.
7. `excludeMorningBriefChatThread` — exactly the sticky exclusion writer
   `#34815` owns, so the exclusion and the content it describes commit together.
8. `insertChatEvent` with a run-less `output.message`, then
   `touchChatThreadLastMessageAt` for ordering and the sidebar sort touch.
9. Resolve the email intent (below).
10. Insert the delivery row.

A failure anywhere rolls back all of it: there is no partial Chat message,
binding, exclusion or receipt. After commit — and only after — the existing
`publishChatThreadMessageCreatedSafely` notification is published with the
committed `seqId`. It is best-effort by design: a failed publish leaves a
committed delivery that the next canonical read returns, and must never replay
the write.

## Delivery identity and lifetime

`morning_brief_deliveries` is keyed by the collection occurrence, exactly as the
generation is. Purpose, digest, Agent, thread, event and email state are
provenance for that one slot, so no prompt, schema or renderer revision can open
a second delivery of the same occurrence. The row stores no source body, prompt,
rendered text or recipient address; `result_digest` identifies the delivered
body without keeping a copy.

Its lifetime is deliberately longer than the work it describes:

| Related row                 | Relationship          | Why                                                                                                                              |
| --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `morning_brief_generations` | none                  | The result has a bounded retention and is swept. An expired result must not delete the identity that prevents a second delivery. |
| `chat_events`               | none                  | Hot events are retained 30 days; `delivered_at` keeps the unread watermark answerable afterwards.                                |
| `email_outbox`              | none                  | Outbox rows live ~15 minutes. Their cleanup means "the intent is finished", never "this was never delivered".                    |
| `org_members_metadata`      | composite FK, cascade | The durable member row Morning Brief already hangs from.                                                                         |
| `agents`, `chat_threads`    | FK, cascade           | The two lifecycle deletions that invalidate a destination.                                                                       |

## Email

The native template is `morning-brief-result`, distinct from
`official-automation-result` so the drain can demand native provenance. The
legacy template keeps its 8,000 Unicode character and 96 KiB limits unchanged.

Native bounds: body ≤ 32 KiB of UTF-8, matching the accepted result exactly;
title ≤ 160 characters; subject ≤ 180; rendered HTML ≤ 512 KiB, which covers the
worst case where a 32 KiB body of `&` expands to 160 KiB of `&amp;`. Markdown,
link policy and plain-text conversion are the shared primitives the legacy
template already uses. **Nothing truncates.** A body this template cannot carry
intact records `render_rejected` and no email is sent, rather than mailing a
shorter brief than Chat shows.

Recipient resolution reads `user_cache` only. The shared `getUserEmail` helper
refills that cache from Clerk on a miss, and a delivery must never be the thing
that resurrects an erased user's address; a miss records `no_email` and Chat
delivery still stands. Chat delivery is likewise unaffected by
`unsubscribed`, `suppressed` and `render_rejected`.

### The opt-out linearization point

`FOR UPDATE` on a row that does not exist locks nothing, so the delivery
transaction inserts the `users` row with `ON CONFLICT DO NOTHING` **before**
locking it. Explicit unsubscribe and complaint handling upsert that same row, so
a first-time concurrent opt-out either commits before this lock and is observed,
or waits for this transaction and applies from the next delivery onward. The
same lock is retaken by the drain's admission immediately before the provider
request, which is the last point at which no email exists.

### `enqueued` is a handoff, not a pending state this feature owns

`enqueued` means the shared email outbox has the intent. That worker is a real
consumer with its own lifetime, retries, provider idempotency key, committed
request snapshot and `(id, status, attempt)` completion fence; it resolves the
row to sent or failed, or cleanup removes it. This feature adds no second queue
and stores no durable pending state of its own.

### Native admission in the shared drain

Before the provider request is committed, a `morning-brief-result` row is
admitted only if all of this still holds: the delivery row exists; erasure and
the member row admit a write; the occurrence's frozen `membership_id` still
matches; Morning Brief is installed, enabled and on the same Agent; the
destination thread is still owned by that Agent and user; and the recipient has
not opted out. Anything missing fails the row closed — it can never fall through
to a generic send. Suppression stays with the shared drain, which checks every
producer's recipient.

A request the provider has already accepted cannot be recalled. This gate
decides only whether a request is made.

### Owner deletion

`revokeMorningBriefDeliveryOwnership` deletes the delivery rows **and**, from
the outbox identities that delete returns, their still-unsent mail — one atomic
step, because an unsent native intent carries the recipient address and the
rendered brief. Relying on the drain to refuse an orphan is not cleanup. Other
producers and other owners are untouched, and mail the provider has already
accepted cannot be retracted; only its local record goes.

Where it runs, precisely:

| Path                                                 | Transaction                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Agent deletion (`agent-deletion`, `agent-lifecycle`) | The deleting transaction itself, before the cascade removes the receipt.                                                    |
| Thread deletion (`deleteChatThread$`)                | The deleting transaction itself, under the thread's own row lock.                                                           |
| Membership cleanup (`org-member-cleanup`)            | The same transaction that revokes collection ownership.                                                                     |
| Clerk user / organization deletion                   | **A separate later transaction**, after run cancellation and collection revocation — not the earliest committed revocation. |

The Agent and thread rows are the ones that would otherwise cascade the receipt
away and strand its mail, so those two run inside the deleting transaction. The
Clerk paths do not yet share the earliest revocation transaction; a fault
between them leaves the mail to its ordinary outbox lifetime while the next
drain fails it closed.

## Unread

`latestReadWatermarkEventSubquery` now returns the later of two independently
indexed candidates: the latest Run terminal marker, still matching the partial
index `idx_chat_events_thread_run_terminal_created`, and the latest native
delivery for the thread, from `morning_brief_deliveries (chat_thread_id,
delivered_at desc)`. They are combined with `UNION ALL` of two `LIMIT 1`
branches and one outer `ORDER BY … LIMIT 1`, so neither branch degrades into a
disjunctive scan of `chat_events`, and a thread with neither candidate still
produces no row — which is what keeps it out of the four lateral joins.

Only an event a delivery row points at qualifies. The welcome message and every
other run-less output keep exactly their current classification.

The platform's automatic mark-read takes the later of the local Run-terminal
timestamp and the server's own `unreadAt` for the thread. A native-only thread
has no local terminal event at all, so the server signal is the only way it can
clear without fabricating a Run event. A mark-read response that resolves after
a newer delivery has arrived no longer overwrites the local mark past it, so the
newer unread is not swallowed.

## Rollout ordering

Both watermark references are unconditional and run for all four existing
consumers regardless of the feature switch. A default-off switch does not
protect an unconditional SQL reference: `1154_morning_brief_deliveries` must be
applied before these readers deploy. That is schema-before-reader ordering, and
it is the reason the migration ships with them.

The `morning-brief-result` template's reader and its native admission likewise
ship before any producer can enqueue that template. An old worker that has not
deployed this change rejects the unknown template, so production activation
waits until the readers are drained across every worker.

Generated Drizzle snapshots exceed the ordinary 1 MiB file-size limit; they use
the narrow 4 MiB generated-snapshot ceiling in `scripts/check-file-size.sh`.
Schema is never shrunk to fit a metadata limit.

## Not here

Production scheduling, the cron that would pick occurrences, cutover from the
legacy Official Workflow, feature activation and release. No new Settings
control or UI layout change. No second delivery queue, and no change to the
shared outbox's stable id, provider key, committed request, original `createdAt`
lifetime, fresh pre-provider deadline recheck or completion fence.
