# Usage settlement

## Nonnegative member packages and organization overdraft

A member package is prepaid credit, not a liability account. After allowances,
consume only the actor's unexpired purchased credits, then bonus credits, using
earliest expiry and grant ID within each source. A grant cannot be debited below
zero. All uncovered charges debit the organization wallet, including when that
wallet is already zero or negative. Organization-only actors use the same rule;
no captured organization/member funding mode is required.

New package grants do not repay organization debt. Administrator available-credit
labels sum `max(org available, 0) + member package credits`. The balance detail
retains the signed organization balance. Admission still rejects new paid work
without available credits or another applicable entitlement; settling incurred
usage into organization debt does not allow unlimited new work.

## Transaction and concurrency policy

Prepare prices and allowance allocations before the standalone transaction.
Claim only pending events; a partial claim rolls back, and a repeated event
cannot charge twice. Lock the organization wallet before grant/expiry-lot rows,
then re-read member cash under row locks. Recalculate the member/organization
split using these current balances rather than a prepared positive-balance
snapshot. Apply existing organization expiration before uncovered charges or
legacy debt are debited. Grant debits additionally require the
locked remainder to cover the deduction. Cash selection, processed receipts and
all debits commit together. No external I/O runs inside the financial transaction.

The wallet lock serializes cash allocation within an organization. Concurrent
requests therefore cannot spend the same package remainder twice. Source order
and FEFO use PostgreSQL ordering of the locked rows, retaining timestamp precision.
Shared cash queries and debt-transfer SQL are pure builders; the owning transaction
executes them without passing its database handle into domain helpers. Organization expiration acquires the wallet first
as well. Allowance consumption retains its accepted atomic-increment overuse
policy; this change does not promise a strict allowance cap. Missing rows,
invalid pricing and database failures remain billing errors. Background Social
ownership/lease checks remain intact and its financial writes use the same path.

## Legacy package overdrafts

Migration `1346_usage_pack_overdraft_transfers` moves retained negative grant
remainders to their organization wallets and zeroes those grant remainders in
one transaction. An append-only transfer receipt retains the organization,
member, grant identity and amount without a cascading grant FK. Original grant
amount, source, expiry and payment/refund provenance are unchanged. Expired
negative grants are included; positive grants and unrelated wallets are untouched.
Existing expired organization lots are cleared before transferring debt, so their
clamp cannot erase the newly moved liability. No historical usage is replayed or repriced, and rerunning the repair portion
cannot transfer the same cleared remainder twice.

During the old/new API overlap, an old writer can still generate negative grants.
New settlement lazily performs the same locked, audited transfer before cash
allocation; member-removal refund preparation does so before clearing grants.
The shared repair statement clears expired lots and negative grants, appends
receipts and updates the wallet once, with expiration applied before the transferred
debit. A missing wallet leaves actual liabilities untouched and fails closed;
no wallet with no negative grant remains a valid unfunded member cleanup.
Organization expiration runs before this lazy transfer, never after it in the
same settlement, so its existing clamp cannot erase the newly moved liability.
There is no debt forgiveness, cross-member spending or compensation cron.

Concurrent creation of an allowance window is resolved by its unique
`(entitlement_id, kind, starts_at)` identity. After `INSERT ... ON CONFLICT DO
NOTHING`, allocations use the persisted window ID instead of a losing creator's
proposed UUID.

## Provider-result delivery

After a synchronous managed provider has returned valid data, billing failure
must not turn that result into an API failure. The successful-result billing
boundary logs the exception and returns `creditsCharged: null`. Null means the
charge is unknown; it is not a free result or a promise that settlement will
succeed. Cancellation still propagates. Admission, authentication and provider
errors retain their original error behavior.

Durably recorded pending events remain eligible for the existing settlement
cron. A failed usage insertion has no durable event; a pricing error may already
have a processed zero-charge receipt. Neither case is silently described as a
successful deferred charge. No retry of provider work is introduced.

This delivery boundary covers synchronous search, scrape, SocialKit requests,
finance, SEO, maps, weather/air quality and people search. Persisted download and
background Social job delivery state machines are not changed.

## Deployment boundary

Apply migration `1346_usage_pack_overdraft_transfers` before the new API. The
new writer requires its audit table. Old APIs can still write against the expanded
database, but retain their accepted package-overdraft behavior until drained.
Rolling back the API does not undo transfers: the organization retains the debt,
and the old writer can again create package negatives.

Do not claim the global nonnegative invariant until outgoing writers and rollback
targets have drained and remaining legacy negatives have been reconciled. Restore
and validate a database `remaining_amount >= 0` check only in that subsequent
contraction; adding it before the new writer serves would turn outgoing concurrent
settlement into billing failures. The current relaxed lower-bound schema is
intentional for this expand release. API/App responses and Runner protocols are
unchanged; old App versions retain the signed-combined-label mismatch until they
update. This PR does not authorize production release or operator writes.

New contracts accept both the old numeric charge and null. Current CLI HTTP
clients do not enable response validation: old clients still receive successful
provider data, but may display `null` or incorrectly treat it as zero in aggregate
accounting. The updated CLI prints pending and preserves unknown SocialKit totals
through pagination and checkpoints. Older CLI checkpoint readers cannot resume a
checkpoint containing null; use the updated CLI for those checkpoints.
