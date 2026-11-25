# billing-entitlement-fixture

## billing-entitlement-fixture-001

- Vitest: "Stripe-backed billing entitlement fixtures > grants pro with full-UUID Stripe identities"
- Mode: run
- Intent: review
- Given: The shared test fixture has a new organization that requests a Pro entitlement through the Stripe HTTP boundary.
- When: The fixture completes entitlement and reads public billing status.
- Then: The invoice, customer and subscription fixture identities share one full UUID suffix. Billing reports the requested plan and a subscription.

## billing-entitlement-fixture-002

- Vitest: "Stripe-backed billing entitlement fixtures > grants team with full-UUID Stripe identities"
- Mode: run
- Intent: review
- Given: The shared test fixture has a new organization that requests a Team entitlement through the Stripe HTTP boundary.
- When: The fixture completes entitlement and reads public billing status.
- Then: The invoice, customer and subscription fixture identities share one full UUID suffix. Billing reports the requested plan and a subscription.

## billing-entitlement-fixture-003

- Vitest: "Stripe-backed billing entitlement fixtures > preserves explicit customer and subscription bindings"
- Mode: run
- Intent: review
- Given: The fixture has a new organization and explicitly supplied customer and subscription IDs.
- When: The fixture grants Pro and reads billing status.
- Then: The fixture returns those exact bindings, and public status reports Pro with a subscription.

## billing-entitlement-fixture-004

- Vitest: "Stripe-backed billing entitlement fixtures > reports owned identities and billing state when a customer belongs to another org"
- Mode: run
- Intent: review
- Given: One fixture organization already owns a Pro customer binding. A different organization attempts to use that customer with its own subscription ID.
- When: The fixture attempts the second grant and reads billing for both organizations.
- Then: The fixture error identifies the attempted organization, customer, subscription and full UUID invoice, plus the limited-free state with no subscription and zero credits. The original organization stays subscribed to Pro and the other remains limited-free.
