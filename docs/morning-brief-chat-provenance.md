# Morning Brief thread provenance and unread Chat collection

Morning Brief must never summarise its own output. Excluding only the thread
the current workflow binding points at is not enough: uninstalling the Official
Workflow deletes that binding, a member can hold more than one installation, and
a thread's title, a single ordinary-looking input, or an unbroken run of event
sequence numbers says nothing about the rest of its history.

So the fact is recorded on the thread. `chat_threads.provenance` is a
server-private classification with three states:

| Value           | Meaning                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| `NULL`          | Unknown. Historical rows, and creation paths that do not classify themselves.       |
| `ordinary`      | A successful new ordinary-Chat INSERT, and nothing else.                            |
| `morning_brief` | The thread has hosted official Morning Brief content. Sticky for the thread's life. |

It is never returned in a Chat or Settings response and never accepted as
input. There is no user-facing provenance field and no Settings surface.

## Producers

[The provenance service](../turbo/apps/api/src/signals/services/morning-brief-thread-provenance.service.ts)
owns every write. `ordinary` is written inline by the INSERT that creates the
thread; nothing upgrades an existing row.

| Ingress                                                                                                                  | Writes                        |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| [Shared ordinary creator](../turbo/apps/api/src/signals/services/chat-thread.service.ts) `createChatThreadInTransaction` | `ordinary` on a real INSERT   |
| [First-send creation](../turbo/apps/api/src/signals/services/chat-events.command.ts) `createChatThread`, both branches   | `ordinary` on a real INSERT   |
| [Automation binding](../turbo/apps/api/src/signals/services/workflow-user-automation-thread.service.ts), new and reused  | `morning_brief` for the brief |
| [Workflow queue admission](../turbo/apps/api/src/signals/services/workflow-chat-event-queue.service.ts)                  | `morning_brief` for the brief |
| [Official source claim](../turbo/apps/api/src/signals/services/chat-events.command.ts) `requiredOfficialWorkflowIds`     | `morning_brief` for the brief |

Queue admission is covered separately from the binding because the scheduler
[skips thread creation when the binding already has a thread](../turbo/apps/api/src/signals/services/workflow-automation-poller.service.ts),
so a change confined to the binding would leave a real gap for every existing
installation.

Official-ness comes from the persisted `workflows.official_definition_name`,
never from a workflow title or display name, which are editable and disappear on
uninstall. Resolution is organization-scoped, because content produced by any
member's installation still lands in the destination thread. Every write is
scoped to the thread's own `user_id`, so a replayed or misdirected request
cannot stamp another member's row.

When a claimed official source does not resolve, the thread is demoted to
unknown instead of keeping a positive `ordinary` value. Guessing in either
direction is unsafe, and a stale `ordinary` would keep the thread eligible.

### Coverage limits

- Creation ingress other than the three paths above leaves `NULL`. Automation
  threads for non-brief workflows are deliberately unknown rather than ordinary.
- A conflicting client-supplied thread id resolves to the existing row and
  writes nothing, so a replay can neither upgrade a historical row nor clear an
  exclusion.
- Every row created before this migration is `NULL`. There is no census that
  could distinguish them, and none is inferred.

### The interface S6 consumes

`excludeMorningBriefChatThread` is the single exclusion write. When S6
introduces direct Morning Brief delivery it must call that operation inside its
own canonical write transaction, so the exclusion and the delivered message
commit together. Do not add a second rule.

## Collection

[The collector](../turbo/apps/api/src/signals/services/morning-brief-chat-collection.service.ts)
is reachable through `POST /api/morning-brief/preview/chat-collection`, a
developer verification surface with no Settings UI. Production answers 404
before authentication, even when `simpleMorningBrief` is enabled for the caller;
the environment decision lives in
[preview endpoint access](../turbo/apps/api/src/signals/routes/preview-endpoint-access.ts)
so a route in the deployed table never imports a test-only helper. Outside
production the route still requires an authenticated organization and user, the
`chat-event:read` capability, the default-off `simpleMorningBrief` switch, and a
live installed and enabled Morning Brief. Its only input is the scheduled
anchor: no thread, owner, Agent or destination may be supplied.

Selection covers unread threads across every Agent the member is authorized for
in the current organization, using the existing terminal marker, read watermark
and no-active-Run semantics, without the sidebar's seven-day presentation limit.
At most 51 candidates are read so overflow is observed, and at most 50 are
processed. Each thread is then read in its own short transaction with a bounded
`lock_timeout` and `statement_timeout`; nothing holds a lock across the whole
collection.

Only a thread classified `ordinary` releases content. `NULL` and any
unrecognised value skip the **whole** thread and report partial coverage — a
visible ordinary-looking input inside an unknown thread is not evidence about
the thread. A deliberate refusal (`destination_thread`, `morning_brief_thread`)
is distinguishable from an unknown one, and complete coverage with zero items is
distinguishable from an empty inbox.

Per thread the collector returns at most 10 visible message excerpts belonging
to the unread terminal Run, bounded by the thread's frozen sequence position.
Thinking, control rows, automation instruction bodies, budget and usage rows,
and revoked or replaced inputs are excluded by construction. Each excerpt is
capped at 4 KiB UTF-8, the whole collection at 64 KiB of text and 15 seconds,
and a stored event larger than 64 KiB becomes an explicit coverage gap rather
than a decoded excerpt. No snapshot or archive is read. Source text is data,
never instructions.

Collection writes nothing: no read watermark, message, Run, result or e-mail,
and no provenance repair.

### The linearization point

The thread row lock is the boundary. The collector takes `FOR NO KEY UPDATE`,
not `FOR KEY SHARE`, because the exclusion write only updates a non-key column:
a `KEY SHARE` lock does not conflict with it at all and the two transactions
would interleave freely. The Agent is locked first with `FOR KEY SHARE`, in the
Agent → thread order the existing canonical writers use, so an owner or
organization transfer and Agent deletion conflict with the read.

- If the read acquires the thread row first, a concurrent official Brief
  admission waits, and the content released is pre-admission content inside the
  frozen sequence bound.
- If the Brief admission commits first, the read waits, re-reads the
  classification it now sees, and discards the entire thread without releasing a
  body.

A collection that already returned a body is not retracted by a later
transition. The guarantee is about which side of the boundary the data came
from, not about revoking data afterwards.

Erasure uses the shared subject admission. The collector writes nothing, but a
closed subject must not release that subject's Chat content either, and taking
the same shared admission means a closure waits for an in-flight collection
instead of completing while one is still reading. A whole-owner invalidation
discards the entire payload rather than part of it.

## Migration and rollout

`1153_chat_thread_morning_brief_provenance` adds one nullable `varchar(32)`
column with no default. Live production metadata at 2026-09-17 04:04:51 UTC
counted 158,927 `chat_threads` rows, including internal owners; that is total
table scale, not eligible coverage. `ADD COLUMN` without a default is a
catalogue-only change at any scale: no table rewrite, no backfill, no explicit
table lock, and no new index — the classification is only read after the
existing user- and Agent-scoped unread selection has already chosen a row.

Deploy the migration before the new code. Old code reads and creates `NULL`
rows safely. A rollback does not drop the column, and production collection
stays disabled because the preview route does not exist there.

Provenance is preserved regardless of the implementation switch, so turning
`simpleMorningBrief` off cannot silently erase evidence that is needed later.

### Activation gate, not a completed guarantee

An old API version can still put official Brief content into a thread already
marked `ordinary` without updating its classification. That is a real
compatibility hazard, and it is the reason production collection remains
disabled in this slice. Before S7 enables collection:

1. Every writer that can deliver official Brief content must be drained,
   upgraded, or constrained by a concrete compatible fence.
2. S6 direct delivery must stamp the sticky exclusion in its canonical write
   transaction.

Historical `NULL` coverage stays explicit until a separately evidenced
classification contract exists. This slice does not claim to preserve every
historical Chat input, and it does not complete production self-exclusion.
