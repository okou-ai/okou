# billing-concurrency-invoice-publication

## billing-concurrency-invoice-publication-001

- Vitest: "Concurrency invoice publication > retries a concurrency invoice after a newer subscription cancellation wins"
- Mode: run
- Given: An organization has a two-slot concurrency subscription and an existing credit balance. Stripe initially returns the active subscription while a newer cancellation-at-period-end update is accepted for the same subscription.
- When: Stripe delivers a signed paid invoice for the two slots during the update, then delivers the same invoice twice more.
- Then: The first invoice delivery returns HTTP 500 and both subsequent deliveries return HTTP 200. After each successful delivery billing status retains the original credit balance and exactly one matching subscription with quantity two, the original period end and cancellation at period end.
