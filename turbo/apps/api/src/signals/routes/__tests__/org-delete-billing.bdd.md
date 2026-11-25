# org-delete-billing

## org-delete-billing-001

- Vitest: "immediately cancels and proportionally refunds every org subscription source"
- Mode: run
- Given: A signed-in workspace admin's organization has a paid Pro Plan subscription and a concurrency subscription, both seeded through paid-invoice webhooks. At deletion time Stripe lists the customer's subscriptions in two pages: the Plan and a usage-pack subscription, then an archived allowance subscription; each of the three org subscriptions has a paid 1,000-cent invoice whose period is 80% elapsed.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 200 `{ message: "Organization deleted" }`. The second subscription page is requested with `starting_after` the usage-pack ID. Stripe cancels exactly the three org subscriptions immediately (`invoice_now: false`, `prorate: false`) with idempotency keys `org-delete:<org>:<subscription>:cancel`. Three credit notes refund 200 cents each against the matching invoices with metadata purpose `org_deletion_prorated_refund`, org ID, subscription ID and deletion timestamp, and the last refund is issued before Clerk deletes the organization.

## org-delete-billing-002

- Vitest: "does not cancel an archive-only subscription identified by bound price on the live Plan customer"
- Mode: run
- Given: A signed-in admin's organization has a live Pro Plan subscription, and the same Stripe customer also has an archive-only allowance subscription identified by an `allowancePriceId` metadata binding to its price (row `bound price`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 200 `{ message: "Organization deleted" }`. Stripe cancels only the Plan subscription once with its `org-delete:<org>:<plan>:cancel` key, the archive subscription is never updated, and exactly one credit note is created.

## org-delete-billing-003

- Vitest: "does not cancel an archive-only subscription identified by expanded Product on the live Plan customer"
- Mode: run
- Given: A signed-in admin's organization has a live Pro Plan subscription, and the same Stripe customer also has an archive-only subscription whose price's expanded Product carries `purpose: usage_allowance` metadata (row `expanded Product`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 200 `{ message: "Organization deleted" }`. Stripe cancels only the Plan subscription once with its `org-delete:<org>:<plan>:cancel` key, the archive subscription is never updated, and exactly one credit note is created.

## org-delete-billing-004

- Vitest: "does not cancel an archive-only subscription identified by unexpanded Product on the live Plan customer"
- Mode: run
- Given: A signed-in admin's organization has a live Pro Plan subscription, and the same Stripe customer also has an archive-only subscription whose price references by ID a Product that Stripe returns with `purpose: usage_allowance` metadata (row `unexpanded Product`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 200 `{ message: "Organization deleted" }`. Stripe cancels only the Plan subscription once with its `org-delete:<org>:<plan>:cancel` key, the archive subscription is never updated, and exactly one credit note is created.

## org-delete-billing-005

- Vitest: "refunds only ordinary paid portions across paginated invoice price binding identities"
- Mode: run
- Given: A signed-in admin's organization has a Pro Plan subscription whose paid invoice has paginated lines: an ordinary 1,000-cent line and a 2,000-cent archived allowance line identified by the invoice metadata `allowancePriceId` (row `invoice price binding`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are fetched in two pages, and exactly one credit note refunds 200 cents (amount and refund amount) against that invoice with an idempotency key.

## org-delete-billing-006

- Vitest: "refunds only ordinary paid portions across paginated parent price binding identities"
- Mode: run
- Given: A signed-in admin's organization has a Pro Plan subscription whose paid invoice has paginated lines: an ordinary 1,000-cent line and a 2,000-cent archived allowance line identified by the invoice parent's subscription metadata `allowancePriceId` (row `parent price binding`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are fetched in two pages, and exactly one credit note refunds 200 cents (amount and refund amount) against that invoice with an idempotency key.

## org-delete-billing-007

- Vitest: "refunds only ordinary paid portions across paginated Product metadata identities"
- Mode: run
- Given: A signed-in admin's organization has a Pro Plan subscription whose paid invoice has paginated lines: an ordinary 1,000-cent line and a 2,000-cent line whose price Product carries `purpose: usage_allowance` metadata (row `Product metadata`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are fetched in two pages, and exactly one credit note refunds 200 cents (amount and refund amount) against that invoice with an idempotency key.

## org-delete-billing-008

- Vitest: "refunds only ordinary paid portions across paginated archived invoice header identities"
- Mode: run
- Given: A signed-in admin's organization has a Pro Plan subscription with an ordinary paid invoice and a second paid invoice whose header metadata is `purpose: usage_allowance` and whose paginated lines include a 2,000-cent archived line (row `archived invoice header`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are fetched in two pages, and exactly one credit note refunds 200 cents (amount and refund amount) against the ordinary invoice, not the archived-header invoice, with an idempotency key.

## org-delete-billing-009

- Vitest: "refunds only ordinary paid portions across paginated archived parent header identities"
- Mode: run
- Given: A signed-in admin's organization has a Pro Plan subscription with an ordinary paid invoice and a second paid invoice whose parent subscription metadata is `purpose: usage_allowance` and whose paginated lines include a 2,000-cent archived line (row `archived parent header`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are fetched in two pages, and exactly one credit note refunds 200 cents (amount and refund amount) against the ordinary invoice, not the archived-header invoice, with an idempotency key.

## org-delete-billing-010

- Vitest: "refunds only ordinary paid portions across paginated shared archived concurrency header identities"
- Mode: run
- Given: A signed-in admin's organization has a subscription whose paid invoice header says `purpose: usage_allowance` but whose paginated lines include an ordinary 1,000-cent concurrency-price line and a 2,000-cent archived line (row `shared archived concurrency header`).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are fetched in two pages, and exactly one credit note refunds 200 cents (amount and refund amount) against that invoice with an idempotency key.

## org-delete-billing-011

- Vitest: "refunds every paginated invoice line"
- Mode: run
- Given: A signed-in admin's organization has a Pro Plan subscription whose paid invoice is half elapsed and has two pages of lines (600 and 400 cents).
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe line items are listed first with `limit: 100` and then with `starting_after` the first line ID, and the credit note preview covers 500 cents against that invoice.

## org-delete-billing-012

- Vitest: "deletes an org without Stripe calls when it has no billing references"
- Mode: run
- Given: A signed-in admin's organization has no billing references.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 200 `{ message: "Organization deleted" }`, and Stripe is never asked to list or cancel subscriptions or create credit notes.

## org-delete-billing-013

- Vitest: "does not refund non-subscription purchases for an org customer"
- Mode: run
- Given: A signed-in admin's organization bought 100,000 credits through a one-time Stripe purchase and has no subscription.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 200 `{ message: "Organization deleted" }`, and Stripe is never asked to list subscriptions or invoices or create credit notes.

## org-delete-billing-014

- Vitest: "cancels trials and unpaid subscriptions without inventing a refund"
- Mode: run
- Given: A signed-in admin's organization has a `trialing` subscription and an `unpaid` subscription with no paid invoices.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe cancels both subscriptions, and no credit note is previewed or created.

## org-delete-billing-015

- Vitest: "cancels fully discounted subscriptions without inventing a refund"
- Mode: run
- Given: A signed-in admin's organization has a subscription whose only invoice line is fully discounted, so the invoice amount due is 0.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe cancels the subscription once, no credit note is previewed or created, and Clerk deletes the organization once.

## org-delete-billing-016

- Vitest: "nets upgrade credits and excludes one-time invoice items from proration"
- Mode: run
- Given: A signed-in admin's organization has a subscription with an original paid invoice (a 1,000-cent subscription line with 100 cents exclusive tax plus a 2,000-cent one-time invoice item) and an upgrade invoice (a -600-cent credit and a 1,200-cent charge), 40% of the period remaining.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Credit notes are previewed first for 440 cents against the original invoice and then for 300 cents against the upgrade invoice.

## org-delete-billing-017

- Vitest: "nets a separate downgrade credit before refunding unused time"
- Mode: run
- Given: A signed-in admin's organization has a subscription with a 2,000-cent original paid invoice and a separate downgrade invoice (-1,000-cent credit and 500-cent charge), 25% of the period remaining.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Exactly one credit note is previewed, for 250 cents against the original invoice, and exactly one credit note is created.

## org-delete-billing-018

- Vitest: "reuses a prior deletion marker and issued credit note on retry"
- Mode: run
- Given: A signed-in admin's organization has a subscription already cancelled with the org-deletion marker metadata, a historical cancelled subscription, and an issued credit note with matching org-deletion refund metadata.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: Stripe subscriptions are neither updated nor cancelled, invoices are listed once for the marked subscription (`status: paid`, `limit: 100`), no credit note is previewed or created, and Clerk deletes the organization.

## org-delete-billing-019

- Vitest: "does not delete the org when its proportional refund fails"
- Mode: run
- Given: A signed-in admin's organization has a half-elapsed paid subscription, preferences in `Asia/Shanghai`/`en-US`, and an installed connected Slack workspace; Stripe fails to create the refund credit note.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 500. Stripe cancels the subscription once, Clerk does not delete the organization, preferences still read `Asia/Shanghai`/`en-US`, and the Slack status still shows installed and connected with the workspace name.

## org-delete-billing-020

- Vitest: "fails closed when a Stripe page has no continuation cursor"
- Mode: run
- Given: A signed-in admin's organization has a Plan subscription, and Stripe returns an empty subscription page claiming more results.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 500, no subscription is cancelled, and Clerk does not delete the organization.

## org-delete-billing-021

- Vitest: "does not delete the org before its Stripe refund succeeds"
- Mode: run
- Given: A signed-in admin's organization has a half-elapsed paid subscription, and Stripe's credit note refund comes back `pending`.
- When: The admin calls `POST /api/org/delete` with `confirm: "confirm"`.
- Then: The response is HTTP 500 and Clerk does not delete the organization.

## org-delete-billing-022

- Vitest: "retries Clerk deletion refunds on redelivery with the same provider idempotency key"
- Mode: run
- Given: An organization has a half-elapsed paid Pro subscription; Stripe fails the first refund credit note and succeeds on the second, and on redelivery lists the subscription as cancelled with the deletion marker.
- When: Clerk delivers a signed `organization.deleted` webhook to `POST /api/webhooks/clerk`, then redelivers it.
- Then: The first delivery returns HTTP 503 `{ error: "Organization billing cleanup failed" }` after one cancellation and one credit note attempt, and billing status still shows a subscription. The redelivery returns HTTP 200 `OK`; there is still only one cancellation, and the second credit note refunds 500 cents against the invoice with idempotency key `org-delete-refund:<org>:<subscription>:in_delete_clerk:<deletion timestamp>`.
