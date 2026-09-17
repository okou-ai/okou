# Morning Brief platform-funded generation

The `simple-morning-brief` pipeline replaces the Morning Brief Official Workflow
Run with a server-side pipeline. [The collection contract](morning-brief-collection.md)
owns how source data is admitted, claimed and read. This document owns the next
piece: turning one collected bundle into one validated, persisted result, paid
for by Okou and accounted for separately from every user ledger.

## What this slice is

- One registered development / protected-preview API entrypoint that really
  runs **collect → reserve → one model request → validate → persist** inside the
  caller's request.
- The narrow collection-to-generation handoff that makes the reservation part of
  the same transaction that finalizes the collection.
- The owner-scoped generation slot and accepted result, and the anonymous
  platform spend receipt that sits beside it.

## What this slice is not

It starts no Run, sandbox or workflow automation, writes no Chat event, email or
outbox row, sends nothing anywhere and touches no schedule. It reads no user
model-provider account, checks no credit balance, reserves no allowance and
writes no `usage_event`. Nothing generates, collects, retries or recovers in the
background: a retry is another explicitly authorized invocation. The single
exception is deletion — a bounded retention batch on an existing maintenance
tick removes expired content, and it only ever deletes. **No result produced
here is delivered, and none is a production candidate.**

## The entrypoint

`POST /api/morning-brief/preview/generation` is registered in the ordinary API
route table, so an operator can really invoke it on a development server or a
protected preview deployment. `isPreviewEndpointAllowed` runs before
authentication, so production answers `404` without doing any auth work, and it
stays `404` even when `simpleMorningBrief` is enabled for the caller. On a
preview deployment the request additionally needs the deployment's
protection-bypass secret, which is environment protection and never owner
authentication.

Beyond that gate it is an ordinary authenticated route. The owner is the
authenticated organization and user, the native `slack:read` capability is
required because this really reads Slack, and the only input is a scheduled
anchor. No owner, workspace, account, model, prompt, source bundle or credential
can be supplied.

Admission is the collection contract's admission, unchanged, plus one check that
runs before it: a deployment without the platform `OPENROUTER_API_KEY` answers
`generation-not-configured` and claims no occurrence, so a missing platform
credential never costs a Slack read.

## Collection-to-generation handoff

`executeMorningBriefSlackCollection$` takes an optional handoff whose
`onCollected` runs **inside** the transaction that finalizes the collection,
after its guarded update matched. That placement is the contract:

- A completed occurrence stores metadata, never a checkpoint, so the only moment
  a generation can be admitted for a bundle is while the executor still holds it
  in memory.
- Collection facts and the right to call the provider become durable together.
  Throwing from the handoff rolls the finalization back and leaves the
  occurrence reclaimable.
- The collect-only entrypoint passes no handoff and keeps exactly its previous
  behavior.

A same-anchor occurrence that already completed **without** a generation is
reported as `collection-completed-without-generation`. It is not recollected,
replayed or invented, because nothing retained the bundle.

## One slot, one invocation

`morning_brief_generations` is keyed by exactly one collection occurrence:
`(org_id, user_id, scheduled_for, collection_kind, collection_version)`. Purpose,
prompt version, result-schema version and model are **provenance columns, not key
columns**, so changing any of them cannot open a second invocation or a second
result for the same logical occurrence.

`execution_purpose` is read as a filter. A consumer only sees results produced
for the purpose it asked for, so a future production delivery can never pick up
a `preview` result that happens to share an owner and an anchor.

### States

| State                        | Meaning                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `reserved`                   | Committed **before** the request. Deliberately ambiguous; never a reason to send again.        |
| `succeeded`                  | A validated deliver or model skip was accepted.                                                |
| `output_rejected`            | The provider answered and was billed; the output failed validation.                            |
| `provider_failed`            | The provider returned an error, or its response exceeded the response budget.                  |
| `not_invoked`                | A deterministic check, or a lapsed authority, stopped the request before any provider contact. |
| `result_discarded`           | A result was observed, but this attempt no longer held the reservation or the authority.       |
| `invocation_outcome_unknown` | The request may have reached the provider and no outcome could be recorded.                    |
| `skipped_empty`              | Every applicable read succeeded with zero candidates. **Zero model calls.**                    |
| `skipped_incomplete`         | A bounded or partial read produced zero candidates. Zero model calls, and not an empty day.    |

`not_invoked` is failure-before-contact and is deliberately distinct from
`invocation_outcome_unknown`. Neither is a skip.

### The no-repeat-POST contract

The reservation is durable before the request, so a timeout, a lost response, a
dead process or a failed result commit all leave `reserved`. A later explicit
invocation that finds an expired reservation settles it as
`invocation_outcome_unknown` and makes **no** request; one that finds a live
reservation answers `409 MORNING_BRIEF_GENERATION_IN_PROGRESS`.

Even a crash after the reservation commits but before the request is actually
sent leaves that ambiguity. This is acknowledged rather than resolved: what is
guaranteed is **one application invocation admission and one logical accepted
result**, not exactly-once provider inference. The current request may boundedly
retry persistence of the **same already observed** receipt and result; once that
in-memory result is gone it is not replayable, and the input digest does not
reproduce it.

### Live authority at both boundaries

Owning the slot is not the same as being allowed to act for the owner. The
occurrence row is the durable record of the authority a collection was admitted
under, so the canonical resolution — implementation switch, canonical
installed-and-enabled brief, member timezone, installation Agent, fresh
exact-member Clerk membership and native Slack binding — is re-run and compared
against that row field by field:

- **Before any provider contact.** A brief disabled, an Agent deleted or
  transferred, a membership removed and rejoined, or a Slack account rebound
  between the reservation commit and the request produces `not_invoked` and
  sends nothing.
- **Before any of the answer becomes owner content.** The same check runs again
  after the response. A lapsed authority yields `result_discarded`; the incurred
  charge is still recorded, and no owner row is recreated to hold a result.
- **Before an existing result is released.** Reading a stored result hands back
  source-derived content, so it needs the same live authority. A different
  current binding is a different authority and is refused rather than served the
  previous binding's work. Settling a lapsed reservation is exempt: it records
  an operational fact and releases nothing.
- **At the moment of release, after every wait.** The read-back's last step is a
  local fence under the owner lock: the slot is read again, its attempt must
  still be the one that was validated, its retention deadline must still be in
  the future, and the local binding must still match. It runs after the receipt
  lookup, so a deletion, a disable, a rebinding or the deadline landing during
  that final read cannot hand back the copy the request started with. It writes
  nothing and never recreates an owner row.

There is no second adoption algorithm and no always-allow path: this is the
collection contract's own reader with the Slack credential withheld. It
serializes local acceptance only — a request already in flight to the provider
cannot be recalled, and this never claims otherwise.

### The commit-admission fence

Each of those checks describes an instant that has already passed by the time
anything is written: the canonical resolution waits on Clerk, and the writes
that follow it wait for the owner lock and the slot row. A Settings disable, an
Agent transfer, a Slack rebinding or the caller going away can all land inside
exactly that wait, which is why the decision is re-taken where the mutation is
really admitted — after every wait, before any statement is issued, and on every
persistence attempt:

- **Cancellation.** A caller that has gone away commits nothing to the owner
  slot. The whole transaction unwinds, so the slot keeps its original attempt,
  reservation and retention, and a later explicit invocation settles it exactly
  as any other unrecorded outcome. The anonymous receipt is already durable by
  then and is kept.
- **The local half of the authority.** The installation resolution — switch,
  canonical installed-and-enabled brief, timezone, installation Agent, native
  Slack binding — is re-resolved from the same readers admission uses, under the
  locks those mutators really take, and compared against the occurrence with the
  shared binding comparator. A lapse turns an acceptance into `result_discarded`.
- **The remote half is not re-resolved.** A transaction is never held open
  across a Clerk round trip. The membership generation proved before persistence
  is carried in the fence the write is guarded by; a membership that changes
  afterwards is caught by the next invocation's own resolution.

### The admission clock

The clock is sampled at that same point — after the owner lock and the slot row
are really held, and on every persistence attempt — so the deadline comparison
describes the instant the mutation is actually admitted rather than the instant
the response arrived. A response observed before expiry that waits behind a lock
until after it is refused, not accepted. Equality with the deadline is expired at
every boundary.

### Finite phase ownership

| Budget                    | Value                                               |
| ------------------------- | --------------------------------------------------- |
| Reservation               | 60 s, never beyond the occurrence's own lifetime    |
| Provider request          | 45 s, minus 10 s reserved for recording the outcome |
| Serialized request        | 128 KiB, measured on the exact bytes sent           |
| Model output tokens       | 8,192, including this model's mandatory reasoning   |
| Streamed success response | 256 KiB                                             |
| Error response            | 64 KiB                                              |
| Accepted rendered result  | 32 KiB                                              |
| Preview result retention  | 24 h, then unreadable; purged on a maintenance tick |
| Retention purge batch     | 200 rows per statement, 10 statements, 5 s per tick |

The collection lease is **not** reused as generation ownership.

The provider allowance is **what remains of the reservation, minus the
persistence reserve, measured now** — not a figure computed earlier in the
request. The pre-contact authority preflight is a real membership and
authorization resolution that can block, so it receives a finite slice of that
remaining time and the allowance is recomputed immediately before contact. A
preflight that consumed the reservation therefore cannot still admit the one
request the reservation permits.

Equality with the deadline is exhausted at every one of those points, and
exhaustion before contact records a **known** `not_invoked` with zero provider
requests. It is never reported as an unknown invocation, because nothing was
sent.

## The request

One non-streaming POST to OpenRouter chat completions with the platform
credential, the explicitly pinned model `google/gemini-3.8-flash`,
`reasoning.effort = low`, `temperature = 0`, no tools and no second request. The
model identifier is pinned in the Morning Brief module rather than inherited
from `FAST_PATH_MODEL`, which is the shared auxiliary default and may be
retargeted for unrelated reasons.

Collected text is **data**. It travels inside a JSON document under a field the
instructions describe as untrusted, and it cannot change the instructions,
request a tool, add a source or supply a link. Links never travel: the model
cites opaque message ids, and program code resolves them from the collected
source map afterwards.

### Deterministic input reduction

Candidates are ordered newest-first by exact Slack timestamp, then by channel.
The request is built and **measured**, and whole messages are dropped — oldest
first, never truncated — until the real serialized body fits. The number that
did not fit is sent to the model with the collector's own coverage, so a reduced
input is never summarized as a complete day. `input_items`, `included_items` and
`input_reduced` record the same facts durably.

### Language

The member's persisted `org_members_metadata.locale` is the only user-owned
language input that exists today; it is a bounded enumeration written through
Settings. When it is absent the policy is `en-US` with source `default`. The
resolved policy is frozen into the request and onto the row.

**Known gap.** The legacy Official Workflow path could additionally be steered by
free-form Agent instructions. That is not modeled here and is not claimed as
preserved. Closing it is a migration-acceptance gate before activation; this
slice adds no Settings field.

## The result contract

A strict, bounded union, validated once and terminally:

```json
{ "decision": "deliver", "title": "...", "sections": [{ "heading": "...", "items": [{ "text": "...", "sourceIds": ["m1"] }] }] }
{ "decision": "skip", "reason": "nothing_actionable" }
```

Limits: title ≤ 120 characters; 1–6 sections; heading ≤ 60 characters; 1–8 items
per section; item text ≤ 400 characters; 1–4 source ids per item.

Program code renders the accepted structure into safe Markdown: Markdown
structure and control characters in model prose are escaped, and every link is
resolved from the collected source map. A Slack citation resolves to its
channel, because the bundle carries channel URLs rather than per-message
permalinks.

Every object rejects unknown keys rather than stripping them: an answer carrying
fields this pipeline never asked for is not the requested shape.

Failures are failures, never skips, and are never repaired by a second request:
a truncated finish reason, a tool call, malformed JSON, a shape violation, a
citation this request never supplied, an empty deliver and an oversized result
each produce a named `failure_reason` and no accepted result. **Tool calls are
detected from the message itself**, not from `finish_reason`: this pipeline
sends no tools, so a populated tool-call field is unexpected output even when
the provider labelled the completion `stop`.

Provider token counts are accepted only as non-negative integers. A fractional
or out-of-range count is _unavailable_, never rounded into an exact-looking
number the provider did not report.

**A model-written link is invalid output.** The instructions say never to write
one, so a link-shaped string is rejected rather than sanitized into a published
brief. This is a deliberate strictness for a preview slice; whether production
should instead strip such a string is recorded for the delivery gate.

## Platform-only usage and cost

`morning_brief_platform_generation_receipts` records one receipt per invocation,
keyed by an opaque `attempt_id` the owner-scoped row also carries. It holds the
operation, provider, requested and returned model, the provider generation id,
finite start and finish instants, the outcome, native token counts and the cost.

It carries **no** organization, user, Agent, thread, occurrence or source
identity, and no prompt, source body or generated text. There is deliberately no
foreign key in either direction: a receipt must be writable for an invocation
whose owner was erased mid-flight, and it must survive owner deletion. Once the
owner row is gone the linkage is gone with it and an unattributable cost fact
remains — that residual row is the documented retention boundary, and retention
never erases an already incurred charge.

Nothing here writes `usage_event`, a credit debit, an allowance or a balance
row, calls organization billing or credit-balance admission, consumes Run
admission or concurrency, resolves a user model provider, or calls
`recordOpenRouterUsage$`. That last one is explicit: even its runless path
writes a billable `usage_event` and processes organization credits, so it is not
platform-funded accounting. A zero-credit organization completes this whole path.

### Provider contract

Verified against the [official OpenRouter usage-accounting documentation](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
fetched 2026-09-17:

- Every non-streaming response carries `usage` with native `prompt_tokens`,
  `completion_tokens` and `total_tokens`, optional
  `completion_tokens_details.reasoning_tokens` and
  `prompt_tokens_details.cached_tokens`, and `cost` — documented as "the total
  amount charged to your account", in OpenRouter credits.
- `usage: { include: true }` and `stream_options: { include_usage: true }` are
  deprecated no-ops, so nothing is sent to request usage.
- `cost_details.upstream_inference_cost` is the upstream provider's charge and is
  documented as BYOK-only — zero or null for platform-managed requests — so it is
  never read as the platform's spend.

The receipt therefore stores `cost_source = chat_completion_usage_cost` and
`cost_unit = openrouter_credits`. OpenRouter credits are **not** Okou user
credits and are not converted into a currency.

### Cost reconciliation

When a completion response carries a generation id but no usable amount, one
bounded read-only `GET /api/v1/generation?id=…` is attempted, once, with a
5-second deadline. Verified against the [official generation-metadata
reference](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
(fetched 2026-09-17): the `id` query parameter is required and the response is
`{ data: { id, is_byok, total_cost, upstream_inference_cost, native_tokens_*,
… } }`. Only `data.total_cost` is read, recorded with
`cost_source = generation_total_cost`.

Two guards keep an uncertain answer uncertain: a record whose `id` is not the
one asked for is discarded rather than attributed, and `is_byok: true` is
refused because a BYOK generation's charge is not this platform's spend. A 404,
a delayed answer past the deadline, a transport failure and a malformed amount
all leave the cost exactly as unknown as it already was. This path sends no
completion and can never be a reason to send the original request again.

A reconciled amount is held to the same durable domain as an inline one: a
delayed answer is not a reason to accept a value the receipt cannot store
exactly.

**Remaining evidence gap**, re-checked 2026-09-17. The generation reference
renders its per-field descriptions behind a collapsed control, so that page
still does not itself state `total_cost`'s unit; its rendered example shows
`"total_cost": 0.0015` beside `"usage": 0.0015` and a distinct
`"upstream_inference_cost": 0.0012`. The unit is recorded as OpenRouter credits
on the strength of the usage-accounting page, which the same re-check confirms
lists "Cost in credits", documents `cost` as "The total amount charged to your
account", and states that `upstream_inference_cost` "is only available for BYOK
… requests. For all other requests it will be 0 or null". That is one accounting
system described across two pages, not a field-level statement on the reference
itself. No currency conversion is performed or implied, and the gap is recorded
rather than closed by inference.

### Cost states

| State                | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `reported`           | A finite, non-negative amount the column holds exactly. `0` is a **known** zero. |
| `unavailable`        | A response was read but carried no usable cost. The generation id is kept.       |
| `invocation_unknown` | No usage payload was read at all, so whether anything was charged is unknown.    |

A string, a negative number, `NaN`, a missing field and a missing `usage` object
are all `unavailable`. Token counts never imply a known cost and are never
converted into one.

### The durable domain

Validation and storage share one domain, because a value the column cannot hold
is not recorded more widely — it is recorded wrongly, or not at all.

- **Token counts** are `integer`. A count above `2147483647` is `unavailable`
  for that field alone. It previously passed validation and then failed the
  whole INSERT with `integer out of range`, discarding the observed cost, the
  sibling counts and the invocation record with it.
- **The amount** is `numeric(24, 12)`: at most twelve integral digits and
  exactly twelve fractional digits. An amount needing finer digits — `1e-13` —
  or more integral digits — `1e12` — is `unavailable`, never rounded. Rounding
  into the scale would publish a durable **reported zero** for a real nonzero
  charge, and an over-range amount would fail the INSERT with
  `numeric field overflow`.
- An accepted amount is normalised to the exact decimal the column returns, so
  the initial response, the stored row and every later reread carry one
  identical value rather than two spellings of it.

`MORNING_BRIEF_PLATFORM_RECEIPT_MAX_TOKENS`,
`MORNING_BRIEF_PLATFORM_RECEIPT_COST_PRECISION` and
`MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE` in the schema are the single source
of both the column definition and the parser bound, so the two cannot drift.
An unavailable amount keeps `provider_generation_id`, so a charge whose amount
this system cannot represent is still traceable out of band.

## Ordering, fences and revocation

Persistence is two independent writes, in this order and with bounded retries of
the _same_ observed values:

1. **The receipt**, keyed by the opaque attempt id with a conflict-free insert.
   It takes no erasure admission and no owner lock, so it still records a real
   charge when the owner is already gone, and a retry — including one that races
   an earlier attempt that actually committed — leaves exactly one cost record
   and never replaces a committed observation with a weaker one.
2. **The owner-scoped outcome**, under the same fence the reservation was
   admitted with: the exact occurrence, attempt id, membership generation and
   `reserved` state. Accepting content additionally requires an unexpired
   reservation, so late content is recorded as `result_discarded` rather than
   stored. A revoked owner matches nothing, and nothing recreates an owner row
   to hold a result.

The receipt's own bounded attempts finish **before** the caller's cancellation
check and before the live-authority resolution that decides the owner write.
Both of those can end the request — cancellation propagates, and resolving the
authority can itself fail — and the charge was incurred at the provider either
way. Those attempts are joined to this request and finite: nothing is detached
to complete later, no queue is created, and nothing about them accepts or
releases owner content. A cancelled request still cancels; it simply no longer
discards an observation it already made.

If the owner write then fails, the committed receipt is unaffected; if the
receipt is still outstanding, the owner write does not wait on it.

When the receipt's attempts are exhausted, the response says so: the receipt is
reported with `recorded: "unresolved"` and its exact observed amount. That is an
outstanding accounting record, not a durable one and never a cost of zero, and
it is not a guarantee of durability during a permanent database failure. When
every owner attempt fails, the slot stays `reserved`, the response reports that
honestly with `persistence_failed`, and a later invocation resolves it to
`invocation_outcome_unknown`. No second request is ever made in either case.

A cancelled caller reaches the same place by a different route. The retry
reserve exists for real faults, so cancellation stops it immediately rather than
spending it, and the slot is left exactly as its reservation left it. What is
promised is that cancellation before the commit admission leaves **no accepted
result**; what is not promised is retracting bytes already committed or a
request already in flight to the provider.

## Stored values are validated, not defaulted

`execution_purpose`, `state`, `language_source`, `source_coverage`,
`failure_reason`, the receipt outcome, the cost state and the cost source are
each constrained by a database `CHECK`, and a delivered result must carry its
title, its Markdown and its real UTF-8 byte size together. A TypeScript union is
a claim about writers this process controls; the constraint is what the stored
text is actually held to.

Readers match that. An unrecognized coverage or an incomplete stored result
fails loudly instead of being normalized — reporting a bounded read as a healthy
empty day, or a UTF-16 string length as a byte count, would answer a different
question than the one that was accepted.

## Ownership lifetime, retention and cleanup

The generation row's durable parent is the collection occurrence, which is
itself keyed to the member's `org_members_metadata` row and to the
installation's Agent. Membership, user and organization cleanup, Agent deletion
and the collection's own explicit revocation therefore cascade to generation
rows as well, with no detached result and no separate cleanup path to forget.

Preview results are derived from source content, so they get a real bounded
lifetime instead of a claim that they are ephemeral: **24 hours**. Two distinct
things enforce it, and conflating them would overstate the guarantee.

**Accessibility ends at the deadline.** The release fence refuses a result whose
`expires_at` has passed, equality included, so an expired result is unreadable
from the instant it expires — whether or not its row is still there.

**Physical removal is bounded by a maintenance interval.** An owner-scoped sweep
still runs on every preview invocation, which keeps an owner who comes back from
ever holding stale rows, but it bounds nothing on its own: an owner who invokes
once and never again would keep title and Markdown forever. The real bound is
`executeMorningBriefGenerationRetentionWork$`, a batch on the existing
`/api/cron/execute-workflow-automations` tick — the same maintenance entrypoint
the Morning Brief enrollment worker already runs on. It settles independently of
the automations beside it, and it is deliberately finite: up to 200 rows per
statement, 10 statements and 5 seconds per tick, selected in deadline order with
`SKIP LOCKED` so it never queues behind a live attempt or takes a table-wide
lock. That tick runs every minute, so purge latency after a deadline is
**minutes under normal load, and longer only while a backlog drains** — never a
reason a result stays readable.

No scheduler, queue or recovery poller is introduced, and no other owner's rows
are touched. Expired results are deleted; the anonymous platform receipt is not,
because retention does not erase an incurred cost. What survives a purge instead
is the completed collection occurrence: it holds no content, and it is what
actually refuses a second invocation, so a purged slot reads as a completed
collection that holds no generation rather than as an occurrence free to call the
provider again.

## Rollout

Additive migration `1152_morning_brief_platform_generation` creates two new
tables and changes nothing existing, so it deploys before the code and rolls
back with it: an older API simply never reads or writes them. No backfill
exists or is needed. The feature stays default-off and the route stays
unavailable in production.

Migration `1155_morning_brief_generation_expiry_index` adds one index,
`idx_morning_brief_generations_expiry` on `expires_at`, which the maintenance
batch's ordered scan over already expired rows uses instead of a sequential
scan; the existing owner-prefixed index cannot serve a scan that is not scoped to
one owner. It is additive in both mixed-version directions: an older API never
consults it and is unaffected if it ships first, and a newer API that reaches the
database before it exists still runs the same bounded, `LIMIT`-ed statement —
only its plan degrades. There is no backfill, no rewrite and no broad table lock:
the table is new and empty in production, so the index build is immediate under
the migration runner's `1s` lock timeout.

## Scale

Native occurrence, generation and receipt tables are not exposed by MaskDB, so
no production row census is claimed for them — an unexposed table is an unknown
count, not a zero one. The Morning Brief installation census in the parent epic
describes installations, not generations, and cannot size these tables. The
feature being default-off is likewise not evidence that the receipt table is
empty. A change that needs a row count must refresh that exposure evidence
first; the current repairs deliberately need none, because they align validation
with the existing column domains instead of rewriting them, so `1152` stands
unchanged and no migration, backfill or table lock is involved.

## The callable interface later slices consume

These are the entry points this slice publishes. A later slice composes them;
it does not build a second generation engine and never adds a provider request.

**Orchestration.** `executeMorningBriefPreviewGeneration$` (`command`, in
`morning-brief-generation-executor.service.ts`) takes `{ owner: { orgId, userId
}, scheduledFor: Date }` plus an `AbortSignal`, and returns the discriminated
union `MorningBriefGenerationExecution`: `not-executed`, `invalid-anchor`,
`conflict`, `collection-failed`, `generated`, `already-generated` or
`collection-completed-without-generation`. It owns the whole reservation,
request and persistence contract described above.

**Source handoff.** `executeMorningBriefSlackCollection$` accepts an optional
`handoff.onCollected(tx, context)` that runs inside the finalize transaction.
A multi-source composition reuses that hook at its own single finalize point;
the reservation must stay inside the transaction that makes the collected facts
durable.

**Request shaping.** `planGenerationRequest({ bundle, language })` returns the
exact bytes, the input digest, the included/total counts and the source map, and
`resolveGenerationLanguage(locale)` returns the frozen language policy. A slice
that adds sources or an Agent language context changes what it passes in here;
it does not add a second request.

**Durable state.** `morning-brief-generation-store.service.ts` exposes
`reserveMorningBriefGeneration`, `recordMorningBriefGenerationSkip`,
`readMorningBriefGeneration(db, key, purpose)`,
`holdMorningBriefGenerationSlot(tx, fence)`,
`acceptMorningBriefGenerationResult(tx, fence, held, result)`,
`recordMorningBriefGenerationOutcome(tx, fence, held, outcome)`,
`resolveStaleMorningBriefGeneration`, `recordPlatformGenerationReceipt`,
`readPlatformGenerationReceipt`, `sweepExpiredMorningBriefGenerations` and
`purgeExpiredMorningBriefGenerations(db, at, limit)`.

The two guarded writers no longer take the slot themselves: a caller takes it
with `holdMorningBriefGenerationSlot` and passes the returned hold — whose `at`
is the admission clock, still sampled after every real wait — to the write. That is the point where a caller must
honour cancellation and re-prove the owner's live local authority, and only the
caller can do either, so the hold is a value rather than an implicit step.
Callers still pass no instant of their own.

**Live authority.** `currentMorningBriefCollectionAuthority$` resolves the
canonical Morning Brief authority without the Slack credential, and
`morningBriefCollectionBindingMatches(row, admission)` compares it against an
occurrence. Any slice acting for an owner after a wait uses these rather than a
second adoption algorithm.

`morningBriefLocalAuthorityStillCurrent(db, occurrence)` is the transaction-safe
half of the same resolution: it takes any `Pick<ReadonlyDb, "select">` — a `Tx`
included — re-reads the switch, canonical installation and schedule, timezone,
installation Agent and native Slack binding, and compares them against the
occurrence with that same comparator, returning `current`, `not-executed` with a
skip reason, or `binding-changed`. It makes no network call and carries the
membership generation over from the occurrence, so it is the one to use inside a
transaction; `currentMorningBriefCollectionAuthority$` remains the one to use
outside it. `loadSlackUserBinding(db, { orgId, userId })` in
`slack-data.service.ts` is the credential-free read both share, so a caller that
only needs to know which Slack identity is bound never decrypts a bot token.

**Delivery read.** Delivery reads one accepted result by owner, occurrence slot
and purpose. The stable parts of that reference are the slot key
`(org_id, user_id, scheduled_for, collection_kind, collection_version)`, the
`execution_purpose` filter, the `succeeded` state with its `deliver`/`skip`
decision, the stored `result_bytes`, and the bounded preview `expires_at`
lifetime. A `preview` result is not a production candidate and is refused by a
consumer asking for another purpose.

Native scheduling supplies a real `execution_purpose` beside `preview`; adding
one is a schema and migration change in that slice, and the purpose filter is
already the mechanism that keeps the two apart. Any change to this interface is
recorded here and on the issue.

## Gates that remain

Chat and email delivery, production source-set composition, scheduling and
cutover, settings and native-authority migration, release and feature
activation, and any real production provider call are all out of scope here and
retain their own gates. The remaining language-compatibility gap above must be
closed before activation.
