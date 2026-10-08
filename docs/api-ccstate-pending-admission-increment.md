# Pending admission writer increment

Base: `9775736706`, existing Draft PR #37525. This is an increment, not terminal
conformance with the API ccstate refactoring target.

## Ownership

`pending-launch-admission-plan.ts` exports only pure plan/transition functions,
a runtime result schema and a plain progress type. It receives no database,
transaction, accessor, computed, command or executor. Its finite progression is
thread snapshot -> expected session -> captured subscription -> FIFO head ->
claim. Every phase occurs at most once; absent phases are skipped, never retried.
`commitPreparedPendingLaunch$` executes and decodes each SQL statement directly
through `parseRawRows(schema, await tx.execute(sql))` inside its own transaction.
No new signal nodes, persistent coordination, locks or callbacks were added.

Deleted: `validateThreadSessionSnapshot`, `validateCapturedSubscriptionAccount`,
`commitValidatedPreparedLaunch`, both queue-first launch forwarding helpers,
legacy `resolveQueueFirstRunAdmission` / `claimQueueFirstRunAssociation`, their
transaction-bearing Symbol and the unused personal-subscription admission
wrapper. Other model-provider read graphs remain unchanged.

## Invariants and SQL boundaries

Thread binding expectations are checked before the existing expected-session
`FOR UPDATE`, including conversation identity. No thread lock was added. The
account read remains unlocked and requires the exact source ID, org, user,
provider type and disconnected-at-null predicate. Missing/wrong/disconnected
sources keep the explicit subscription conflict result; captured billing identity
uses the existing canonical identity hash.

The queue read uses the authoritative run-less input predicate, revocation edge,
FIFO sequence and one canonical payload/model projection. It combines the old
candidate/revocation/head reads into one bounded anti-revocation query. A head
mismatch or unique replacement-edge conflict still loses the claim. The fresh
Run UUID remains the replacement identity and initial-input lower bound. The
queue token fence still follows this claim. Both issued-allowance paths and the
final active-run uniqueness insertion are unchanged.

Pending launch row SQL now has explicit result aliases and a runtime timestamp/
nullable-field schema, executed at the top level rather than through a nested
modifying CTE. Native-session reset still precedes Run timestamp sampling.

## Residual and verification boundaries

`commitPreparedLaunchAdmission` still forwards `tx` to Official validation only.
Official catalog fencing, credit-plan reads, Pi-memory scheduling, fallback
`persistThreadSessionBinding` and direct producer callbacks still forward it;
these remain violations. The transaction is retained for claim/Run/Runner/R1/
producer/allowance/active-run rollback, not claimed removed.

The old per-phase admission SQL timing labels are not emitted by the new pure
plan loop; existing overall admission, persistence and allowance timing remains.
Read-statement count and queue plan shape changed; deployed behavior, plan costs,
full types and integrated CI have not been verified in this worker.

Affected Prettier, ESLint, normal Oxlint and the explicit 128-line execution-owner
check pass. No whole-API types, Knip, type-aware lint, Vitest, dev server or CI was
run; integrated verification remains with the parent.
