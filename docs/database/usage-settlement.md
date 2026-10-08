# Usage settlement

## Accepted concurrency policy

Prepare the price, member-credit split and expiry-lot split before the standalone
settlement transaction. New usage is credit-only. Commit the following together:

1. Claim the prepared usage rows with `status = 'pending'`.
2. Decrement member grants, shared credits and expiry lots using database arithmetic.
3. Persist charges and processed receipts.

The pending claim, not a credit-row version, prevents duplicate charging. A
partially claimed batch rolls back rather than applying a plan for unclaimed
usage. A competing successful settlement can supply the existing receipt.

Normal concurrent changes do not reject a prepared financial split. Two requests
may both prepare against the same available credit package. A selected package
or expiry lot can become negative. This is an explicitly accepted business trade-off. Preparation and
spendable-balance reads select only positive, unexpired credits; expiration also
clears only positive remainders, so a negative remainder is not credited back.
There is no compensation cron in this change.

Source priority and FEFO are evaluated when preparing the plan, not enforced
against all concurrent changes at commit. Missing financial rows, invalid pricing
and database failures remain billing errors. Existing background Social job
ownership/lease checks and expiration admission remain intact. Social jobs
publish and claim a new usage identity within their transaction; their credit
debits use the same atomic arithmetic policy.

## Allowance data removed

The owner confirmed that only the Okou team received Allowance and requested
complete deletion of that history. Migration 1346 drops the entitlement, window
and allocation tables and the hourly Allowance columns. No serving code issues,
reads, refreshes, reserves or consumes Allowance. Reports sum only recorded
`creditsCharged`; wallets and ordinary usage facts are not changed, and processed
history is never repriced or replayed. Compaction conserves quantity and credits
and preserves billing identity fences and transactional rollback without any
window reconciliation. Privacy deletion still erases owned raw/hourly usage;
there is no separate Allowance archive cleanup.
See [deployment compatibility](../deployment-compatibility.md#organization-usage-allowance-retired)
for the owner-accepted, non-rolling DB/API cutover, rollback floor and external
Stripe isolation. Deployment-window errors may affect shared paths for external
organizations too; risk acceptance does not authorize production execution.

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

Migration `1314_allow-concurrent-usage-pack-overdraft` relaxes the member grant's
lower-bound check while retaining `remaining_amount <= original_amount`. Apply
it before deploying the new settlement writer. The old writer can run against
the relaxed constraint; it retains its older concurrency checks. On an old DB,
an attempted overdraft rolls back, and the new synchronous API still returns
the provider result with an unknown charge.

New contracts accept both the old numeric charge and null. Current CLI HTTP
clients do not enable response validation: old clients still receive successful
provider data, but may display `null` or incorrectly treat it as zero in aggregate
accounting. The updated CLI prints pending and preserves unknown SocialKit totals
through pagination and checkpoints. Older CLI checkpoint readers cannot resume a
checkpoint containing null; use the updated CLI for those checkpoints.
