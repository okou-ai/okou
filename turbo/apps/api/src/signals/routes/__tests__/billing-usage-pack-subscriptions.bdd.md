# billing-usage-pack-subscriptions

## billing-usage-pack-subscriptions-001

- Vitest: "legacy subscription usage pack migration > confirms a migration when an extra unpaid member joins after preview"
- Mode: run
- Given: A signed-in admin of a workspace on an active legacy Pro subscription (20,000 credits) has previewed a usage pack migration with a $20 pack for themselves, and an extra unpaid member joins the organization after the preview.
- When: The admin confirms with `POST /api/billing/usage-pack-migration/:migrationId/confirm` and then reads `GET /api/billing/usage-pack-migration`.
- Then: Confirmation returns HTTP 200 with status `scheduled`. The migration read returns `scheduled` with the same migration ID and a configuration containing only the admin's $20 pack. Billing status tier, credits and credit grants, and the usage pack credits listing, are unchanged from before the preview.

## billing-usage-pack-subscriptions-002

- Vitest: "legacy subscription usage pack migration > allows immediate Team purchase after canceling a Pro with a previewed migration"
- Mode: run
- Given: A signed-in admin of a workspace on an active legacy Pro subscription has previewed (not confirmed) a migration to Team with a $20 pack, and Stripe then reports the legacy subscription as canceled through a signed `customer.subscription.deleted` webhook.
- When: The admin reads the billing status and the migration, retries `POST /api/billing/usage-pack-migration/:migrationId/confirm`, buys a Team usage pack plan through `POST /api/billing/usage-pack-checkout`, and Stripe delivers the new subscription's `invoice.paid` webhook followed by a replay of the old deletion.
- Then: After the deletion the status shows `limited-free-1` without a subscription, the migration read returns HTTP 404 and confirmation returns HTTP 409. The checkout returns HTTP 200 with only the Stripe Checkout URL. After payment the status is `team`, `active`, `showUsagePack: true` with the new period end, the allocation is the admin's $20 pack, and credits include 20,000 purchased and 400 bonus. The late deletion replay leaves Team active, credits unchanged, and the migration read still 404.

## billing-usage-pack-subscriptions-003

- Vitest: "legacy subscription usage pack migration > allows immediate Team purchase after canceling a Pro with a scheduled migration"
- Mode: run
- Given: A signed-in admin of a workspace on an active legacy Pro subscription has previewed and confirmed (scheduled) a migration to Team with a $20 pack, and Stripe then reports the legacy subscription, still attached to the migration schedule, as canceled through a signed `customer.subscription.deleted` webhook.
- When: The admin reads the billing status and the migration, retries `POST /api/billing/usage-pack-migration/:migrationId/confirm`, buys a Team usage pack plan through `POST /api/billing/usage-pack-checkout`, and Stripe delivers the new subscription's `invoice.paid` webhook followed by a replay of the old deletion.
- Then: After the deletion the status shows `limited-free-1` without a subscription, the migration read returns HTTP 404 and confirmation returns HTTP 409. The checkout returns HTTP 200 with only the Stripe Checkout URL. After payment the status is `team`, `active`, `showUsagePack: true` with the new period end, the allocation is the admin's $20 pack, and credits include 20,000 purchased and 400 bonus. The late deletion replay leaves Team active, credits unchanged, and the migration read still 404.

## billing-usage-pack-subscriptions-004

- Vitest: "legacy subscription usage pack migration > retires a future conversion on read when its Stripe source is canceled"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Pro subscription has confirmed a scheduled usage pack migration, and Stripe now returns the source subscription with status `canceled`.
- When: The admin reads `GET /api/billing/usage-pack-migration`, retries `POST /api/billing/usage-pack-migration/:migrationId/confirm`, and reads the migration again.
- Then: Both reads return HTTP 404 and the confirmation returns HTTP 409 with error code `CONFLICT`.

## billing-usage-pack-subscriptions-005

- Vitest: "legacy subscription usage pack migration > retires a future conversion on read when its Stripe source is missing"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Pro subscription has confirmed a scheduled usage pack migration, and Stripe now answers the source subscription lookup with a `resource_missing` "No such subscription" error.
- When: The admin reads `GET /api/billing/usage-pack-migration`, retries `POST /api/billing/usage-pack-migration/:migrationId/confirm`, and reads the migration again.
- Then: Both reads return HTTP 404 and the confirmation returns HTTP 409 with error code `CONFLICT`.

## billing-usage-pack-subscriptions-006

- Vitest: "legacy subscription usage pack migration > retires a future conversion on read when its Stripe source is detached"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Pro subscription has confirmed a scheduled usage pack migration, and in Stripe the migration schedule is then canceled so the subscription is detached from it and the migration invoice is void.
- When: The admin reads `GET /api/billing/usage-pack-migration` and retries `POST /api/billing/usage-pack-migration/:migrationId/confirm`.
- Then: The read returns HTTP 404 and the confirmation returns HTTP 409 with error code `CONFLICT`.

## billing-usage-pack-subscriptions-007

- Vitest: "legacy subscription usage pack migration > allows a fresh conversion after its schedule is canceled"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Pro subscription has confirmed a scheduled usage pack migration, and Stripe then cancels the migration schedule.
- When: Stripe delivers a signed `subscription_schedule.canceled` webhook, the admin reads `GET /api/billing/usage-pack-migration`, and previews a new migration with `POST /api/billing/usage-pack-migration/preview`.
- Then: The read returns HTTP 200 with status `eligible` and `migrationId: null`. The new preview returns HTTP 200 with a migration ID different from the canceled one.

## billing-usage-pack-subscriptions-008

- Vitest: "legacy subscription usage pack migration > keeps a scheduled conversion when Stripe is temporarily unavailable"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Pro subscription has confirmed a scheduled usage pack migration, and the next Stripe subscription lookup fails with a connection error.
- When: The admin reads `GET /api/billing/usage-pack-migration` twice.
- Then: The first read returns HTTP 500. The second read returns HTTP 200 with status `scheduled` and the original migration ID.

## billing-usage-pack-subscriptions-009

- Vitest: "legacy subscription usage pack migration > refunds only a pending invitation's share of a migration payment"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Team subscription with one pending invitation has confirmed a migration with $20 packs for the admin and the invitation, and Stripe has started the scheduled phase and paid the $200 migration invoice. Stripe accepts refunds.
- When: Stripe delivers the paid migration invoice webhook and the admin revokes the invitation with `DELETE /api/org/invite`.
- Then: The migration confirmation returns `scheduled`, and the allocations include the admin's $20 pack. The revoke returns HTTP 200. Stripe receives a refund of 2,000 cents on the migration payment intent, and the subscription schedule is last updated with phases that keep the $20 usage pack price at quantity 1.

## billing-usage-pack-subscriptions-010

- Vitest: "legacy subscription usage pack migration > finishes a zero-amount Team conversion and invitation lifecycle"
- Mode: run
- Given: A signed-in admin of a workspace on a legacy Team subscription with one pending invitation has confirmed a migration with $20 packs for the admin and the invitation, and the scheduled migration invoice is for $0.
- When: Stripe starts the phase and delivers `subscription_schedule.completed`, the admin reads `GET /api/billing/usage-pack-migration`, Stripe delivers the paid invoice webhook twice, and the admin revokes the invitation with `DELETE /api/org/invite`.
- Then: Confirmation returns `scheduled`, and after schedule completion the migration is still `scheduled` with the same ID while awaiting the invoice. After the invoice the allocations include the admin's $20 pack, and the replayed invoice leaves allocations and credits unchanged. The revoke returns HTTP 200 with "Invitation revoked and refund initiated", one allocation remains, no Stripe refund is created, and the schedule is last updated with the $20 usage pack price at quantity 1.

## billing-usage-pack-subscriptions-011

- Vitest: "usage pack allocation management > keeps management allocations isolated across successive organization requests"
- Mode: run
- Given: Two workspaces each bought a usage pack plan through checkout and a paid invoice: workspace A on Pro with a $20 pack for its admin, workspace B on Team with a $50 pack for its admin.
- When: Each admin reads `GET /api/billing/usage-pack-subscription` in the order A, B, A.
- Then: Every read returns HTTP 200 with that workspace's own tier and exactly one allocation for its own admin ($20 for A, $50 for B) with no pending change.

## billing-usage-pack-subscriptions-012

- Vitest: "usage pack allocation management > records a card collected for a usage pack purchase setup"
- Mode: run
- Given: A workspace on a Pro usage pack plan with a Stripe customer and subscription.
- When: Stripe delivers a signed `checkout.session.completed` webhook for a setup-mode session with purpose `billing_purchase`, the workspace and subscription IDs, and a setup intent carrying a payment method.
- Then: The webhook returns HTTP 200 and the Stripe customer is updated to use that payment method as the default invoice payment method.

## billing-usage-pack-subscriptions-013

- Vitest: "usage pack allocation management > routes a concurrency-only invoice on the Plan subscription"
- Mode: run
- Given: A workspace on a Team usage pack plan with a $20 pack, and the Stripe subscription now also carries 10 concurrency units.
- When: Stripe delivers a signed `invoice.paid` webhook whose only line is a prorated concurrency line for quantity 10.
- Then: `GET /api/billing/status` lists one concurrency subscription with the Plan subscription ID, quantity 10 and the current period end. The purchased credit grants are unchanged.

## billing-usage-pack-subscriptions-014

- Vitest: "usage pack allocation management > idempotently processes usage pack and concurrency from one renewal invoice"
- Mode: run
- Given: A workspace on a Team usage pack plan with a $20 pack for its admin, the clock is just after the period renewal, and the Stripe subscription carries the $20 pack and 6 concurrency units for the renewal period.
- When: Stripe delivers one signed renewal `invoice.paid` webhook containing both the usage pack line and a concurrency line for quantity 6, and then replays the same invoice.
- Then: After the first delivery there are exactly two credit grants for the admin (20,000 purchased and 400 bonus, fully remaining, expiring at the renewal period end), the allocation shows $20 with the new period end and no pending change, and billing status lists the concurrency subscription with quantity 6 and the renewal period end. The replay leaves the grants and concurrency subscriptions unchanged.

## billing-usage-pack-subscriptions-015

- Vitest: "usage pack allocation management > previews a member Usage Pack change from 20 to 50 with a neutral schedule"
- Mode: run
- Given: A workspace on a Pro usage pack plan where two members each hold a $20 pack. The Stripe subscription is attached to a schedule with a current and a next phase and a discount, and Stripe prices the change at 1,500 cents now and 8,000 cents recurring.
- When: The admin previews a change for one member to a $50 pack with `POST /api/billing/usage-pack-subscription/changes/preview`.
- Then: The response returns HTTP 200 with kind `upgrade`, source 20, target 50, immediate amount 1,500 cents, next recurring amount 8,000 cents and currency `usd`. Stripe receives a recurring invoice preview with the discount and items for the plan, one $20 and one $50 pack. No subscription update, schedule release or schedule update is sent to Stripe.

## billing-usage-pack-subscriptions-016

- Vitest: "usage pack allocation management > previews a member Usage Pack change from 50 to 20 with a neutral schedule"
- Mode: run
- Given: A workspace on a Pro usage pack plan where two members each hold a $50 pack. The Stripe subscription is attached to a schedule with a current and a next phase and a discount, and Stripe prices the change at 1,500 cents now and 8,000 cents recurring.
- When: The admin previews a change for one member to a $20 pack with `POST /api/billing/usage-pack-subscription/changes/preview`.
- Then: The response returns HTTP 200 with kind `downgrade`, source 50, target 20, immediate amount 0 cents, next recurring amount 8,000 cents and currency `usd`. Stripe receives a recurring invoice preview with the discount and items for the plan, one $50 and one $20 pack. No subscription update, schedule release or schedule update is sent to Stripe.

## billing-usage-pack-subscriptions-017

- Vitest: "usage pack allocation management > replaces an expired member quote with one competing preview and rejects the old quote"
- Mode: run
- Given: The clock is 2035-01-16. A workspace on a Pro usage pack plan where the admin's member holds a $20 pack, and Stripe prices changes at 1,500 cents now and 5,000 cents recurring. The admin has an original $50 change quote.
- When: The admin requests a $100 preview with `POST /api/billing/usage-pack-subscription/changes/preview` one millisecond before the quote expires, then at expiry sends competing $50 and $100 previews whose Stripe pricing completes together, replays the winning preview, and finally confirms the original quote with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`.
- Then: The pre-expiry preview returns HTTP 409. Of the two competing previews exactly one returns HTTP 200 and the other HTTP 409; the winner has a new change ID and expires 15 minutes after the original expiry, and the replay returns an identical body. Confirming the original quote returns HTTP 409, and the member's allocation stays at $20 with no pending change.

## billing-usage-pack-subscriptions-018

- Vitest: "usage pack allocation management > rejects a prepared member quote when subscription changes during Stripe pricing"
- Mode: run
- Given: A workspace on a Pro usage pack plan where a member holds a $20 pack. While Stripe is pricing the member change, the Plan subscription is set to cancel at period end and Stripe delivers a signed `customer.subscription.updated` webhook.
- When: The admin previews a $50 change for the member with `POST /api/billing/usage-pack-subscription/changes/preview`.
- Then: The preview returns HTTP 409 with message "Another usage pack billing change is in progress", and the member's allocation stays at $20 with no pending change.

## billing-usage-pack-subscriptions-019

- Vitest: "usage pack allocation management > rejects a prepared member quote when a Plan quote is published during Stripe pricing"
- Mode: run
- Given: A workspace on a Pro usage pack plan where a member holds a $20 pack. While Stripe is pricing the member change, the admin publishes a Plan change quote to Team through `POST /api/billing/usage-pack-subscription/subscription-change/preview`, which returns HTTP 200 with target tier `team`.
- When: The admin previews a $50 change for the member with `POST /api/billing/usage-pack-subscription/changes/preview`.
- Then: The member preview returns HTTP 409 with message "Another usage pack billing change is in progress", and the member's allocation stays at $20 with no pending change.

## billing-usage-pack-subscriptions-020

- Vitest: "usage pack allocation management > rejects an allocation downgrade when the Plan starts ending after preview"
- Mode: run
- Given: A workspace on a Team usage pack plan where a member holds a $50 pack, and the admin has previewed a downgrade to $20 for that member. After the preview, Stripe reports the Plan subscription as canceling at period end.
- When: The admin confirms the change with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`.
- Then: The confirmation returns HTTP 409 with message "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.", and the allocation stays at $50 with no pending change.

## billing-usage-pack-subscriptions-021

- Vitest: "usage pack allocation management > continues through a Stripe schedule with no future billing changes"
- Mode: run
- Given: A workspace on a Pro usage pack plan where a member holds a $20 pack, and the Stripe subscription is attached to a release-at-end schedule whose next phase repeats the same items (no future billing change). Stripe prices the Plan change at 8,000 cents now and 16,000 cents recurring, and accepts the schedule release and subscription update.
- When: The admin previews a change to Team with `POST /api/billing/usage-pack-subscription/subscription-change/preview` and confirms it with `POST /api/billing/usage-pack-subscription/subscription-change/confirm`.
- Then: The preview returns HTTP 200 and Stripe receives a recurring invoice preview with the Team plan and the $20 pack. The confirmation returns HTTP 200 with status `processing`; Stripe releases the schedule and receives exactly one subscription update.

## billing-usage-pack-subscriptions-022

- Vitest: "usage pack allocation management > replaces an unconfirmed package change preview"
- Mode: run
- Given: The clock is 2035-01-16. A workspace on a Pro usage pack plan where a member holds a $20 pack, and Stripe prices a change to $50 at 1,500 cents now and 5,000 cents recurring.
- When: The admin previews a Pro Plan change with the member at $50 through `POST /api/billing/usage-pack-subscription/subscription-change/preview`, reads `GET /api/billing/usage-pack-subscription`, and repeats the same preview.
- Then: The first preview returns HTTP 200 with an immediate credit grant of 15,000 purchased, 1,100 bonus and 16,100 total credits expiring at the period end. The management read shows no pending change for the member. The second preview returns HTTP 200 with a different change ID, and Stripe has received four invoice previews in total.

## billing-usage-pack-subscriptions-023

- Vitest: "usage pack allocation management > upgrades the base plan in place without replacing the member package"
- Mode: run
- Given: A workspace on a Pro usage pack plan where a member holds a $20 pack. Stripe prices a Team Plan change at 8,000 cents now and 18,000 cents recurring, and applies the update in place.
- When: The admin previews the Team change with `POST /api/billing/usage-pack-subscription/subscription-change/preview`, confirms it with `POST /api/billing/usage-pack-subscription/subscription-change/confirm`, and Stripe delivers the paid upgrade invoice webhook.
- Then: The preview returns source `pro`, target `team`, 8,000 cents immediate, 18,000 cents recurring in `usd`, and both Stripe previews target the existing subscription replacing only the plan item with the Team plan. The confirmation returns HTTP 200 with exactly `processing`, the preview's proration date as `effectiveAt`, and no hosted invoice URL. Stripe receives one in-place update of the plan item with `pending_if_incomplete`, `always_invoice`, the proration date and an idempotency key, and no Checkout session is created. After the invoice the tier is `team`, the member keeps the $20 pack with no pending change, the purchased credit grants are unchanged, and the management read shows tier `team`.

## billing-usage-pack-subscriptions-024

- Vitest: "usage pack allocation management > activates a pending plan upgrade from the paid invoice webhook"
- Mode: run
- Given: A workspace on a Pro usage pack plan where a member holds a $20 pack. Stripe accepts the Team Plan change as a pending update with an open upgrade invoice that requires payment.
- When: The admin previews and confirms the Team change through `POST /api/billing/usage-pack-subscription/subscription-change/preview` and `.../subscription-change/confirm`, Stripe delivers `customer.subscription.updated` for the pending update, and then delivers the paid upgrade invoice twice concurrently and once more.
- Then: The confirmation returns exactly `pending_payment` with the preview's proration date and the invoice's hosted URL. While the update is pending the tier stays `pro`. After the paid invoice deliveries the tier is `team`, the member keeps the $20 pack with no pending change, and purchased credit grants are unchanged.

## billing-usage-pack-subscriptions-025

- Vitest: "usage pack allocation management > adds an active member package to the existing subscription"
- Mode: run
- Given: The clock is 2035-01-16. A workspace on a Pro usage pack plan where the admin holds a $20 pack, and a newly added member without a package joins. Stripe prices adding a $50 pack at 2,500 cents now and 7,000 cents recurring, and applies it as a pending update with an open invoice.
- When: The admin reads `GET /api/billing/usage-pack-subscription`, previews and confirms a Pro change giving the new member a $50 pack via `POST /api/billing/usage-pack-subscription/subscription-change/preview` and `.../confirm`, Stripe delivers the paid addition invoice, and the admin reads `GET /api/billing/usage-pack-credits`.
- Then: The management read reports `supportsMemberAdditions` as true. The preview returns 2,500 cents immediate, 7,000 cents recurring and an immediate grant of 25,000 purchased, 1,300 bonus and 26,300 total credits expiring at the period end. Confirmation returns `pending_payment`, and Stripe receives a subscription update adding one $50 pack with `pending_if_incomplete`, `always_invoice`, the proration date and idempotency key `usage-pack-subscription-change:<changeId>:apply`. After payment the allocations include the admin at $20 and the new member at $50, and the new member's credits include 25,000 purchased and 1,300 bonus.

## billing-usage-pack-subscriptions-026

- Vitest: "usage pack allocation management > restores a scheduled package downgrade with billing-only phase metadata"
- Mode: run
- Given: A workspace on a Pro usage pack plan where a member holds a $50 pack, and the admin has confirmed a downgrade to $20 that Stripe holds in a schedule whose phases carry marketing attribution metadata (click IDs, campaign and privacy fields) alongside `orgId` and `billingPurchaseId`.
- When: The admin previews and confirms restoring the member to $50 via `POST /api/billing/usage-pack-subscription/subscription-change/preview` and `.../confirm`, reads `GET /api/billing/usage-pack-subscription`, and then previews a further change to $100.
- Then: The downgrade confirmation returns `scheduled`. The restore preview returns source and target `pro`, 0 cents immediate and 5,000 cents recurring, priced from a recurring preview of the plan and $50 pack. The restore confirmation returns exactly `completed` with an effective time and no hosted invoice URL. Stripe receives one schedule update (idempotency key `...:restore-schedule`) with `release` end behavior, no proration, and both phases holding the plan and $50 pack with phase metadata reduced to `orgId` and `billingPurchaseId`; the schedule is not released. The member shows $50 with no pending change, and the $100 preview returns 10,000 cents recurring.

## billing-usage-pack-subscriptions-027

- Vitest: "usage pack allocation management > clears scheduled package changes after schedule restore"
- Mode: run
- Given: A workspace on a Team usage pack plan where a member holds a $100 pack, and the admin has confirmed a deferred change to Pro with a $20 pack that Stripe holds in a schedule. The Stripe subscription has a default payment method and Stripe accepts releasing the schedule.
- When: The admin restores the plan with `POST /api/billing/restore`, then previews a Team change to a $200 pack with `POST /api/billing/usage-pack-subscription/subscription-change/preview`.
- Then: The downgrade confirmation returns `scheduled` and billing status shows a scheduled change to `pro`. The restore returns HTTP 200 with exactly `{ status: "restored" }` and Stripe releases the schedule. Billing status then has no scheduled change and is not canceling at period end, the member shows $100 with no pending change, and the new preview returns HTTP 200.

## billing-usage-pack-subscriptions-028

- Vitest: "usage pack allocation management > clears scheduled package changes after schedule release"
- Mode: run
- Given: A workspace on a Team usage pack plan where a member holds a $100 pack, and the admin has confirmed a deferred change to Pro with a $20 pack that Stripe holds in a schedule.
- When: Stripe delivers a signed `subscription_schedule.released` webhook for that schedule, and the admin then previews a Team change to a $200 pack with `POST /api/billing/usage-pack-subscription/subscription-change/preview`.
- Then: The downgrade confirmation returns `scheduled` and billing status shows a scheduled change to `pro`. After the release billing status has no scheduled change and is not canceling at period end, the member shows $100 with no pending change, and the new preview returns HTTP 200.

## billing-usage-pack-subscriptions-029

- Vitest: "usage pack allocation management > completes local deferred schedule state after a lost Stripe response at 2035-01-17T00:00:00.000Z"
- Mode: run
- Given: The clock is 2035-01-17T00:00:00.000Z. A Team workspace with a $20 pack has confirmed a change to Pro with a $50 pack, whose next phase ends 2035-03-01T00:00:00.000Z. Stripe applies the deferred schedule update for the paid upgrade invoice but its response is lost once.
- When: Stripe delivers the paid upgrade `invoice.paid` webhook, then redelivers it, and the admin confirms the change again with `POST /api/billing/usage-pack-subscription/subscription-change/confirm`.
- Then: The first delivery fails with HTTP 500. The redelivery succeeds, Stripe receives the schedule update exactly once in total, and the workspace's credit grants are the same as after the failed delivery. The repeated confirmation returns HTTP 200 with status `scheduled`.

## billing-usage-pack-subscriptions-030

- Vitest: "usage pack allocation management > does not resurrect a restored deferred schedule when an old invoice is delivered"
- Mode: run
- Given: The clock is 2035-01-17. A Team workspace with a $20 pack has confirmed a change to Pro with a $50 pack, the paid upgrade invoice has been processed so Stripe holds the deferred schedule, and the customer has a default payment method.
- When: The admin restores the plan with `POST /api/billing/restore`, Stripe reports the subscription without a schedule, and Stripe redelivers the old paid upgrade invoice webhook.
- Then: The restore returns HTTP 200. After the redelivery the purchased credit grants and the usage pack management view are unchanged from right after the restore, Stripe has created the schedule once and updated it once in total, and `GET /api/billing/status` shows no scheduled change.

## billing-usage-pack-subscriptions-031

- Vitest: "usage pack allocation management > revises a pending Team to Pro schedule when the package total increases from $20 to $40"
- Mode: run
- Given: A workspace on a Team usage pack plan where the admin holds a $20 pack. Stripe prices a deferred Team-to-Pro change with no immediate charge and creates and updates a schedule. After that change is scheduled, a new member joins, and Stripe prices adding a second $20 pack at 2,500 cents now and 4,000 cents recurring as a pending update.
- When: The admin previews and confirms the Pro change through `POST /api/billing/usage-pack-subscription/subscription-change/preview` and `.../confirm`, then previews and confirms a Pro change giving the new member a $20 pack too, Stripe delivers the paid addition invoice, and the admin reads `GET /api/billing/usage-pack-subscription`.
- Then: The first preview returns team to pro, 0 cents immediate, 2,000 cents recurring, effective at the period end, and its confirmation returns exactly `scheduled` with that time and no invoice URL; Stripe gets no subscription update but a schedule update whose next phase has the Pro plan and one $20 pack. Tier stays `team` with the admin's $20 allocation. The second preview returns 2,500 cents immediate and 4,000 cents recurring with the same effective time, and confirmation returns `pending_payment` after a subscription update setting the $20 pack quantity to 2 (idempotency key `...:apply`). After payment the schedule is last updated with $20 pack quantity 2 in both phases, and the management read shows tier `team` with both members at $20 and no pending changes.

## billing-usage-pack-subscriptions-032

- Vitest: "usage pack allocation management > settles a paid upgrade and its subscription deletion in exactly one order"
- Mode: run
- Given: The clock is 2035-01-17. A Pro workspace's member upgrade from a $20 to a $50 pack is confirmed as `pending_payment` with a 1,500-cent invoice, and Stripe now reports the subscription as canceled. Stripe accepts credit notes.
- When: Stripe delivers the paid upgrade `invoice.paid` webhook and `customer.subscription.deleted` concurrently, and then redelivers each once.
- Then: The purchased credit grants are unchanged from before the deliveries. Stripe receives exactly one credit note for the paid invoice with amount and refund amount 1,500 and idempotency key `usage-pack-change:<changeId>:<invoiceId>:canceled-refund`.

## billing-usage-pack-subscriptions-033

- Vitest: "usage pack allocation management > fulfills a paid upgrade once without a refund before its subscription deletion"
- Mode: run
- Given: The clock is 2035-01-17. A Pro workspace's member upgrade from a $20 to a $50 pack is confirmed as `pending_payment` with a 1,500-cent invoice, and Stripe reports the subscription with the $50 pack.
- When: Stripe delivers the paid upgrade `invoice.paid` webhook, then `customer.subscription.deleted` for the canceled subscription, then redelivers the paid invoice.
- Then: The purchased credit grants contain exactly four grants, including exactly one 15,000-credit grant and a 1,100-credit bonus grant with 1,100 remaining. No Stripe credit note is created.

## billing-usage-pack-subscriptions-034

- Vitest: "usage pack allocation management > completes an immediately paid upgrade during confirmation"
- Mode: run
- Given: The clock is 2035-01-20. A workspace on a Pro usage pack plan where a member holds a $20 pack, and the Stripe subscription has a saved default payment method. Stripe prices a $50 upgrade at 1,500 cents now and 5,000 cents recurring and pays the upgrade invoice immediately.
- When: The admin previews a $50 change with in-app preview support and a return URL via `POST /api/billing/usage-pack-subscription/changes/preview`, then confirms with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm` passing the returned `paymentMethodPreviewToken`.
- Then: The preview returns a payment-method preview token, and confirmation returns HTTP 200 with status `completed`. Stripe first sets the subscription's default payment method to the saved card, then applies the change with `pending_if_incomplete`, `always_invoice`, the proration date and idempotency key `usage-pack-change:<changeId>:apply`. The member shows $50 with no pending change, and there are four purchased credit grants.

## billing-usage-pack-subscriptions-035

- Vitest: "usage pack allocation management > invites members from a Limited Free workspace without billing"
- Mode: run
- Given: A signed-in admin of a Limited Free workspace whose billing status is `active` without the usage pack offer. Clerk accepts the invitation.
- When: The admin invites `limited-free-1@example.test` as a member with `POST /api/org/invite`.
- Then: The invite returns HTTP 200 with a message containing the invited email, and no Stripe Checkout session is created.

## billing-usage-pack-subscriptions-036

- Vitest: "usage pack allocation management > keeps member downgrades scheduled until the boundary and publishes aggregate quantities (existing schedule: false)"
- Mode: run
- Given: The clock is 2035-03-16. A workspace on a Pro usage pack plan where two members each hold a $50 pack, and the Stripe subscription has no existing schedule (Stripe creates one split at a mid-period phase start). Stripe prices member downgrades with no immediate charge.
- When: The admin previews and confirms a $20 downgrade for each member in turn via `POST /api/billing/usage-pack-subscription/changes/preview` and `.../changes/:changeId/confirm`, and Stripe then delivers `customer.subscription.updated` twice at the period boundary with two $20 packs.
- Then: Both confirmations return `scheduled`. Stripe's schedule update for the first change has a phase starting at the period end with one $20 and one $50 pack; the update for the second keeps the current phase ending at the period end and adds a one-month phase from the period end with two $20 packs, each with idempotency key `usage-pack-change:<changeId>:schedule-update`. Before the boundary both members show $50 with their scheduled pending change, and there are four purchased credit grants. After the boundary both members show $20 with no pending change; the replayed update leaves management and credit grants unchanged.

## billing-usage-pack-subscriptions-037

- Vitest: "usage pack allocation management > keeps member downgrades scheduled until the boundary and publishes aggregate quantities (existing schedule: true)"
- Mode: run
- Given: The clock is 2035-03-16. A workspace on a Pro usage pack plan where two members each hold a $50 pack, and the Stripe subscription is already attached to a schedule that also has a next-period phase. Stripe prices member downgrades with no immediate charge.
- When: The admin previews and confirms a $20 downgrade for each member in turn via `POST /api/billing/usage-pack-subscription/changes/preview` and `.../changes/:changeId/confirm`, and Stripe then delivers `customer.subscription.updated` twice at the period boundary with two $20 packs.
- Then: Both confirmations return `scheduled`. Stripe's schedule update for the first change has a phase starting at the period end with one $20 and one $50 pack; the update for the second keeps the current phase ending at the period end and sets the existing next phase (ending 31 days after the period end) to two $20 packs, each with idempotency key `usage-pack-change:<changeId>:schedule-update`. Before the boundary both members show $50 with their scheduled pending change, and there are four purchased credit grants. After the boundary both members show $20 with no pending change; the replayed update leaves management and credit grants unchanged.

## billing-usage-pack-subscriptions-038

- Vitest: "usage pack allocation management > adds concurrency without replacing a scheduled usage pack downgrade"
- Mode: run
- Given: The clock is 2035-03-16. A workspace on a Team usage pack plan where the admin holds a $100 pack has a confirmed (`scheduled`) downgrade to $20 held in a Stripe schedule. Stripe prices 3 concurrency units at 15,000 cents now and 30,000 cents recurring, and finalizes and pays the resulting draft invoice.
- When: The admin previews 3 concurrency units with `POST /api/billing/concurrency-checkout/preview`, buys them with `POST /api/billing/concurrency-checkout`, and Stripe delivers the paid concurrency invoice webhook.
- Then: The preview returns exactly current 0, target 3, 15,000 cents immediate, 30,000 cents recurring, `usd`, and the purchase returns exactly the success URL. Stripe previews and then updates the schedule (`always_invoice`, idempotency key `concurrency-change:...:schedule-update`) with both phases keeping their packages ($100 now, $20 next) and adding 3 concurrency units; the schedule is not released and the subscription is not updated directly. Stripe finalizes and pays the invoice with `concurrency-change:<subscriptionId>:<invoiceId>:finalize` and `:pay` keys. Billing status then lists the concurrency subscription with quantity 3.

## billing-usage-pack-subscriptions-039

- Vitest: "usage pack allocation management > refunds the invoice when the removed member owns the last package"
- Mode: run
- Given: The clock is 2035-04-20. A workspace on a Pro usage pack plan where the only package ($20) belongs to a member other than the admin, and the member's paid package invoice can be refunded for 2,000 cents through Stripe (credit note preview, refund and credit note succeed). Clerk accepts removing the membership.
- When: The admin removes that member by email with `DELETE /api/org/members`.
- Then: The removal returns HTTP 200. Stripe sets the subscription to cancel at period end and creates no schedule. The removed member has no purchased credit grants left. Stripe receives a 2,000-cent refund on the invoice payment intent and a credit note for one invoice line of 2,000 cents linked to that refund, with idempotency keys matching `usage-pack-credit-refund:<id>:1:refund` and `...:1:credit-note`. Billing status reports `cancelAtPeriodEnd` as true.

## billing-usage-pack-subscriptions-040

- Vitest: "usage pack allocation management > invites members without purchasing a package on managed pro plans"
- Mode: run
- Given: A workspace on a managed Pro usage pack plan with one $20 pack, whose billing status shows the usage pack offer. Clerk accepts the invitation.
- When: The admin invites `paid@example.test` as a member with `POST /api/org/invite`.
- Then: The invite returns HTTP 200 with a message containing the email, and Clerk receives an organization invitation for that workspace, email and role `org:member`.

## billing-usage-pack-subscriptions-041

- Vitest: "usage pack allocation management > invites members without purchasing a package on managed team plans"
- Mode: run
- Given: A workspace on a managed Team usage pack plan with one $20 pack, whose billing status shows the usage pack offer. Clerk accepts the invitation.
- When: The admin invites `paid@example.test` as a member with `POST /api/org/invite`.
- Then: The invite returns HTTP 200 with a message containing the email, and Clerk receives an organization invitation for that workspace, email and role `org:member`.

## billing-usage-pack-subscriptions-042

- Vitest: "usage pack allocation management > keeps legacy pro invitation entitlements package-free"
- Mode: run
- Given: A workspace on a legacy Pro subscription whose billing status does not show the usage pack offer. Clerk accepts the invitation.
- When: The admin invites `legacy-pro@example.test` as a member with `POST /api/org/invite`.
- Then: The invite returns HTTP 200 with a message containing `legacy-pro@example.test`.

## billing-usage-pack-subscriptions-043

- Vitest: "usage pack allocation management > keeps legacy team invitation entitlements package-free"
- Mode: run
- Given: A workspace on a legacy Team subscription whose billing status does not show the usage pack offer. Clerk accepts the invitation.
- When: The admin invites `legacy-team@example.test` as a member with `POST /api/org/invite`.
- Then: The invite returns HTTP 200 with a message containing `legacy-team@example.test`.

## billing-usage-pack-subscriptions-044

- Vitest: "usage pack allocation management > keeps invitation credits time-based with exclusive tax > previews and persists time-based invitation credits"
- Mode: run
- Given: The clock is 2035-05-15, mid-period. A workspace on a Pro usage pack plan with one member holding a $20 pack. Stripe prices the invitation's added package as a 1,000-cent prorated line (subtotal 1,000) with 100 cents of exclusive tax.
- When: The admin previews a paid invitation with a $20 pack via `POST /api/org/invite/purchase/preview` and then repeats the same preview.
- Then: The first preview returns exactly a purchase ID, $20, 1,100 cents immediate in `usd`, 10,000 purchased, 200 bonus and 10,200 total credits, the current period end and an expiry. The repeated preview returns the identical body without calling Stripe again.

## billing-usage-pack-subscriptions-045

- Vitest: "usage pack allocation management > keeps invitation credits time-based with discount > previews and persists time-based invitation credits"
- Mode: run
- Given: The clock is 2035-05-15, mid-period. A workspace on a Pro usage pack plan with one member holding a $20 pack. Stripe prices the invitation's added package as a discounted 800-cent prorated line (subtotal 1,000) without tax.
- When: The admin previews a paid invitation with a $20 pack via `POST /api/org/invite/purchase/preview` and then repeats the same preview.
- Then: The first preview returns exactly a purchase ID, $20, 800 cents immediate in `usd`, 10,000 purchased, 200 bonus and 10,200 total credits, the current period end and an expiry. The repeated preview returns the identical body without calling Stripe again.

## billing-usage-pack-subscriptions-046

- Vitest: "usage pack allocation management > keeps invitation credits time-based with discount and exclusive tax > previews and persists time-based invitation credits"
- Mode: run
- Given: The clock is 2035-05-15, mid-period. A workspace on a Pro usage pack plan with one member holding a $20 pack. Stripe prices the invitation's added package as a discounted 800-cent prorated line (subtotal 1,000) with 80 cents of exclusive tax.
- When: The admin previews a paid invitation with a $20 pack via `POST /api/org/invite/purchase/preview` and then repeats the same preview.
- Then: The first preview returns exactly a purchase ID, $20, 880 cents immediate in `usd`, 10,000 purchased, 200 bonus and 10,200 total credits, the current period end and an expiry. The repeated preview returns the identical body without calling Stripe again.

## billing-usage-pack-subscriptions-047

- Vitest: "usage pack allocation management > finds an invitation proration line across every preview page"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan with one member holding a $20 pack. Stripe returns the invitation price preview with paginated lines: the first page has only an unrelated renewal line, and the second page has the 1,000-cent prorated line for the added package.
- When: The admin previews a paid invitation with a $20 pack via `POST /api/org/invite/purchase/preview`.
- Then: The preview returns HTTP 200 with 1,000 cents immediate, 10,000 purchased and 200 bonus credits. Stripe's preview line items are listed twice: first with limit 100, then with limit 100 starting after the unrelated line.

## billing-usage-pack-subscriptions-048

- Vitest: "usage pack allocation management > prices an invitation from only the added package proration"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan with one member holding a $20 pack and no pending invitations. Stripe's preview for raising the $20 pack quantity to 2 returns a 4,000-cent renewal line, a -2,000-cent proration credit and a 4,000-cent proration charge.
- When: The admin previews a paid invitation with a $20 pack via `POST /api/org/invite/purchase/preview`.
- Then: Stripe is asked to preview the $20 pack item at quantity 2. The response returns exactly a purchase ID, $20, 2,000 cents immediate in `usd`, 10,000 purchased, 200 bonus and 10,200 total credits, the current period end and an expiry.

## billing-usage-pack-subscriptions-049

- Vitest: "usage pack allocation management > includes the invitation purchase timestamp when confirming later"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan with one member holding a $20 pack, a saved default payment method, and Stripe automatic tax. Stripe prices the invitation as a -2,000-cent credit plus a discounted 2,800-cent charge with exclusive tax, and creates, finalizes and attempts payment of an invoice that stays open.
- When: The admin previews a paid invitation with a $20 pack via `POST /api/org/invite/purchase/preview`, the clock advances one minute, and the admin confirms with `POST /api/org/invite/purchase/:purchaseId/confirm`.
- Then: The preview returns 880 cents immediate, 10,000 purchased and 200 bonus credits. Confirmation returns exactly `pending_payment` with the hosted invoice URL. Stripe creates the invoice for the customer with `auto_advance: false`, the saved payment method, invitation purchase metadata plus `purchaseCreatedAt`, no discounts and self-liability automatic tax (idempotency key `usage-pack-invitation:<purchaseId>:invoice`), and an invoice item of 800 cents `usd` described as "Member usage pack for <email>", non-discountable, ending at the period end, on the subscription, with exclusive tax behavior and tax code `txcd_10000000` (key `...:invoice-item`).

## billing-usage-pack-subscriptions-050

- Vitest: "usage pack allocation management > resumes invitation creation on a later request after a post-payment Clerk rate limit"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan with one member holding a $20 pack has a previewed paid invitation (1,000 cents) and a saved card that Stripe charges successfully. During the first confirmation, Clerk's membership list answers once and then rate-limits with a 9-second retry.
- When: The admin confirms with `POST /api/org/invite/purchase/:purchaseId/confirm`, and after Clerk recovers confirms the same purchase again.
- Then: The first confirmation returns HTTP 503 with `Retry-After: 9` and `Cache-Control: no-store`, after two membership reads, without waiting in-process; Stripe has created and paid one invoice and no Clerk invitation exists. The second confirmation returns HTTP 200 with "Invitation purchased and sent"; Stripe still has exactly one invoice creation and one payment, and Clerk creates the invitation once.

## billing-usage-pack-subscriptions-051

- Vitest: "usage pack allocation management > confirms an invitation with the signed payment preview and the same saved card"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan with one member holding a $20 pack and a saved default card. Stripe prices the invitation at 1,000 cents, and creates, finalizes and pays the invoice. Clerk accepts the invitation.
- When: The admin previews a paid invitation with in-app preview support via `POST /api/org/invite/purchase/preview`, then confirms with `POST /api/org/invite/purchase/:purchaseId/confirm` passing the returned `paymentMethodPreviewToken`.
- Then: The preview returns exactly a purchase ID, $20, 1,000 cents in `usd`, 10,000 purchased, 200 bonus and 10,200 total credits, the period end, an expiry and a non-empty payment-method preview token, without creating an invoice or invitation. The confirmation returns exactly `{ message: "Invitation purchased and sent" }`. Stripe creates one invoice for the customer with the saved card and the invitation purchase metadata, and Clerk creates a member invitation for that workspace and email carrying the purchase ID in private metadata.

## billing-usage-pack-subscriptions-052

- Vitest: "usage pack allocation management > grants invitation credits once across concurrent payment and acceptance deliveries"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Team usage pack plan with the admin's $20 pack has a previewed $20 paid invitation.
- When: Stripe delivers the invitation's `payment_intent.succeeded` webhook twice concurrently, Clerk then delivers `organizationInvitation.accepted` for the new user twice concurrently and once more, and the admin reads `GET /api/billing/usage-pack-credits` after each stage.
- Then: After payment the credits view is unchanged and has no entry for the invited user; Clerk creates the invitation once and Stripe's subscription is not updated. After acceptance the invited user has exactly one entry with the previewed purchased, bonus and total credits, the admin's own credits view reports `hasUsagePack` with 20,000 purchased, 400 bonus and 20,400 total credits, the replayed acceptance leaves the view unchanged, and Stripe's subscription is updated exactly once.

## billing-usage-pack-subscriptions-053

- Vitest: "usage pack allocation management > refunds a paid invitation accepted at period end once across webhook replay"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Team usage pack plan with the admin's $20 pack has a previewed $20 paid invitation whose 1,000-cent payment succeeded (signed `payment_intent.succeeded`), and Stripe accepts refunds. The clock then reaches the period end.
- When: Clerk delivers `organizationInvitation.accepted` for the new user twice, the admin retries `POST /api/org/invite/purchase/:purchaseId/confirm`, and the new member reads `GET /api/billing/usage-pack-credits`.
- Then: Stripe receives exactly one refund of 1,000 cents on the invitation payment intent with invitation purchase metadata and idempotency key `usage-pack-invitation:<purchaseId>:refund:1`, and the subscription is not updated. The confirmation returns HTTP 409 with code `INVITATION_PURCHASE_INACTIVE`. The new member's credits are exactly zero total, purchased and bonus, `hasUsagePack: false` and no grants.

## billing-usage-pack-subscriptions-054

- Vitest: "usage pack allocation management > refunds a partially consumed invitation package when Clerk removes the member"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan has a $20 paid invitation confirmed with a saved card (invoice tagged with the purchase ID), accepted by the new member, who then consumes 5,000 credits through normal usage. The subscription now has two $20 packs. Stripe's first member-removal refund attempt reports `failed` and the second `succeeded`.
- When: Clerk delivers a signed `organizationMembership.deleted` webhook for the new member three times.
- Then: The invitation confirmation returned "Invitation purchased and sent", and before removal the member had a 200-credit bonus grant fully remaining and a 10,000-credit purchased grant with 5,000 remaining. Every delivery returns HTTP 200. Afterwards the member has no credit grants and no allocation. Stripe receives exactly two 500-cent refunds on the invitation payment intent with idempotency keys ending `:1` and `:2`, and the subscription is updated to one $20 pack with no proration under a `member-removal` idempotency key.

## billing-usage-pack-subscriptions-055

- Vitest: "usage pack allocation management > finishes a pending allocation payment before activating a paid invitation"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Team usage pack plan with the admin's $20 pack has a $20 paid invitation whose payment succeeded. The admin has previewed a member allocation change for themselves from $20 to $50 (1,500 cents now), and Stripe holds it as a pending update with an open invoice.
- When: The admin confirms with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`; Clerk delivers `organizationInvitation.accepted`; the admin confirms again; Stripe delivers the paid upgrade invoice and the admin confirms again; Clerk redelivers the acceptance; then Stripe and Clerk each redeliver once more, with credits read via `GET /api/billing/usage-pack-credits` and allocations via `GET /api/billing/usage-pack-subscription`.
- Then: Confirmation returns `pending_payment` before and after the first acceptance; meanwhile the admin keeps 20,000 purchased and 400 bonus credits and the invited user has 0 and 0. After the paid invoice confirmation returns `completed`. After the redelivered acceptance the invited user has 10,000 purchased, 200 bonus and 10,200 total credits, the admin view shows 35,000 purchased and 1,500 bonus, and allocations show the admin at $50 and the invited user at $20. Further redeliveries leave these credit values unchanged.

## billing-usage-pack-subscriptions-056

- Vitest: "usage pack allocation management > finishes a pending plan payment before activating a paid invitation"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Team usage pack plan with the admin's $20 pack has a $20 paid invitation whose payment succeeded. The admin has previewed a Team Plan change raising their own pack from $20 to $50 (1,500 cents now), and Stripe holds it as a pending update with an open invoice.
- When: The admin confirms with `POST /api/billing/usage-pack-subscription/subscription-change/confirm`; Clerk delivers `organizationInvitation.accepted`; the admin confirms again; Stripe delivers the paid upgrade invoice and the admin confirms again; Clerk redelivers the acceptance; then Stripe and Clerk each redeliver once more, with credits read via `GET /api/billing/usage-pack-credits` and allocations via `GET /api/billing/usage-pack-subscription`.
- Then: Confirmation returns `pending_payment` before and after the first acceptance; meanwhile the admin keeps 20,000 purchased and 400 bonus credits and the invited user has 0 and 0. After the paid invoice confirmation returns `completed`. After the redelivered acceptance the invited user has 10,000 purchased, 200 bonus and 10,200 total credits, the admin view shows 35,000 purchased and 1,500 bonus, and allocations show the admin at $50 and the invited user at $20. Further redeliveries leave these credit values unchanged.

## billing-usage-pack-subscriptions-057

- Vitest: "usage pack allocation management > completes a paid invitation refund after a pending provider response through public revoke"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan has a pending $20 paid invitation whose 1,000-cent payment succeeded. Clerk accepts revocation, and Stripe answers the first refund with status `pending`.
- When: The admin revokes the invitation with `DELETE /api/org/invite`; after the clock advances just over 5 minutes, the invitation is gone from Clerk and Stripe reports the refund `succeeded`, and the admin revokes it twice more.
- Then: Every revoke returns HTTP 200, the first two with "Invitation revoked and refund initiated". Purchased credit grants and the usage pack management view are unchanged. Stripe creates exactly one 1,000-cent refund on the invitation payment intent with idempotency key `usage-pack-invitation:<purchaseId>:refund:1` and retrieves that refund exactly once.

## billing-usage-pack-subscriptions-058

- Vitest: "usage pack allocation management > completes a paid invitation refund after a failed provider response through public revoke"
- Mode: run
- Given: The clock is 2035-05-15. A workspace on a Pro usage pack plan has a pending $20 paid invitation whose 1,000-cent payment succeeded. Clerk accepts revocation, and Stripe answers the first refund with status `failed`.
- When: The admin revokes the invitation with `DELETE /api/org/invite`; after the clock advances just over 5 minutes, the invitation is gone from Clerk and Stripe accepts a new refund as `succeeded`, and the admin revokes it twice more.
- Then: Every revoke returns HTTP 200, the first two with "Invitation revoked and refund initiated". Purchased credit grants and the usage pack management view are unchanged. Stripe creates two 1,000-cent refunds on the invitation payment intent with idempotency keys `usage-pack-invitation:<purchaseId>:refund:1` and `...:refund:2`, and never retrieves a refund.
