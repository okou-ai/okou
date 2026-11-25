# billing-stripe-metadata-binding

## billing-stripe-metadata-binding-001

- Vitest: "initializes a fresh customer metadata Plan and replays without another provider lookup"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. Stripe reports the incoming customer with `metadata.orgId` set to the admin's organization.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, the admin reads `GET /api/billing/status`, then Stripe would fail any further customer lookup and the same kind of webhook is delivered again before the admin reads status again.
- Then: Both webhooks return HTTP 200 and Stripe's customer lookup is called only once in total. Billing status reports tier `limited-free-1`, 0 credits, concurrency limit 2, `canBuyCredits` true, `canBuyConcurrency`, `showUsagePack` and `autoRechargeAllowed` false, and restricted built-in models; the second status read is identical.

## billing-stripe-metadata-binding-002

- Vitest: "preserves a check-in Plan and reward and skips lazy Clerk existence lookup"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. The admin has checked in through `POST /api/get-started/check-in` (receiving the check-in Plan and reward) and read billing status. Stripe reports the incoming customer with `metadata.orgId` set to the admin's organization, and Clerk's organization lookup would fail.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then the admin reads `GET /api/billing/status` and checks in again.
- Then: The webhook returns HTTP 200 without calling Clerk's organization lookup. Billing status is identical to before, and the repeat check-in returns the same body as the first.

## billing-stripe-metadata-binding-003

- Vitest: "keeps a different published customer and the complete public Plan unchanged"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. The admin has already opened the billing portal through `POST /api/billing/portal`, which created and published a Stripe customer for the organization, and read billing status. Stripe reports a different incoming customer whose `metadata.orgId` is the admin's organization.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe` for the different customer, then the admin reads `GET /api/billing/status` and opens the billing portal again.
- Then: The webhook returns HTTP 200 and billing status is identical to before. The second portal session is created for the originally published customer with configuration `bpc_metadata_binding`, and Stripe created a customer only once.

## billing-stripe-metadata-binding-004

- Vitest: "ignores a deleted customer and preserves the public Plan"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. The admin has checked in through `POST /api/get-started/check-in` and read billing status. Stripe reports the incoming customer as deleted. Parameter row: `deleted`.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200, billing status is identical to before, Stripe's customer lookup is called with the incoming customer ID, and Clerk's organization lookup is not called.

## billing-stripe-metadata-binding-005

- Vitest: "ignores a missing metadata customer and preserves the public Plan"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. The admin has checked in through `POST /api/get-started/check-in` and read billing status. Stripe reports the incoming customer as having empty metadata (no `orgId`). Parameter row: `missing metadata`.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200, billing status is identical to before, Stripe's customer lookup is called with the incoming customer ID, and Clerk's organization lookup is not called.

## billing-stripe-metadata-binding-006

- Vitest: "ignores Clerk's explicit missing organization response {\"statusCode\":404}"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. Stripe reports the incoming customer with `metadata.orgId` set to the admin's organization, but Clerk's organization lookup fails with an explicit missing-organization response `{"statusCode":404}`. Parameter row: `{"statusCode":404}`.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then the admin requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The webhook returns HTTP 200 and binds nothing. The portal request returns HTTP 200; Stripe creates exactly one new customer and the portal session is created for that newly published customer with configuration `bpc_metadata_binding`.

## billing-stripe-metadata-binding-007

- Vitest: "ignores Clerk's explicit missing organization response {\"code\":\"NOT_FOUND\"}"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. Stripe reports the incoming customer with `metadata.orgId` set to the admin's organization, but Clerk's organization lookup fails with an explicit missing-organization response `{"code":"NOT_FOUND"}`. Parameter row: `{"code":"NOT_FOUND"}`.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then the admin requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The webhook returns HTTP 200 and binds nothing. The portal request returns HTTP 200; Stripe creates exactly one new customer and the portal session is created for that newly published customer with configuration `bpc_metadata_binding`.

## billing-stripe-metadata-binding-008

- Vitest: "ignores Clerk's explicit missing organization response {\"name\":\"NotFoundError\"}"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. Stripe reports the incoming customer with `metadata.orgId` set to the admin's organization, but Clerk's organization lookup fails with an explicit missing-organization response `{"name":"NotFoundError"}`. Parameter row: `{"name":"NotFoundError"}`.
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then the admin requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The webhook returns HTTP 200 and binds nothing. The portal request returns HTTP 200; Stripe creates exactly one new customer and the portal session is created for that newly published customer with configuration `bpc_metadata_binding`.

## billing-stripe-metadata-binding-009

- Vitest: "propagates a Clerk dependency error and accepts a later signed delivery"
- Mode: run
- Given: The Stripe webhook secret is configured and deliveries are verified with real Stripe signatures. A signed-in org admin has a new organization with no billing record. Stripe reports the incoming customer with `metadata.orgId` set to the admin's organization, and Clerk's organization lookup fails once with a generic dependency error ("Clerk unavailable").
- When: Stripe delivers a signed Stripe `customer.subscription.created` webhook for an active add-on subscription (a single concurrency item, no Plan item) of that customer to `POST /api/webhooks/stripe`, then delivers it again after Clerk recovers, and the admin reads `GET /api/billing/status`.
- Then: The first delivery fails with HTTP 500, the second returns HTTP 200, and billing status reports tier `limited-free-1`, 0 credits and concurrency limit 2.
