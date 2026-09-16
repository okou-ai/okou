# X resource observation preparation

[#34712](https://github.com/vm0-ai/okou/issues/34712) prepares the database and
reader for backend parent [#34610](https://github.com/vm0-ai/okou/issues/34610).
**Resource accounting is not enabled.** An authenticated usage batch containing
any `x-resource-v1` event returns `400 X resource observations are not enabled`
before any ledger write, including when mixed with legacy events. No scope is
seeded and no run advertises resource-protocol capability.

[#34713](https://github.com/vm0-ai/okou/issues/34713) must replace this rejection
with the complete binding-authorized receipts/claims/net-obligations transaction
and lifecycle admission. Merely removing the guard would charge the original
count and is unsafe. This preparation alone does not unblock Runner activation.

## Prepared wire contract

The existing `/api/webhooks/agent/usage-event` request remains `{runId, events}`.
Legacy events keep their existing strict shape. The additional strict variant is:

```json
{
  "protocol": "x-resource-v1",
  "idempotencyKey": "8a6b63f5-8a52-4bb1-8570-b13583f0b2e6",
  "kind": "connector",
  "provider": "x",
  "category": "tweet.read",
  "quantity": 5,
  "bindingId": "cf759e30-7bce-4da0-a024-3cb37f66bb95",
  "observedAt": "2026-09-16T23:59:59.999Z",
  "resources": [
    { "id": "9007199254740993", "occurrences": 2 },
    { "id": "9007199254740994", "occurrences": 1 }
  ],
  "remainder": [{ "reason": "missing_id", "quantity": 2 }]
}
```

- Source and binding IDs, and the enclosing v1 run ID, are UUIDs. The source ID
  stays fixed across retries of the same immutable observation chunk.
- `tweet.read` maps to the `post` identity namespace; `user.read` maps to `user`.
  These are the only initial v1 categories. Producers must only identify returned
  objects on supported paths. Followers/following and other unresolved resource
  semantics must not silently inherit these namespaces.
- Resource IDs are exact 1–32 ASCII decimal characters. Do not parse as numbers,
  trim, or remove leading zeros. A resource appears once per event, with its
  positive occurrence count. Namespace and final net charge are server-derived.
- `observedAt` uses UTC `Z` with exactly three fractional digits. It records
  validated JSON completion or complete NDJSON-row observation, never resource
  creation or webhook arrival. Split streams/chunks across UTC midnight.
- Quantity and all counts are safe integers. Counts in resource/reason entries
  are positive; an event may have quantity zero and empty arrays.
- Reasons are `missing_id`, `unsupported_resource`, `identity_limit`, and
  `parse_fallback`. Each appears at most once, and explains units already counted
  by the existing endpoint-specific counter. A reason cannot authorize a forged
  or unverified billing binding. An unverified scope has no v1 capability; do not
  invent a shared default or retry a rejected v1 source as a legacy event.
- At most 100 events and 1,000 resource entries across the entire request are
  accepted by the prepared parser. Duplicate IDs across events still count
  toward the bound. Unknown fields and protocol versions are rejected.

Let Q be `quantity`, K the sum of identified occurrences, and R the sum of reason
quantities. The reader requires **Q = K + R** with exact arithmetic. R is computed
before collapsing duplicate occurrences. In the example K=3 and R=2. If the
second ID was already consumed, the consumer must charge one newly claimed ID
plus R, yielding net quantity 3. It must not calculate R from the two unique IDs.

Semantic limits bound parsed canonical content. They do not enforce the raw
HTTP-byte limit: whitespace and JSON escapes can enlarge transport. The consumer
must enforce **256 KiB before parsing**, plus runtime temporal/binding admission,
before enabling producers. Prepared readers do not acknowledge v1 success.

## Prepared storage

| Table                          | Retained state and relationship                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x_usage_billing_scopes`       | Opaque server-owned scope ID, nullable activation day and closed-through day. Null activation is dormant. No customer or token identity.                                      |
| `x_usage_run_bindings`         | Run, org/user ownership, verified scope reference, non-secret serving-configuration revision and validity interval. Run deletion cascades bindings.                           |
| `x_usage_observation_receipts` | `(run_id, source_id)` key, matching run/binding FK, canonical digest, observation time/UTC day and committed net quantity including zero. Binding deletion cascades receipts. |
| `x_usage_resource_claims`      | Unique `(scope_id, utc_day, namespace, resource_id)`. References only the scope; no customer, run, receipt, financial row or winner metadata.                                 |

The migration is additive and inserts no rows. Old API queries/writers remain
valid. Removing a personal binding/receipt or compacting a raw financial row
cannot remove a shared claim. Scope deletion is restricted while dependent rows
exist. Day and owner indexes support later bounded cleanup. A receipt has no FK
to the compactable ledger; the consumer derives the financial idempotency UUID
from authenticated run/source identity in a dedicated namespace.

The tables do not by themselves implement immutable writes, source replay,
monotonic closure, authorization, verification of serving configuration, or
financial atomicity. Those are mandatory responsibilities of #34713's sole
writer. There is no prepared writer, mutation endpoint, cleanup job or capability
switch. Never write a claim without its same-transaction receipt/net obligation.

No original quantity, occurrence, unidentified-remainder or reason counters are
persisted in receipts, the usage ledger, hourly rollups or historical responses.

## Consumer and Runner handoff

The consumer must bind the scope to the actual historically authorized serving
configuration. A token value/hash, OAuth username, connector source ID or org ID
does not prove upstream billing equivalence. Credential refresh retains a scope
only when the verified upstream subject is unchanged. Validate ownership and
erasure admission before receipt lookup; never return another customer's source
receipt or winning attribution.

For the immutable receipt digest, canonicalize every accepted event field and
the authenticated run ID: normalize UUID spelling, sort distinct resources by
their exact ID and reasons by reason code, serialize a fixed field order in
UTF-8 and hash with SHA-256. Use the millisecond UTC timestamp and exact numeric
values. Array input order is immaterial; occurrence multiplicity, reasons,
quantity, binding and observation time are material. The consumer must supply
executable golden fixtures for this canonicalization and reject changed-source
replays. The receipt stores only digest and committed net outcome, not the input
counters. Retained authorized retries return the existing outcome without a
new obligation, including zero-net sources.

New sources require the parent's five-minute future/run tolerance, 72-hour
admission window and UTC day validation. Use existing account-erasure shared
admission before business locks. Sort acquisition across the complete batch;
org credit locks cannot arbitrate global resource uniqueness. Retain receipts
and claims for seven days after day end; advance the closed-through watermark
under admission exclusion before bounded cleanup. Never reopen purged days.
Run/thread/account erasure must close admission before deleting personal rows.

[#34612](https://github.com/vm0-ai/okou/issues/34612) must retain Q, K and reason
counts transiently through source-preserving copies, serialization, bounded
chunks and retries. [#34614](https://github.com/vm0-ai/okou/issues/34614) uses this
current-operation information to show **Cannot deduplicate** / **无法去重** when
R is positive, including allowance/pack-funded or zero-credit outcomes. A billing
webhook acknowledgement alone is not that user-visible annotation. No second
usage report, historical remainder field or compactor annotation is required.

[#34615](https://github.com/vm0-ai/okou/issues/34615) owns actual upstream mapping
evidence, compatible producers/readers and rollback targets, measured bounded
load, scope-wide legacy upload drain and clean-UTC-day activation. No org-by-org
cutover within a shared scope/day. Activated days cannot roll back to full-count
charging. The existing legacy GA protocol remains valid until its real producers
drain; it is still needed for other providers.
