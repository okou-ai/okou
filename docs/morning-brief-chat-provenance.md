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

### The binding producer's lock order

The automation binding writes the exclusion to a thread it did not create, so
it shares rows with
[thread deletion](../turbo/apps/api/src/signals/services/chat-thread.service.ts),
which locks the thread `FOR UPDATE` and then locks every binding pointing at it
before disabling those automations. Both sides therefore take the **parent
Agent and workflow, then the destination thread, then the binding row**, and the
deletion adds nothing before its thread lock.

Reuse cannot find its destination under the binding lock and only then write to
that thread: that is the opposite order, and the two callers deadlocked on it
(`40P01`) whenever a member fired Morning Brief while deleting its thread. The
binding is instead read without a conflicting lock, the destination it names is
locked, and the binding lock — still the creation serializer — is taken after it
and revalidated against the thread actually held.

Two bounded behaviours fall out of that order:

- A per-owner `pg_advisory_xact_lock` keyed by organization, user and workflow
  makes the window between the unlocked read and the binding lock private to one
  resolution. Without it a second resolution could bind a destination that this
  transaction could only lock after the binding row. Deletion never takes that
  key, so it gains no new wait.
- A destination deleted inside that window leaves the binding detached by its
  own `ON DELETE SET NULL`, and reuse creates and binds a fresh destination
  rather than resurrecting the deleted one. A binding that still names a thread
  this transaction does not hold is an invariant violation and fails the
  producer instead of locking out of order.

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
capped at 4 KiB UTF-8, the whole collection at 64 KiB of text, and a stored
event larger than 64 KiB becomes an explicit coverage gap rather than a decoded
excerpt. No snapshot or archive is read. Source text is data, never
instructions.

Collection writes nothing: no read watermark, message, Run, result or e-mail,
and no provenance repair.

### The admitted authority, and the fence that releases it

Admission goes through the shared connector-free
[`admitMorningBriefCollection`](../turbo/apps/api/src/signals/services/morning-brief-connector-reader.service.ts),
so unread Chat admits on the same authority the OAuth sources do, including the
default-off `simpleMorningBrief` switch. It freezes one scope for the whole
attempt:

| Frozen field       | What a change to it means                                                        |
| ------------------ | -------------------------------------------------------------------------------- |
| `orgId` / `userId` | The authenticated caller. Never accepted as input.                               |
| `membershipId`     | The immutable Clerk membership generation. A removal and rejoin issues a new id. |
| `installationId`   | The canonical Morning Brief installation this attempt speaks for.                |
| `automationId`     | The exact enabled daily-delivery automation inside that installation.            |
| `agentId`          | The Agent that installation runs on.                                             |
| `chatThreadId`     | The nullable destination identity, including the decision that none exists yet.  |

Before any envelope is released, `morningBriefScopeIsCurrent` re-derives all of
it live. It first observes the immutable membership generation through Clerk,
with no database transaction or lock held across that network wait. It then
opens one short local transaction: sorted shared erasure admission comes first,
followed by the existing canonical migration-state reader and Brief-Agent
visibility read. That final local decision compares the exact installation,
automation, Agent and nullable destination. A changed `null`/non-`null`
destination is a changed binding; absence is not a wildcard.

The transaction is the local linearization point. A subject closure committed
while Clerk was answering is visible to its erasure admission. A closure that
arrives after admission waits for the short local decision to finish. The
canonical reader and Agent check run while those subject locks remain held, and
no network call runs in the transaction. A different enabled automation or
installation, a rebound destination, a membership that left and rejoined, and a
Brief Agent that became private under another owner all withhold the payload.
The same function runs once before collection, so an admitted scope is one the
release check would accept; that costs one extra membership read per attempt and
is deliberate.

This does not promise a Clerk/PostgreSQL atomic transaction. Clerk can revoke a
membership after its answer, and local authority can change after the local
transaction commits. Work already executing inside PostgreSQL is not retracted,
and a collection that already returned a body is not recalled by a later
change. The guarantee is an external observation followed by a final local
fence, not retroactive recall.

The per-thread erasure admission, the source-Agent and thread-owner checks and
the thread row lock below are unchanged and still authoritative for the thread
a body comes from. The whole-owner fence is about the member and their brief.

### One attempt budget

A single absolute 15-second budget starts **before** admission and is shared by
admission's network membership read, candidate discovery, every thread read and
the final authority check. Nothing in the attempt starts a second clock. It is
the shared `MorningBriefSourceDeadline` every Morning Brief source spends, so
the admission preflight observes this attempt's own budget rather than opening
one of its own; the attempt adds the candidate reserve below on top of it.

- The last 3 seconds are reserved for the final authority check. Candidate work
  stops there, because content that cannot be re-authorized may not be released
  at all, and a loop that spent the whole budget would leave the fence nothing.
- The clock is re-read _after_ every blocking boundary and before content is
  accepted, including at equality: a thread read that returns exactly at the
  boundary is expired. Neither its excerpts nor its refusal reason is reported;
  the attempt records `deadline_exceeded` and partial coverage instead.
- Each transaction takes the smaller of its own cap and the remaining budget as
  its `lock_timeout` and `statement_timeout`, so a wait is cancelled by
  PostgreSQL rather than abandoned behind a promise race.
- An attempt that cannot finish admission, discovery or the final check inside
  the budget answers `503 REQUEST_DEADLINE_EXCEEDED` and releases nothing — not
  items, and not the thread ids that would describe them. A deadline is never
  reported as a healthy empty inbox: `result: "empty"` with complete coverage
  only ever describes an attempt that finished.
- Caller cancellation still propagates and fails the request; it is not
  converted into an envelope.

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
closed subject must not release that subject's Chat content either. Per-thread
reads retain their own short admission transactions. At whole-owner release,
the final local transaction reacquires admission **after** the last Clerk wait
and retains it through canonical binding and Brief-Agent validation. A closure
that already committed is denied; a later closure waits for that decision. A
whole-owner invalidation discards the entire payload rather than part of it.

### What the tests do and do not establish

Every authority and budget case runs through the registered preview route with a
real request, real PostgreSQL state and the real authorizer; only Clerk's own
HTTP answers are doubled. Automation replacement and nullable destination
rebinding are committed while a request is blocked at its real thread-read
boundary. The erasure case holds the final Clerk answer, commits a dormant B1
closure through the lifecycle projector, and only then releases the answer. B1
has no public closure ingress, so that uniquely owned closure is the necessary
fixture exception. Removing the automation/destination comparisons or the
post-Clerk local transaction makes the corresponding route regression release
stale content again. The limits worth stating:

- Suspension points are the ones a request really has — the Agent row lock, the
  thread row lock and the live membership lookup. There is no test that stalls
  candidate discovery itself; discovery's wait is bounded by its transaction's
  budget-derived timeouts rather than staged in a case of its own.
- The budget cases advance the process clock at a proven-blocked boundary
  instead of waiting 15 real seconds. That exercises every clock comparison the
  service makes, including equality, but not the wall-clock `AbortSignal`
  timeout that bounds a genuinely hung network read in production.
- `payloadBytes === null` — a stored event with no payload at all — is
  unreachable through the content filter, which already requires decodable text,
  so it stays a defensive branch rather than a covered case. The oversized
  branch beside it is covered with a real oversized event.
- The bounded-read failure case holds a row past the per-thread lock timeout, so
  it proves a real timeout rather than an injected one.

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
