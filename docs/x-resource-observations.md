# X resource observations

This is the dormant preparation contract for
[#34712](https://github.com/vm0-ai/okou/issues/34712), under backend
[#34610](https://github.com/vm0-ai/okou/issues/34610) and overall delivery
[#34532](https://github.com/vm0-ai/okou/issues/34532).

There is one X upstream billing account. Resource deduplication is site-wide
across organizations, users, runs and processes. Retain only the current UTC
date and the previous UTC date. Adding or replacing the billing account needs
a new design decision before that account uses this path; credential refresh
within the same account does not reset resource identity.

## Prepared protocol

The existing usage webhook accepts the strict `x-resource-v1` schema for
validation, then authenticates and rejects every resource or mixed batch with
`400 X resource observations are not enabled` before any financial write.
Legacy count events remain unchanged. There is no advertised capability or
active resource writer. Deploy the complete
[#34713 consumer](https://github.com/vm0-ai/okou/issues/34713) before enabling
producers; the preparation API never acknowledges a resource batch as billed.

Each event carries:

- `protocol: "x-resource-v1"`, a stable source UUID `idempotencyKey`,
  `kind: "connector"`, `provider: "x"`, and category `tweet.read` or `user.read`.
- Original nonnegative safe-integer `quantity` Q and millisecond UTC
  `observedAt` (ISO timestamp ending in Z).
- Distinct `resources: [{ id, occurrences }]`, with exact ASCII decimal IDs
  of 1–32 characters and positive safe-integer occurrence counts.
- Distinct transient `remainder: [{ reason, quantity }]` entries. Reasons are
  `missing_id`, `unsupported_resource`, `identity_limit`, or `parse_fallback`.

The body requires a UUID run ID for v1, at most 100 events and at most 1,000
resource IDs over the whole batch. The consumer must also enforce a 256 KiB
transport limit. Resource type is derived from the category: post or user.
There is no caller-supplied billing scope, binding or net quantity.

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

The table alone does not implement ingestion, time validation, atomic billing
or scheduled cleanup. Those ship together in #34713.

## Consumer transaction and retries

Reuse `usage_event.idempotencyKey` for source idempotency, including a ledger
row when net quantity is zero. The producer preserves one immutable source
UUID, observation time and payload across retries. Keep the existing success
acknowledgement; there is no separate receipt table, payload digest or replay
result API.

Authenticate the run and its org/user ownership, and acquire existing erasure
admission before source lookup or writes. On a source UUID conflict, verify
ownership and acknowledge the owned source without new claims or obligations.
Do not return foreign source records or winning attribution. Reusing a UUID
with changed content is not checked against a stored digest.

Own each source before inserting resources. Acquire source/resource keys in a
deterministic order across the entire batch; organization credit locks cannot
arbitrate site-wide uniqueness. Insert resources with
`ON CONFLICT DO NOTHING RETURNING` and commit their final net pending usage
in the same transaction. Any failure rolls back both, and a source conflict
must not leave new resource rows. The first successfully committed observation
owns the obligation, including allowance/pack-funded reads. Existing credit
settlement remains unchanged.

## Two-date admission and cleanup

Both new reports and retries must have an observed UTC date of today or
yesterday. Apply the existing planned five-minute future/run-clock tolerance
as an additional bound. Reject older dates before source lookup or resource
mutation; a producer must never move an expired observation to a fresh date.
Use JSON completion or complete NDJSON-row time and split streams at UTC
midnight, rather than using upload or settlement time.

Ingestion takes a transaction-scoped shared admission lock; cleanup takes the
same lock exclusively. Sample the database clock after relevant lock waits.
This prevents cleanup from deleting a day while an admitted transaction can
still charge against it. Bound transactions and delete in bounded batches
where `utc_day < current_utc_date - 1`. A delayed cleanup retains extra rows
but never extends admission. No permanent closed-day watermark is needed.

The existing ledger retains healthy processed rows for at least four days,
which exceeds the two-date retry horizon. There is no source replay guarantee
after expiry or compaction; expired requests fail instead of recreating
consumption. Account/run/thread erasure must preserve shared resource rows,
while the existing erasure fence prevents valid old sandbox tokens from
recreating deleted personal billing records.

## Runner, annotation and activation

[#34612](https://github.com/vm0-ai/okou/issues/34612) preserves exact IDs,
occurrences, Q and transient reasons through extraction, bounded chunks,
cross-language copies, serialization and retries. There is no bindingId.
[#34614](https://github.com/vm0-ai/okou/issues/34614) displays
**Cannot deduplicate** / **无法去重** with the current operation when R is
positive, including funded or zero-credit outcomes. A webhook acknowledgement
alone is not that visible annotation. Do not add a second usage report or
historical remainder metadata.

[#34615](https://github.com/vm0-ai/okou/issues/34615) verifies the single-account
serving configuration, compatible producers/readers and rollback targets,
measured bounds and fleet-wide legacy upload drain before a clean future UTC
day activation. No organization-by-organization cutover or full-count fallback
for activated days. Legacy GA events remain necessary for existing producers
and other providers. Followers/following and other unverified resource types
remain outside this protocol.
