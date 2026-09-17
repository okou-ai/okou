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
writes no `usage_event`. There is no cron, recovery poller or background
enqueue: a retry is another explicitly authorized invocation. **No result
produced here is delivered, and none is a production candidate.**

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

| State                        | Meaning                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `reserved`                   | Committed **before** the request. Deliberately ambiguous; never a reason to send again.     |
| `succeeded`                  | A validated deliver or model skip was accepted.                                             |
| `output_rejected`            | The provider answered and was billed; the output failed validation.                         |
| `provider_failed`            | The provider returned an error, or its response exceeded the response budget.               |
| `not_invoked`                | A deterministic check stopped the request before any provider contact.                      |
| `result_discarded`           | A result was observed, but this attempt no longer held the reservation.                     |
| `invocation_outcome_unknown` | The request may have reached the provider and no outcome could be recorded.                 |
| `skipped_empty`              | Every applicable read succeeded with zero candidates. **Zero model calls.**                 |
| `skipped_incomplete`         | A bounded or partial read produced zero candidates. Zero model calls, and not an empty day. |

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
| Preview result retention  | 24 h                                                |

The collection lease is **not** reused as generation ownership. Equality with
the reservation deadline is already expired, and that is checked before any
provider contact.

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

Failures are failures, never skips, and are never repaired by a second request:
a truncated finish reason, a tool call, malformed JSON, a shape violation, a
citation this request never supplied, an empty deliver and an oversized result
each produce a named `failure_reason` and no accepted result.

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

### Cost states

| State                | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `reported`           | A finite, non-negative `usage.cost`. An explicit `0` is a **known** zero.     |
| `unavailable`        | A response was read but carried no usable cost. The generation id is kept.    |
| `invocation_unknown` | No usage payload was read at all, so whether anything was charged is unknown. |

A string, a negative number, `NaN`, a missing field and a missing `usage` object
are all `unavailable`. Token counts never imply a known cost and are never
converted into one.

**Deliberate omission.** A delayed receipt lookup through the read-only
`/generation` endpoint is _not_ implemented. The usage-accounting page confirms
that endpoint exists and that its `upstream_inference_cost` is BYOK-only, but it
does not state which field carries the platform's own total there, and the
linked API reference did not expose that schema when it was fetched. Inventing a
field name would produce a confidently wrong amount, which is worse than an
explicit unknown. What is implemented instead is the state machine that lookup
would feed: the generation id is retained on the receipt, an unavailable cost
stays unavailable rather than becoming zero, and nothing about a delayed or
failed reconciliation can ever trigger another POST. Implementing the lookup
against a verified schema is a follow-up.

## Ordering, fences and revocation

Persistence is two writes, in this order and with bounded retries of the _same_
observed values:

1. **The receipt**, keyed by the opaque attempt id with a conflict-free insert.
   It takes no erasure admission and no owner lock, so it still records a real
   charge when the owner is already gone, and a retry writes exactly one cost
   record.
2. **The owner-scoped outcome**, under the same fence the reservation was
   admitted with: the exact occurrence, attempt id, membership generation and
   `reserved` state. Accepting content additionally requires an unexpired
   reservation, so late content is recorded as `result_discarded` rather than
   stored. A revoked owner matches nothing, and nothing recreates an owner row
   to hold a result.

When every persistence attempt fails, the slot stays `reserved`, the response
reports that honestly with `persistence_failed`, and a later invocation resolves
it to `invocation_outcome_unknown`. No second request is ever made.

## Ownership lifetime, retention and cleanup

The generation row's durable parent is the collection occurrence, which is
itself keyed to the member's `org_members_metadata` row and to the
installation's Agent. Membership, user and organization cleanup, Agent deletion
and the collection's own explicit revocation therefore cascade to generation
rows as well, with no detached result and no separate cleanup path to forget.

Preview results are derived from source content, so they get a real bounded
lifetime instead of a claim that they are ephemeral: 24 hours, enforced by an
owner-scoped sweep the preview entrypoint itself consumes on every invocation.
No scheduler or queue is introduced, and no other owner's rows are touched.
Expired results are deleted; the anonymous platform receipt is not, because
retention does not erase an incurred cost.

## Rollout

Additive migration `1152_morning_brief_platform_generation` creates two new
tables and changes nothing existing, so it deploys before the code and rolls
back with it: an older API simply never reads or writes them. No backfill
exists or is needed. The feature stays default-off and the route stays
unavailable in production.

## Scale

Native occurrence, generation and receipt tables are not exposed by MaskDB, so
no production row census is claimed for them. The Morning Brief installation
census in the parent epic describes installations, not generations; the new
tables start empty.

## Gates that remain

Chat and email delivery, production source-set composition, scheduling and
cutover, settings and native-authority migration, release and feature
activation, and any real production provider call are all out of scope here and
retain their own gates. The remaining language-compatibility gap above must be
closed before activation.
