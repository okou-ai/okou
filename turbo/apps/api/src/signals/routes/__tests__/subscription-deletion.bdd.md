# subscription-deletion

## subscription-deletion-001

- Vitest: "signed subscription deletion > preserves paid credits and free capabilities after deleting and redelivering pro"
- Mode: run
- Given: An authenticated member’s organization has an active Pro subscription and 20,000 credits with existing grants.
- When: Stripe sends a signed `customer.subscription.deleted` webhook marking the plan cancelled and redelivers the same payload.
- Then: Both deliveries return HTTP 200. Billing reports an active limited-free account with cancelled subscription status, no subscription, cutoff or scheduled change, concurrency limit two, restricted built-in models and no concurrency purchase, auto-recharge or webhook Automation capability. Credits and the complete grant list remain identical.

## subscription-deletion-002

- Vitest: "signed subscription deletion > preserves paid credits and free capabilities after deleting and redelivering team"
- Mode: run
- Given: An authenticated member’s organization has an active Team subscription and 120,000 credits with existing grants.
- When: Stripe sends a signed `customer.subscription.deleted` webhook marking the plan cancelled and redelivers the same payload.
- Then: Both deliveries return HTTP 200. Billing reports an active limited-free account with cancelled subscription status, no subscription, cutoff or scheduled change, concurrency limit two, restricted built-in models and no concurrency purchase, auto-recharge or webhook Automation capability. Credits and the complete grant list remain identical.
