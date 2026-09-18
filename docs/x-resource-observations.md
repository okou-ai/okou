# X resource observations

This is the X resource ingestion contract for
[#34713](https://github.com/vm0-ai/okou/issues/34713), using the schema prepared in
[#34712](https://github.com/vm0-ai/okou/issues/34712), under backend
[#34610](https://github.com/vm0-ai/okou/issues/34610) and overall delivery
[#34532](https://github.com/vm0-ai/okou/issues/34532).

There is one X upstream billing account. Resource deduplication is site-wide
across organizations, users, runs and processes. Retain only the current UTC
date and the previous UTC date. Adding or replacing the billing account needs
a new design decision before that account uses this path; credential refresh
within the same account does not reset resource identity.

## Protocol and activation

The existing usage webhook validates the strict `x-resource-v1` schema and
authenticates the sandbox run. `X_RESOURCE_BILLING_START_DATE` is an optional
server setting containing the fleet-wide UTC activation date (`YYYY-MM-DD`).
Leave it unset until #34615 verifies the single account, compatible producers,
serving and rollback APIs with settlement admission, and the legacy upload drain.
Unset, every resource or
mixed batch receives `400 X resource observations are not enabled` before any
financial write. No per-user or per-organization override is supported.

When configured, observations must be on or after the activation date and
inside the two-date admission window below. The complete batch commits
atomically and returns the existing `{ success: true }` acknowledgement.
Mixed batches retain legacy quantities and the existing BYOK model filter;
legacy-only batches retain their quantities and source behavior, sharing the
same bounded write admission after activation. Runner claims advertise the
optional `xResourceBilling: { protocol: "x-resource-v1", startDate }` capability
when the setting is configured, including a future activation date. A rejected
resource batch must never be downgraded to legacy count billing.

Each event carries:

- `protocol: "x-resource-v1"`, a stable source UUID `idempotencyKey`,
  `kind: "connector"`, `provider: "x"`, and category `posts.read` or `user.read`.
- Original nonnegative safe-integer `quantity` Q and millisecond UTC
  `observedAt` (ISO timestamp ending in Z).
- Distinct `resources: [{ id, occurrences }]`, with exact ASCII decimal IDs
  of 1–32 characters and positive safe-integer occurrence counts.
- Distinct transient `remainder: [{ reason, quantity }]` entries. Reasons are
  `missing_id`, `unsupported_resource`, `identity_limit`, or `parse_fallback`.

The body requires a UUID run ID for v1, at most 100 events and at most 1,000
resource IDs over the whole batch. The webhook counts actual streamed bytes
and rejects bodies over 256 KiB with 413 even without an accurate Content-Length.
Source UUIDs in a resource/mixed batch must be distinct, including UUID spelling
that differs only in case. Resource type is derived from the category: post or user.
There is no caller-supplied billing scope, binding or net quantity. `posts.read`
is the existing X billing category; `tweet.read` is an OAuth permission and is
not accepted as a resource billing category. This corrects the dormant contract
before the first resource producer is activated; no category alias or price
change is introduced.

Let K be the sum of identified occurrences. Require Q = K + R, computing
transient unidentified remainder R before collapsing repeated IDs. Bill N + R,
where N is the number of newly inserted distinct resources. For Q=5 and
occurrences A,A,B, R=2; if B was already read, N=1 and net quantity is 3.
Only final net quantity reaches the existing ledger and rollups.

## One short-lived table

`x_resource_reads` has three non-null columns:

| Column          | Meaning                              |
| --------------- | ------------------------------------ |
| `utc_day`       | UTC date of the resource observation |
| `resource_type` | `post` or `user`                     |
| `resource_id`   | Exact decimal resource ID            |

The three columns form the primary key. Its leading date supports cleanup;
no separate day index is needed. There are no account, ownership or winner
columns and no foreign keys. Personal-data erasure and ledger compaction cannot
cascade into shared reads. The migration creates one empty table and changes
no existing table or count writer.

The table is used by the transactional consumer and the independent authenticated
`GET /api/cron/cleanup-x-resource-reads` job, scheduled once per minute. No
additional schema or index is required by the consumer.

## Consumer transaction and retries

Reuse `usage_event.idempotencyKey` for source idempotency, including a ledger
row when net quantity is zero. The producer preserves one immutable source
UUID, observation time and payload across retries. Keep the existing success
acknowledgement; there is no separate receipt table, payload digest or replay
result API.

Authenticate the run and its org/user ownership, and acquire existing erasure
admission before source lookup or writes. Lock the live owned run against
deletion and ownership changes. On a source UUID conflict, verify the same
run/org/user and billing category, then acknowledge the owned source without
new claims or obligations. Foreign or conflicting source identities return
409 and roll back the entire batch.
Do not return foreign source records or winning attribution. Reusing a UUID
with changed content is not checked against a stored digest.

Lock order is sorted account-erasure subjects, shared X admission, the live run,
the entire normalized/sorted source UUID set, then the entire sorted
date/type/ID set. Reserve source rows at quantity zero before inserting any
resource; uncommitted placeholders are invisible to settlement. Insert resources
with `ON CONFLICT DO NOTHING RETURNING`, derive N from the inserted identities,
and update the new sources to their final N+R quantities in that transaction.
Repeated resources within a batch go to the first source in UUID order. Any
failure rolls back both sources and claims. The first successfully committed
observation owns the obligation, including allowance/pack-funded reads.
Credit settlement keeps its billing behavior and takes shared compaction
admission before its organization credit lock. Different organizations can
still settle concurrently; exclusive maintenance waits for admitted settlements.
Agent deletion and threadless Run cleanup also share compaction admission before
locking parents or Runs. Their Run-delete foreign keys update ledger rows, so
they must not overlap maintenance that retains ledger locks before Run locks.
Agent deletion keeps its 100-millisecond lock timeout and retryable 409 response,
including when maintenance for another organization delays admission.

The consumer takes no compaction or organization credit lock. Compaction only
handles processed rows older than four days, so an immutable source within the
two-date admission window cannot be compacted. It never waits for the X
admission lock. Cleanup takes only the exclusive X admission lock and resource
rows; it does not acquire run, erasure or ledger locks.

## Two-date admission and cleanup

Both new reports and retries must have an observed UTC date of today or
yesterday. Allow at most five minutes after the database clock, before run
creation, or after run completion as additional bounds. Reject older dates before source lookup or resource
mutation; a producer must never move an expired observation to a fresh date.
Use JSON completion or complete NDJSON-row time and split streams at UTC
midnight, rather than using upload or settlement time.

Ingestion takes a transaction-scoped shared admission lock; cleanup takes the
same lock exclusively. Sample the database clock after admission and again
after source/resource insertion waits, before finalizing billing.
This prevents cleanup from deleting a day while an admitted transaction can
still charge against it. Each transaction has a 15-second total timeout,
5-second statement timeout and 2-second lock timeout. Cleanup samples the clock
after its exclusive lock is acquired and deletes at most 1,000 rows per call
where `utc_day < current_utc_date - 1`. A delayed cleanup retains extra rows
but never extends admission. No permanent closed-day watermark is needed.

The existing ledger retains healthy processed rows for at least four days,
which exceeds the two-date retry horizon. There is no source replay guarantee
after expiry or compaction; expired requests fail instead of recreating
consumption. Run/thread/account deletion has no cascade into shared resources.
Missing runs and closed account-erasure subjects return 404 before source
lookup, so old tokens cannot recreate erased billing records. Ordinary thread
deletion retains run/billing history under the existing lifecycle; cancelling
that run does not reset the shared resource set.

With the activation setting configured, Clerk user/organization cleanup first
takes the scoped account-erasure subject lock exclusively. This drains Run
creation and queue promotion before retaining allowance locks; those compute
transactions lock Agent rows before accessing allowances. It only borrows the
existing admission lock and does not create an erasure job or close the account.
Cleanup then takes exclusive X admission and exclusive compaction admission
before deleting the scoped ledger and organization allowance entitlements.
It then deletes the live runs in the same transaction. The existing usage helper
uses a savepoint on that connection, so no second pooled connection is needed.
All locks survive until the common commit. Admitted uploads and settlements
finish first; later uploads cannot reinsert personal usage between ledger
cleanup and Run deletion.
This also protects deployments without the separate erasure-decision bridge.

The Pi erasure preflight likewise drains usage admission before locking Runs,
including already terminal Pi Runs. Admission and ledger cleanup occur before
the lifecycle's existing 100-millisecond lock timeout; parent, Run and later
deletion locks retain that policy. Shared resource records remain untouched.
While the setting is unset, Clerk retains separately committed ledger cleanup
before Run deletion, and the Pi preflight retains its existing behavior.

X and compaction admission locks are global: account cleanup briefly pauses all
webhook usage writes, settlement and Run deletion. Slow settlement or deletion
delays compaction or account cleanup. No network cleanup runs while those
admission locks are held. Do not configure the setting while any serving or
rollback API can settle or perform ordinary Run deletion without shared
compaction admission; otherwise those transactions could invert the combined
cleanup's ledger/allowance/Run lock order.

## Runner and activation

[#34612](https://github.com/vm0-ai/okou/issues/34612) preserves exact IDs,
occurrences, Q and transient reasons through extraction, bounded chunks,
cross-language copies, serialization and retries. There is no bindingId.

The API adds the capability when claiming a run, not when persisting a queued
context. Rust carries it into its private proxy registry; Python validates it
and snapshots it onto each matched request. Missing capability selects the
existing count-only producer. A malformed advertised capability is rejected,
never interpreted as permission to downgrade. Existing Runner versions ignore
the additive claim field, so capability advertisement alone does not prove a
fleet-wide switch. #34615 owns removal of the absent-capability compatibility
path after older APIs/queued contexts and unsupported rollback targets leave
the supported serving window.

The existing selective parser remains the authoritative count validator. An
additional identity copy retains at most 256 KiB of a JSON document. Only a
completely validated document or NDJSON row can contribute IDs. Exact returned
IDs are extracted from supported post lookup/search/timeline and profile lookup
paths plus `includes.tweets` and `includes.users`. Requested-but-absent objects,
bare references, polls, places and unsupported primary paths never claim a post
or user identity. Count endpoints retain only their authoritative total; incidental
`data` or `includes` objects cannot claim identities. Repeated IDs retain occurrence counts. Each group and final
observation retain at most 1,000 distinct IDs. A larger body or ID set preserves
the authoritative count and records the unidentified portion as `identity_limit`;
malformed bodies keep only the existing trusted count fallback as `parse_fallback`.
This can leave large legitimate responses count-priced rather than deduplicated.

Capable NDJSON flows report one complete validated row at a time while the
connection remains open. The row ordinal, flow, run and category form its stable
source UUID. Observation time is the row's validation time; each row therefore
belongs to one UTC date. A row completed before the configured start date uses
legacy counts; a later row uses v1. Complete trailing rows report once on normal
completion or interruption; malformed rows remain unbilled. Terminal hooks do
not repeat previously emitted rows, including when a later decoder failure ends
the stream. Ordinary JSON uses document validation time and a flow-local terminal
guard, so another response/error notification cannot create a new observation.

Resource observations bypass quantity aggregation. The existing buffer copies
their nested fields and partitions requests by run, protocol and UTC date, with
the same 100-event, 1,000-ID and actual 256 KiB serialized-byte limits as the API.
Retries retain the same UUID, timestamp and payload. Before every HTTP attempt,
including retries after queue waits, the producer permanently rejects dates
older than yesterday; the API remains authoritative for future/run-clock bounds.
This reuses existing delivery ownership, retry caps and shutdown drain; it adds
no durable queue or new guarantee against loss during sustained saturation or
process death. Existing buffer limits trigger flushing rather than imposing a
new hard admission/memory ceiling.

The protocol remainder stays internal to ingestion so the consumer can validate
Q = K + R and bill N + R. User-facing usage and bills show the ordinary net
quantity, with no separate deduplication status or result transport. Do not keep
a flow-local remainder summary or add historical remainder metadata.

[#34615](https://github.com/vm0-ai/okou/issues/34615) verifies the single-account
serving configuration, compatible producers/readers and rollback targets,
measured bounds and fleet-wide legacy upload drain before a clean future UTC
day activation. No organization-by-organization cutover or full-count fallback
for activated days. Legacy GA events remain necessary for existing producers
and other providers. Followers/following and other unverified resource types
remain outside this protocol.

## Qualification and release evidence

The [shared producer/consumer qualification and rollout evidence guide](./x-resource-rollout.md)
maps repeatable tests to the remaining deployed checks for #34615. Matching
Python webhook payloads and API billing results proves the shared examples;
it does not prove a fleet-wide legacy drain or authorize the activation setting.
