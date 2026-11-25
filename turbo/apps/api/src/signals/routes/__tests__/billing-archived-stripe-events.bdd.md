# billing-archived-stripe-events

## billing-archived-stripe-events-001

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by invoice purpose"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice metadata purpose is `usage_allowance`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-002

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by subscription purpose"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice's parent subscription metadata has purpose `usage_allowance`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-003

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by archived source"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice metadata has source `atom_usage_allowance`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-004

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by Custom purpose"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice metadata purpose is `custom_plan_subscription`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-005

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by Custom type"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice metadata type is `custom_plan_subscription`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-006

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by Custom tier"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice metadata tier is `custom`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-007

- Vitest: "Stripe billing purpose isolation > keeps paid Plan benefits unchanged when replaying an invoice identified by Custom plan id"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice for a subscription line on the retired price `price_bdd_atom_grant` carries credit-purchase metadata for 900,000 credits, and the invoice metadata plan ID is `custom`.
- When: Stripe delivers the signed `invoice.paid` event for this invoice to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved, updated or cancelled.

## billing-archived-stripe-events-008

- Vitest: "Stripe billing purpose isolation > preserves the paid Plan when an archived-purpose subscription created event contains a Plan price"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. The workspace's subscription is sent with status `active`, metadata purpose `usage_allowance` and a `price_bdd_team` Plan item.
- When: Stripe delivers a signed `customer.subscription.created` event for it to `POST /api/webhooks/stripe`, and the member reads `GET /api/billing/status`.
- Then: The delivery returns HTTP 200, the billing status is identical to before, and Stripe is not asked to retrieve the subscription.

## billing-archived-stripe-events-009

- Vitest: "Stripe billing purpose isolation > preserves the paid Plan when an archived-purpose subscription updated event contains a Plan price"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. The workspace's subscription is sent with status `active`, metadata purpose `usage_allowance` and a `price_bdd_team` Plan item.
- When: Stripe delivers a signed `customer.subscription.updated` event for it to `POST /api/webhooks/stripe`, and the member reads `GET /api/billing/status`.
- Then: The delivery returns HTTP 200, the billing status is identical to before, and Stripe is not asked to retrieve the subscription.

## billing-archived-stripe-events-010

- Vitest: "Stripe billing purpose isolation > preserves the paid Plan when an archived-purpose subscription deleted event contains a Plan price"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. The workspace's subscription is sent with status `canceled`, metadata purpose `usage_allowance` and a `price_bdd_team` Plan item.
- When: Stripe delivers a signed `customer.subscription.deleted` event for it to `POST /api/webhooks/stripe`, and the member reads `GET /api/billing/status`.
- Then: The delivery returns HTTP 200, the billing status is identical to before, and Stripe is not asked to retrieve the subscription.

## billing-archived-stripe-events-011

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using inline expanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and the invoice line's price embeds the archived Product (metadata purpose `usage_allowance`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-012

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using retrieved expanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price from Stripe returns it with the archived Product (metadata purpose `usage_allowance`) expanded.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-013

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using retrieved unexpanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price returns only the Product ID, and retrieving that Product returns the archived Product (metadata purpose `usage_allowance`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated. Stripe is asked to retrieve the Product by its ID.

## billing-archived-stripe-events-014

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using modern unexpanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and the line identifies the price and Product IDs through `pricing.price_details`, and retrieving that Product returns the archived Product (metadata purpose `usage_allowance`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated. Stripe is asked to retrieve the Product by its ID.

## billing-archived-stripe-events-015

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using inline deleted provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and the invoice line's price embeds a deleted Product.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-016

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using retrieved deleted provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price returns a deleted Product.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-017

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using missing Price provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price fails with `resource_missing`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-018

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using missing Product provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price returns a Product ID and retrieving the Product fails with `resource_missing`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-019

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using transient Price provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price fails with a temporary Stripe error.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 500. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-020

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_atom_grant using invalid fetched Price provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_atom_grant` with no subscription parent, and retrieving the Price returns a Price without a Product.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 500. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-021

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using inline expanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and the invoice line's price embeds the archived Product (metadata purpose `usage_allowance`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-022

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using retrieved expanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price from Stripe returns it with the archived Product (metadata purpose `usage_allowance`) expanded.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-023

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using retrieved unexpanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price returns only the Product ID, and retrieving that Product returns the archived Product (metadata purpose `usage_allowance`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated. Stripe is asked to retrieve the Product by its ID.

## billing-archived-stripe-events-024

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using modern unexpanded provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and the line identifies the price and Product IDs through `pricing.price_details`, and retrieving that Product returns the archived Product (metadata purpose `usage_allowance`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated. Stripe is asked to retrieve the Product by its ID.

## billing-archived-stripe-events-025

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using inline deleted provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and the invoice line's price embeds a deleted Product.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-026

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using retrieved deleted provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price returns a deleted Product.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-027

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using missing Price provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price fails with `resource_missing`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-028

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using missing Product provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price returns a Product ID and retrieving the Product fails with `resource_missing`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-029

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using transient Price provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price fails with a temporary Stripe error.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 500. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-030

- Vitest: "Stripe billing purpose isolation > ignores Product-only archived lines with price_bdd_team using invalid fetched Price provenance"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. A zero-amount invoice-item invoice with credit-purchase metadata for 900,000 credits has one line on `price_bdd_team` with no subscription parent, and retrieving the Price returns a Price without a Product.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, and the member reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 500. The billing status is identical to before, and no Stripe subscription is retrieved or updated.

## billing-archived-stripe-events-031

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using line metadata"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and the retired line's metadata has purpose `usage_allowance`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-032

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using price binding"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and the invoice metadata binds `allowancePriceId` to the retired price.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-033

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using unmarked price"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and the retired price carries no allowance marker.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-034

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using Product metadata"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and Stripe's Price lookup returns a Product with metadata purpose `usage_allowance` for the retired price.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-035

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using missing Price"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and retrieving the retired Price fails with `resource_missing`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-036

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using missing Product"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and the retired Price's Product `prod_missing_archive` cannot be retrieved (`resource_missing`).
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-037

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using transient Price"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and retrieving the retired Price fails with a temporary Stripe error.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` once, and the member reads `GET /api/billing/status`.
- Then: The delivery returns HTTP 500 and the billing status is identical to before.

## billing-archived-stripe-events-038

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using credit purchase header"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and the invoice metadata binds `allowancePriceId` to the retired price with type `credit_purchase`.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.

## billing-archived-stripe-events-039

- Vitest: "Stripe billing purpose isolation > grants only Plan and concurrency benefits from a mixed invoice using auto recharge header"
- Mode: run
- Given: A workspace has an active paid Pro Plan through Stripe, and Stripe billing webhooks are configured. Its subscription has a retired `price_bdd_atom_grant` item ending in 7 days, a `price_bdd_pro` Plan item and a `price_bdd_concurrency` item with quantity 3 both ending in 45 days. A zero-amount subscription invoice with subtotal 900,000 has lines for all three items, and the invoice metadata binds `allowancePriceId` to the retired price with type `auto_recharge` and 900,000 credits.
- When: Stripe delivers the signed `invoice.paid` event to `POST /api/webhooks/stripe` twice, reads `GET /api/billing/status`, then delivers a `customer.subscription.updated` event with `cancel_at_period_end` true and reads status again.
- Then: Both deliveries return HTTP 200. Billing status shows credits increased by exactly 20,000, tier `pro`, the period ending at the 45-day line end, and one concurrency subscription for the Plan subscription with quantity 3. After a signed `customer.subscription.updated` event marking the subscription to cancel at period end (HTTP 200), the period end and credits are unchanged.
