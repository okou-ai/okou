# Pending writer boundaries increment

Base: `019922e6fc1329d0a3c1d759cd10a32a08ae070f`, Draft PR #37525.

## Actual ownership changes

`commitPreparedPendingLaunch$` now executes and runtime-decodes the Official,
credit-plan, Pi-memory and fallback-binding SQL in its own transaction. New
`pending-launch-official-plan.ts`, `pending-launch-credit-plan.ts` and
`pending-launch-tail-plan.ts` build finite pure plans from captured facts and
actual returned records; no helper receives a database, transaction, accessor,
node or executor. No command graph is constructed during execution.

Official order remains catalog SHARE, optional credit-plan UPDATE, catalog
validation, sorted installation UPDATE locks, revision/artifact checks and
optional automation UPDATE locks, then the existing session/subscription/queue
admission. Existing comparison/parsing logic is reused. Non-private or
non-installed records continue to fail business admission, including unknown
string states. The admission timing boundary remains after catalog fencing and
early credit acquisition.

Credit SQL locks the entitlement first and probes/locks org_metadata only on an
entitlement miss. Missing-org and missing-entitlement cases and the restricted
built-in-model null invariant are retained. The repeated persistence-time plan
read is retained, not silently replaced with the early snapshot. All capability
fields retain their runtime representations and status normalization.

Pi-memory uses the facts of the successful newly inserted Run instead of
rereading that same row. It retains generation/source eligibility, fresh scoped
feature overrides, current product-thread ownership and the conditional UTC day
upsert. Selection deletion deliberately remains a subsequent statement: a
selector can commit rows while this transaction waits on the day lock, and a
single modifying-CTE snapshot could miss those rows. Only an actual day write
clears selections. Fallback session binding retains its read-then-update order
and original initialized/reused/rotated outcome.

Both allowance paths and issued-window behavior are unchanged. The unique active
Run insertion remains the last SQL statement; claim, Run, Runner, R1, producer,
allowance and tail effects still roll back together. No new lock, coordination
field, retry, timeout, test hook, row assertion or suppression was introduced.

## Explicit remaining boundaries

The pending command still invokes the legacy direct `persistProducerRunBinding`
transaction callback. That callable input prevents a global terminal claim.
Legacy failed-run/resolver and post-commit maintenance paths still call the old
Official/Pi-memory helpers; those excluded call chains and the upper execution
read graph were not governed by this increment. The old helper definitions are
retained where those callers still need them.

No transaction was removed. Its ownership was tightened and its SQL plans
changed. Per-operation diagnostic timing/debug records from the removed helpers
are not all emitted by the new finite plans; overall admission, persistence and
allowance timing remains. SQL plan costs and deployed/public behavior are not
claimed verified.

## Checks

Affected Prettier, ESLint, normal Oxlint and the explicit 128-line owner check
passed. No whole types, Knip, type-aware whole API, Vitest, dev server or CI was
run. Parent integrated verification remains required.
