# Terminal sandbox StorageVersionLineage READ ownership

Related to #37513; bounded D14, not full storage ownership or parent completion.
Baseline: `c0e8f661e10f5d464cc271d97d95df904b13c196`.

The existing webhook validates its body and sandbox run identity, then builds
`createSandboxStorageCommit` before command execution. A private lineage computed
is now constructed only for a truthy request `parentVersionId`. The contract
allows undefined and empty strings: absence of the node preserves that original
truthiness rejection at the same terminal checkpoint, without fake IDs, casts,
parameter slots, command-time graph construction or a fallback query.

The private factory captures only plain storage/version/parent/run identities
and gets `db$` inside its callback. It selects only the official lineage `id`,
with AND predicates in storageId, versionId, parentVersionId, runId order and
LIMIT 1. Schema decoding, undefined for zero rows and error propagation remain
unchanged. Construction performs no SQL. The supported mounted-success path
requires strict request/mount storage ID equality; production mount producers
carry DB-selected Storage IDs. This is not a claim about arbitrary historical
UUID textual equality.

Consumption remains terminal version READ → Abort → parent/persistedMatches
rejection → independent lineage READ → Abort → missing-lineage 404 → existing
generic commit and terminal failure mapping. Ordinary, receipt-replay, missing
or empty parent and persisted mismatch paths add no lineage query or await.
The lineage node never reuses receipt, replay, version or locked/Tx observations.
D13's version node is unchanged. The public factory surface stays `{ commit$ }`.

Production transaction delta is zero; no transaction was removed or moved.
Source-level lineage queries remain zero or one on first branch consumption,
not a measured runtime count. Mounted lookup, prepare/maintenance, generic
storage writes, transactions, cleanup and external I/O remain untouched. Their
existing guarantees and residual debt, including D7/full D9/D11, remain separate.

No local Vitest/devserver or production SQL is used. Applicable formatting,
static/type-aware lint, types and mandatory hooks are reported separately from
natural PR CI. Existing public webhook assertions are retained, not replaced
with implementation-mirror tests. Runtime SQL/count/plan/decoder execution,
provider-error/Abort races, exact scheduling and repeated same-Store freshness
remain unproven. Independent current-HEAD review and later protected merge are
separate steps; this delivery is a Draft PR, without deployment or release.
