# billing-concurrency-checkout

## billing-concurrency-checkout-001

- Vitest: "POST /api/billing/concurrency-checkout > preserves unrelated archived items, discounts and phase metadata when adding concurrency"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with no concurrency. The subscription is attached to a cancel-at-end Stripe schedule whose current phase holds the Plan item and an archived usage-allowance item with metadata, two discounts (a discount ID and a coupon), and allowance phase metadata, followed by an after-allowance phase. The customer has no payment method, Stripe previews a 15,000-cent proration and a 30,000-cent recurring amount, and paying the finalized invoice fails.
- When: The admin calls `POST /api/billing/concurrency-checkout/preview` with quantity 3 and in-app preview support, then `POST /api/billing/concurrency-checkout` with quantity 3 and success/cancel URLs.
- Then: The preview returns HTTP 200 with current quantity 0, target 3, immediate 15,000 cents, next recurring 30,000 cents, USD. The purchase returns HTTP 200 with the invoice's hosted URL and no Checkout Session is created. Stripe receives a schedule preview and a schedule update (`always_invoice`, idempotency key `concurrency-change:…:schedule-update`) whose phases keep the Plan item, the allowance item with its metadata, the discounts and the phase metadata, and add 3 concurrency slots to both phases. The schedule is not released, the subscription is not updated directly, and the concurrency invoice is finalized and a payment attempted with idempotency keys derived from the subscription and invoice IDs.

## billing-concurrency-checkout-002

- Vitest: "POST /api/billing/concurrency-checkout > schedules a monthly concurrency reduction without changing unrelated archived schedule items"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription that has 10 monthly concurrency slots ending in 29 days. The subscription is attached to a cancel-at-end schedule whose current phase (to 90 days) holds the Plan, an archived usage-allowance item with metadata and the concurrency item, followed by an after-allowance phase to 180 days. Stripe previews a 50,000-cent recurring amount.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` and then `.../changes/confirm` with quantity 5.
- Then: The preview returns HTTP 200 with current 10, target 5, immediate 0 cents, next recurring 50,000 cents, USD and `effectiveAt` at the concurrency period end. Confirm returns HTTP 200 with `completed`, no hosted invoice URL and the same `effectiveAt`. Both the schedule preview and the schedule update (`proration_behavior: none`) split the current phase at the concurrency period end: 10 slots until then, 5 slots afterward and in the after-allowance phase, with the Plan item, allowance item metadata and phase metadata unchanged.

## billing-concurrency-checkout-003

- Vitest: "POST /api/billing/concurrency-checkout > previews a first concurrency purchase on the Plan subscription (neutral schedule: false)"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with no concurrency and no subscription schedule (neutral schedule: false). Stripe previews a 5,500-cent concurrency proration and a recurring invoice whose concurrency lines are only available through the paginated invoice line list.
- When: The admin calls `POST /api/billing/concurrency-checkout/preview` with quantity 3.
- Then: The response is HTTP 200 with current 0, target 3, immediate 5,500 cents, next recurring 30,000 cents, USD. Stripe receives a `next` proration preview on the subscription adding 3 concurrency slots with `always_invoice`, a `recurring` subscription preview with `proration_behavior: none`, and a line-item listing (limit 100) for the recurring invoice. No subscription or schedule is updated or released.

## billing-concurrency-checkout-004

- Vitest: "POST /api/billing/concurrency-checkout > previews a first concurrency purchase on the Plan subscription (neutral schedule: true)"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with no concurrency that is attached to a neutral release-at-end schedule with two Plan-only phases (neutral schedule: true). Stripe rejects recurring subscription previews for scheduled subscriptions, previews a 5,500-cent proration, and returns a recurring invoice whose concurrency lines are only available through the paginated line list.
- When: The admin calls `POST /api/billing/concurrency-checkout/preview` with quantity 3.
- Then: The response is HTTP 200 with current 0, target 3, immediate 5,500 cents, next recurring 30,000 cents, USD. Stripe receives a `next` proration preview on the subscription adding 3 slots, a `next` schedule preview that keeps `release` and adds 3 concurrency slots to both Plan phases with no proration, and a line-item listing (limit 100). No subscription or schedule is updated or released.

## billing-concurrency-checkout-005

- Vitest: "POST /api/billing/concurrency-checkout > allows concurrency to expire with a Team subscription canceling at period end"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with no concurrency that is set to cancel at period end. Stripe previews a 15,000-cent proration and rejects recurring estimates for canceling subscriptions.
- When: The admin calls `POST /api/billing/concurrency-checkout/preview` with quantity 3, then `POST /api/billing/concurrency-checkout` with quantity 3 and success/cancel URLs.
- Then: The preview returns HTTP 200 with current 0, target 3, immediate 15,000 cents, next recurring 0 cents, USD, after exactly one Stripe preview that sets `cancel_at_period_end: false` only for the proration simulation. The purchase returns HTTP 200 with the success URL. The subscription is updated to add 3 concurrency slots with `pending_if_incomplete` and `always_invoice`, and no schedule is created or updated.

## billing-concurrency-checkout-006

- Vitest: "POST /api/billing/concurrency-checkout > previews and applies a concurrency increase without restoring the ending Plan"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with 5 monthly concurrency slots whose Plan has a `cancel_at` at period end. Stripe previews a 12,000-cent proration only when the preview clears `cancel_at`, and rejects recurring estimates.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` and then `.../changes/confirm` with quantity 7.
- Then: The preview returns HTTP 200 with current 5, target 7, immediate 12,000 cents, next recurring 0 cents, USD, after exactly one Stripe preview with `cancel_at: ""` and the concurrency item at 7. Confirm returns HTTP 200 with `processing` and no hosted invoice URL. The subscription update sets the concurrency item to 7 with `pending_if_incomplete` and `always_invoice` and carries neither `cancel_at` nor `cancel_at_period_end`; no schedule is created.

## billing-concurrency-checkout-007

- Vitest: "POST /api/billing/concurrency-checkout > rejects deferred concurrency changes that cannot precede the Plan end"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with 5 concurrency slots, and the Plan is set to cancel at period end.
- When: The admin previews and confirms a change to 3 slots and cancels the concurrency through `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview`, `.../changes/confirm` and `.../cancel`.
- Then: Preview and confirm return HTTP 409 `CONFLICT` "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled." Cancel returns HTTP 409 `CONFLICT` "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled." Stripe receives no preview, subscription update, or schedule creation or update.

## billing-concurrency-checkout-008

- Vitest: "POST /api/billing/concurrency-checkout > rejects a concurrency reduction at the end of a Plan cancellation schedule"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with 5 concurrency slots that is attached to a cancel-at-end schedule with a single phase ending at the period end.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 3.
- Then: The response is HTTP 409 `CONFLICT` "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled." Stripe receives no preview and no schedule update.

## billing-concurrency-checkout-009

- Vitest: "POST /api/billing/concurrency-checkout > adds concurrency to an attached Team cancellation schedule"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription with no concurrency, attached to a cancel-at-end schedule with one Plan-only phase ending at the period end. Stripe previews a 15,000-cent proration and reports no upcoming invoice for the schedule.
- When: The admin calls `POST /api/billing/concurrency-checkout/preview` with quantity 3, then `POST /api/billing/concurrency-checkout` with quantity 3 and success/cancel URLs.
- Then: The preview returns HTTP 200 with current 0, target 3, immediate 15,000 cents, next recurring 0 cents, USD. The purchase returns HTTP 200 with the success URL. Stripe receives exactly two previews, including a schedule preview whose single phase adds 3 concurrency slots, and the schedule is updated with the same phase, `end_behavior: cancel`, `always_invoice` and a `concurrency-change:…:schedule-update` idempotency key. The schedule is not released and the subscription is not updated directly.

## billing-concurrency-checkout-010

- Vitest: "POST /api/billing/concurrency-checkout > rejects a concurrency purchase while the Plan has a scheduled change"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription attached to a release-at-end schedule whose next phase changes the Plan from Team to Pro.
- When: The admin calls `POST /api/billing/concurrency-checkout/preview` and `POST /api/billing/concurrency-checkout` with quantity 3.
- Then: Both requests return HTTP 409 `CONFLICT` "Complete the pending concurrency update before adding slots". Stripe reads the schedule twice and receives no preview, subscription update or schedule update.

## billing-concurrency-checkout-011

- Vitest: "POST /api/billing/concurrency-checkout > adds concurrency to the Plan subscription through a neutral schedule"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription attached to a neutral release-at-end schedule with two Team-only phases. Stripe releases the schedule and returns the subscription with 3 concurrency slots after the update.
- When: The admin calls `POST /api/billing/concurrency-checkout` with quantity 3 and success/cancel URLs.
- Then: The response is HTTP 200 with the success URL. Stripe reads the subscription with the latest invoice expanded, releases the schedule with `preserve_cancel_date: true`, and updates the subscription to add 3 concurrency slots with `pending_if_incomplete`, `always_invoice` and a proration date. No Checkout Session is created, and `GET /api/billing/status` still lists no concurrency subscriptions.

## billing-concurrency-checkout-012

- Vitest: "POST /api/billing/concurrency-checkout > reactivates a zero-quantity concurrency item on the Plan subscription"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription that has a concurrency item with quantity 0. Stripe answers the update with an open invoice and a pending update for 1 slot.
- When: The admin calls `POST /api/billing/concurrency-checkout` with quantity 1 and success/cancel URLs.
- Then: The response is HTTP 200 with the open invoice's hosted URL. The existing concurrency item is updated to quantity 1 by item ID with `pending_if_incomplete`, `always_invoice` and a proration date.

## billing-concurrency-checkout-013

- Vitest: "POST /api/billing/concurrency-checkout > activates concurrency on the Plan subscription without renewing Plan credits"
- Mode: run
- Given: A workspace has a Team Plan subscription, and a later paid invoice on the same subscription adds 3 concurrency slots through 2099-05-20.
- When: The admin reads `GET /api/billing/status`.
- Then: The credit balance equals the balance from the original Plan payment, the workspace has a subscription, and the only concurrency subscription is the Plan subscription with quantity 3 and period end 2099-05-20.

## billing-concurrency-checkout-014

- Vitest: "POST /api/billing/concurrency-checkout > updates Plan and concurrency state from one shared subscription event"
- Mode: run
- Given: A workspace has a Team Plan subscription carrying 3 concurrency slots through 2099-05-20.
- When: Stripe delivers a signed `customer.subscription.updated` event to `POST /api/webhooks/stripe` that marks the shared subscription `past_due` and canceling at period end, and the admin then reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200. The status shows subscription status `past_due` with cancel at period end, while the concurrency subscription for the same ID keeps quantity 3 and `cancelAtPeriodEnd: false`.

## billing-concurrency-checkout-015

- Vitest: "POST /api/billing/concurrency-checkout > does not activate a deleted concurrency subscription from a delayed first invoice"
- Mode: run
- Given: A workspace has a Team Plan subscription. Stripe reports that a separate concurrency subscription no longer exists.
- When: Stripe delivers the same signed `invoice.paid` event for 3 concurrency slots on that deleted subscription twice to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/status`.
- Then: Both deliveries return HTTP 200. The status lists no concurrency subscriptions and the tier stays `team`.

## billing-concurrency-checkout-016

- Vitest: "POST /api/billing/concurrency-checkout > keeps authoritative cancellation across stale equal-quantity events and one clock tick"
- Mode: run
- Given: The clock is fixed at 2035-05-01. A workspace has a standalone concurrency subscription with 2 slots through 2035-06-01, and Stripe currently reports that subscription as canceling at period end.
- When: Stripe delivers three signed `customer.subscription.updated` events within the same millisecond to `POST /api/webhooks/stripe`, with `cancel_at_period_end` true, then false, then false, and the admin reads `GET /api/billing/status` after each delivery.
- Then: Every delivery returns HTTP 200, and after each one the status lists exactly the concurrency subscription with quantity 2 and `cancelAtPeriodEnd: true`.

## billing-concurrency-checkout-017

- Vitest: "POST /api/billing/concurrency-checkout > ends existing concurrency when Stripe reports a missing subscription"
- Mode: run
- Given: A workspace has a standalone concurrency subscription with 2 slots through 2099-05-20, and Stripe reports the subscription as missing (`resource_missing`) (row: missing subscription).
- When: Stripe delivers a signed `customer.subscription.updated` event for that subscription with no items to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200. The status lists no concurrency subscriptions, and the tier and credit balance are unchanged from before the event.

## billing-concurrency-checkout-018

- Vitest: "POST /api/billing/concurrency-checkout > ends existing concurrency when Stripe reports a removed concurrency item"
- Mode: run
- Given: A workspace has a standalone concurrency subscription with 2 slots through 2099-05-20, and Stripe returns the subscription as active with no concurrency item (row: removed concurrency item).
- When: Stripe delivers a signed `customer.subscription.updated` event for that subscription with no items to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200. The status lists no concurrency subscriptions, and the tier and credit balance are unchanged from before the event.

## billing-concurrency-checkout-019

- Vitest: "POST /api/billing/concurrency-checkout > preserves a newer concurrency cancellation when an earlier Stripe reconciliation finishes late"
- Mode: run
- Given: The clock is fixed at 2035-05-01. A workspace has a standalone concurrency subscription with 2 slots through 2035-06-01. While the API reads the subscription from Stripe for a non-canceling update, a newer signed `customer.subscription.updated` event marking it canceling at period end is delivered and processed, after which the slow read returns the older non-canceling state.
- When: Stripe delivers the earlier non-canceling `customer.subscription.updated` event to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/status`.
- Then: The newer event is accepted with HTTP 200 and the earlier delivery returns HTTP 500. The status lists the concurrency subscription with quantity 2, `cancelAtPeriodEnd: true` and period end 2035-06-01.

## billing-concurrency-checkout-020

- Vitest: "POST /api/billing/concurrency-checkout > ends Plan and concurrency state when the shared subscription is deleted"
- Mode: run
- Given: A workspace has a Team Plan subscription carrying 3 concurrency slots through 2099-05-20.
- When: Stripe delivers a signed `customer.subscription.deleted` event for the shared subscription to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200. The status shows tier `limited-free-1`, no subscription, and no concurrency subscriptions.

## billing-concurrency-checkout-021

- Vitest: "POST /api/billing/concurrency-checkout > previews and confirms a concurrency change without Portal"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan also owns a standalone concurrency subscription with 2 slots and a saved default payment method. Stripe previews a 17,000-cent invoice containing a 15,000-cent concurrency proration line and a 2,000-cent non-proration Team line, a 40,000-cent recurring amount for 4 slots, and answers the update with an open invoice and a pending update to 4 slots.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 4, in-app preview support and a return URL, then `.../changes/confirm` with quantity 4 and the returned payment-method preview token.
- Then: The preview returns HTTP 200 with current 2, target 4, immediate 15,000 cents, next recurring 40,000 cents, USD and a payment-method preview token, after a `next` proration preview and a `recurring` preview on the item at 4. Confirm returns HTTP 200 with `pending_payment` and the invoice's hosted URL. Stripe first sets the saved payment method as the subscription default, then updates the item to 4 with `pending_if_incomplete` and `always_invoice`. No billing portal session is created, and `GET /api/billing/status` still shows 2 slots.

## billing-concurrency-checkout-022

- Vitest: "POST /api/billing/concurrency-checkout > returns the pending invoice when confirming a matching pending update"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone concurrency subscription with 2 slots. Stripe already has a pending update to 4 slots with an open invoice.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm` with quantity 4.
- Then: The response is HTTP 200 with `pending_payment` and the pending invoice's hosted URL. Stripe receives no subscription or schedule update, and `GET /api/billing/status` still shows 2 slots.

## billing-concurrency-checkout-023

- Vitest: "POST /api/billing/concurrency-checkout > previews a concurrency reduction at the next billing date"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone monthly concurrency subscription with 5 slots and no schedule. Stripe previews a 30,000-cent recurring amount for 3 slots and creates a schedule on request.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` and then `.../changes/confirm` with quantity 3.
- Then: The preview returns HTTP 200 with current 5, target 3, immediate 0 cents, next recurring 30,000 cents, USD and `effectiveAt` at the current period end, after exactly one `recurring` preview with the item at 3 and no proration. Confirm returns HTTP 200 with `completed`, no hosted invoice URL and the same `effectiveAt`. The new schedule is updated with `end_behavior: release`, a current phase keeping 5 slots until the period end and a one-month phase with 3 slots from then; the subscription is not updated directly.

## billing-concurrency-checkout-024

- Vitest: "POST /api/billing/concurrency-checkout > reuses a concurrency schedule with no future billing changes"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone monthly concurrency subscription with 5 slots that is attached to a neutral release-at-end schedule with two 5-slot phases. Stripe only accepts `next` previews for the schedule and returns a 30,000-cent recurring amount for 3 slots.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` and then `.../changes/confirm` with quantity 3.
- Then: The preview returns HTTP 200 with current 5, target 3, immediate 0 cents, next recurring 30,000 cents, USD and `effectiveAt` at the period end. The schedule preview keeps `release` with 5 slots until the period end and a one-month 3-slot phase afterward, and the preview does not update the subscription or release or update the schedule. Confirm returns HTTP 200 with `completed`, no hosted invoice URL and the same `effectiveAt`, and the existing schedule is updated with a 3-slot phase starting at the period end.

## billing-concurrency-checkout-025

- Vitest: "POST /api/billing/concurrency-checkout > previews an immediate concurrency increase without detaching a neutral schedule"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone monthly concurrency subscription with 5 slots attached to a neutral release-at-end schedule. Stripe only accepts `next` previews, returning a 15,000-cent proration for the subscription and a 70,000-cent recurring amount for the schedule.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 7.
- Then: The response is HTTP 200 with current 5, target 7, immediate 15,000 cents, next recurring 70,000 cents, USD. Stripe receives a `next` schedule preview with no proration, and the subscription is not updated and the schedule is neither released nor updated.

## billing-concurrency-checkout-026

- Vitest: "POST /api/billing/concurrency-checkout > rejects a schedule that repeats invoice items in a future phase"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone concurrency subscription with 5 slots attached to a release-at-end schedule whose current and future phases both add the same one-off invoice item.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 3.
- Then: The response is HTTP 409 with the message "Complete the pending concurrency update before changing slots". Stripe receives no preview, and the schedule is neither released nor updated.

## billing-concurrency-checkout-027

- Vitest: "POST /api/billing/concurrency-checkout > allows concurrency increases but blocks reductions during a Team to Pro downgrade"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 5 monthly concurrency slots and has scheduled a downgrade to Pro through `POST /api/billing/downgrade` (HTTP 200), leaving a release-at-end schedule whose next phase switches to Pro with 5 slots. Stripe previews a 10,000-cent proration for increases.
- When: The admin previews an increase to 6 slots, previews a reduction to 3 slots, cancels the concurrency, and then confirms 6 slots, all through `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview`, `.../cancel` and `.../changes/confirm`.
- Then: The increase preview returns HTTP 200 with current 5, target 6, immediate 10,000 cents, next recurring 0 cents, USD. The reduction preview returns HTTP 409 `CONFLICT` "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled." and the cancel returns HTTP 409 `CONFLICT` "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled." The confirm returns HTTP 200 with `processing` and no hosted invoice URL. Stripe receives two previews, the schedule is read and not released, the subscription is not updated directly, and the schedule is updated with `always_invoice` to 6 slots alongside Team in the current phase and only the Pro item in the next phase.

## billing-concurrency-checkout-028

- Vitest: "POST /api/billing/concurrency-checkout > replaces an existing scheduled concurrency reduction"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone monthly concurrency subscription with 5 slots and has already scheduled a reduction to 3 at the period end through preview and confirm, which creates a release-at-end schedule. Stripe previews a 20,000-cent recurring amount for 2 slots.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 2 and then calls `.../changes/confirm` with quantity 2 twice.
- Then: After the first change `GET /api/billing/status` shows quantity 5 with scheduled quantity 3 at the period end. The replacement preview returns HTTP 200 with current 5, target 2, immediate 0 cents, next recurring 20,000 cents, USD and `effectiveAt` at the period end, from a schedule preview with 5 slots until the period end and a one-month 2-slot phase afterward. Stripe creates the schedule only once and updates it three times in total, with the retried confirmation using a different idempotency key than the replacement. The status then shows quantity 5 with scheduled quantity 2 at the period end.

## billing-concurrency-checkout-029

- Vitest: "POST /api/billing/concurrency-checkout > releases a scheduled reduction before applying an increase"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone monthly concurrency subscription with 10 slots and has scheduled a reduction to 2 at the period end through preview and confirm. Stripe previews a 100,000-cent proration for an increase to 20 slots.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 10, then with quantity 20, then `.../changes/confirm` with quantity 20.
- Then: After the reduction `GET /api/billing/status` shows quantity 10 with scheduled quantity 2. The quantity-10 preview returns HTTP 200 with current 10, target 10, immediate 0 cents, next recurring 100,000 cents, USD from a schedule preview restoring 10 slots after the period end. The quantity-20 preview returns HTTP 200 with current 10, target 20, immediate 100,000 cents, next recurring 200,000 cents, USD from a schedule preview with 10 slots until the period end and a one-month 20-slot phase. Confirm returns HTTP 200 with `processing` and no hosted invoice URL; Stripe releases the schedule with `preserve_cancel_date: true` before updating the item to 20 with `pending_if_incomplete` and `always_invoice`, and no schedule update is made. The status then shows 10 slots with no scheduled quantity.

## billing-concurrency-checkout-030

- Vitest: "POST /api/billing/concurrency-checkout > rejects in-app concurrency changes from non-admin members"
- Mode: run
- Given: A workspace on a Team Plan has a signed-in member without the admin role.
- When: The member calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/preview` with quantity 2.
- Then: The response is HTTP 403 `FORBIDDEN` "Only org admins can manage concurrency subscriptions", and Stripe is never asked for the subscription.

## billing-concurrency-checkout-031

- Vitest: "POST /api/billing/concurrency-checkout > requires restoring a canceling concurrency subscription before adding slots"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone concurrency subscription with 2 slots and has canceled it through `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel` (HTTP 200).
- When: The admin calls `POST /api/billing/concurrency-checkout` with quantity 1 and success/cancel URLs.
- Then: The response is HTTP 400 `BAD_REQUEST` "Restore the existing concurrency subscription before buying more slots", and Stripe is neither asked for nor updates the subscription.

## billing-concurrency-checkout-032

- Vitest: "POST /api/billing/concurrency-checkout > uses the live Stripe quantity for proration invoices"
- Mode: run
- Given: A workspace on a Team Plan owns a standalone concurrency subscription with 2 slots through 2099-05-20. Stripe reports the live subscription item at quantity 4.
- When: Stripe delivers a signed `invoice.paid` proration invoice for the concurrency subscription to `POST /api/webhooks/stripe`, with a -20,000-cent line for 2 slots and a 50,000-cent line for 5 slots, and the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200, and the status lists exactly the concurrency subscription with quantity 4.

## billing-concurrency-checkout-033

- Vitest: "POST /api/billing/concurrency-checkout > persists concurrency when shared subscription metadata has a stale usage pack ID"
- Mode: run
- Given: A workspace has a Team Plan subscription whose Stripe metadata carries `purpose: usage_pack_subscription` and a stale usage-pack subscription ID. Stripe reports the subscription with the Team item and 3 concurrency slots.
- When: Stripe delivers a signed `invoice.paid` event with that metadata and a 3-slot concurrency proration line to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200, and the status lists exactly one concurrency subscription for the Plan subscription with quantity 3.

## billing-concurrency-checkout-034

- Vitest: "POST /api/billing/concurrency-checkout > adds concurrency to the Plan subscription with a real execution-issued agent token"
- Mode: run
- Given: A workspace admin owns a Team Plan subscription with no concurrency and holds the admin role in the workspace membership. A thread run executed on a Runner issues the agent token in its platform environment (`OKOU_TOKEN`). Stripe returns the subscription with 2 concurrency slots after the update.
- When: The caller uses that agent token as the bearer token for `POST /api/billing/concurrency-checkout` with quantity 2 and success/cancel URLs.
- Then: The response is HTTP 200 with the success URL, and the Plan subscription is updated to add 2 concurrency slots with `pending_if_incomplete`, `always_invoice` and a proration date.

## billing-concurrency-checkout-035

- Vitest: "POST /api/billing/concurrency-checkout > rejects concurrency checkout for Pro workspaces"
- Mode: run
- Given: A signed-in workspace admin is on the Pro Plan.
- When: The admin calls `POST /api/billing/concurrency-checkout` with quantity 1 and success/cancel URLs.
- Then: The response is HTTP 400 `BAD_REQUEST` "Additional concurrency is only available for Team workspaces", and no Checkout Session is created.

## billing-concurrency-checkout-036

- Vitest: "POST /api/billing/concurrency-checkout > returns 400 when concurrency price is not configured"
- Mode: run
- Given: A signed-in workspace admin is on the Team Plan, and no concurrency price is configured.
- When: The admin calls `POST /api/billing/concurrency-checkout` with quantity 1 and success/cancel URLs.
- Then: The response is HTTP 400 `BAD_REQUEST` "Concurrency price not configured".

## billing-concurrency-checkout-037

- Vitest: "POST /api/billing/concurrency-checkout > keeps a scheduled concurrency reduction when its subscription webhook lands before the local write"
- Mode: run
- Given: A signed-in workspace admin on a Team Plan owns a standalone monthly concurrency subscription with 5 slots attached to a release-at-end schedule with one 5-slot phase. While Stripe applies the schedule update, a signed `customer.subscription.updated` webhook for the subscription arrives and is accepted with HTTP 200 before the API records the change.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm` with quantity 3.
- Then: The response is HTTP 200 with `completed`, no hosted invoice URL and `effectiveAt` at the period end, and the schedule is updated with new phases. `GET /api/billing/status` shows quantity 5 with scheduled quantity 3 at the period end.

## billing-concurrency-checkout-038

- Vitest: "POST /api/billing/concurrency-checkout > keeps a concurrency cancellation when its subscription webhook lands before the local write"
- Mode: run
- Given: A signed-in workspace admin owns a standalone concurrency subscription with 2 slots. While Stripe applies the cancellation, a signed `customer.subscription.updated` webhook marking it canceling at period end arrives and is accepted with HTTP 200 before the API records the change.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel`.
- Then: The response is HTTP 200 with `success: true` and the current period end. `GET /api/billing/status` shows the subscription with quantity 2 and `cancelAtPeriodEnd: true`.

## billing-concurrency-checkout-039

- Vitest: "POST /api/billing/concurrency-checkout > converges concurrent cancellation of an active concurrency subscription"
- Mode: run
- Given: A signed-in workspace admin owns an active standalone concurrency subscription with 2 slots through 2099-05-20.
- When: The admin sends two concurrent `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel` requests.
- Then: Both responses are HTTP 200 with `success: true` and period end 2099-05-20. Stripe is asked to set `cancel_at_period_end: true`, and `GET /api/billing/status` shows the subscription with quantity 2 and `cancelAtPeriodEnd: true`.

## billing-concurrency-checkout-040

- Vitest: "POST /api/billing/concurrency-checkout > restores an active concurrency subscription renewal"
- Mode: run
- Given: A signed-in workspace admin owns an active standalone concurrency subscription with 2 slots through 2099-05-20 and has canceled it through `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel` (HTTP 200).
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`.
- Then: The response is HTTP 200 with `success: true`. Stripe is asked to set `cancel_at_period_end: false`, and `GET /api/billing/status` shows the subscription with `cancelAtPeriodEnd: false`.

## billing-concurrency-checkout-041

- Vitest: "POST /api/billing/concurrency-checkout > restores a scheduled shared concurrency reduction"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 5 monthly concurrency slots and has confirmed a reduction to 3 through `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm`, so `GET /api/billing/status` shows scheduled quantity 3. Stripe now reports a release-at-end schedule with 5 slots until the period end and 3 slots afterward.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`.
- Then: The response is HTTP 200 with `success: true`. Stripe releases the schedule with `preserve_cancel_date: true`, and the status shows no scheduled quantity and the concurrency subscription not canceling.

## billing-concurrency-checkout-042

- Vitest: "POST /api/billing/concurrency-checkout > restores a concurrency reduction without removing the Plan cancellation"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 5 monthly concurrency slots whose concurrency period ends a month before the Plan period, and has confirmed a reduction to 3. Stripe now reports a cancel-at-end schedule with 5 slots until the concurrency period end and 3 slots until the Plan end.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`.
- Then: The response is HTTP 200 with `success: true`. Stripe updates the schedule keeping `end_behavior: cancel` with no proration, restoring 5 slots in both phases alongside the Team item, with a `concurrency-change:…:schedule-update` idempotency key, and does not release the schedule. `GET /api/billing/status` shows no scheduled quantity.

## billing-concurrency-checkout-043

- Vitest: "POST /api/billing/concurrency-checkout > restores stale shared concurrency state after its schedule is removed"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 2 monthly concurrency slots and has canceled the concurrency through `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel` (HTTP 200). Stripe now reports the subscription with `cancel_at` at the period end, canceling at period end and no schedule.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`.
- Then: The response is HTTP 200 with `success: true`. Stripe receives no subscription update and no schedule release, and `GET /api/billing/status` shows the concurrency subscription not canceling.

## billing-concurrency-checkout-044

- Vitest: "POST /api/billing/concurrency-checkout > does not mark shared concurrency as restorable when the Plan cancels"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 2 concurrency slots.
- When: Stripe delivers a signed `customer.subscription.updated` event to `POST /api/webhooks/stripe` marking the shared subscription canceling at period end, and the admin reads `GET /api/billing/status`.
- Then: The webhook returns HTTP 200. The status shows the Plan canceling at period end, while the concurrency subscription is not marked as canceling and still reports `canReduce: true`.

## billing-concurrency-checkout-045

- Vitest: "POST /api/billing/concurrency-checkout > does not release a Plan schedule when shared concurrency is not canceling"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 2 concurrency slots that is not canceling, and Stripe reports the subscription attached to a Plan schedule.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`.
- Then: The response is HTTP 404. Stripe is never asked for the subscription and no schedule is released.

## billing-concurrency-checkout-046

- Vitest: "POST /api/billing/concurrency-checkout > cancels and restores a shared concurrency item without blocking later changes"
- Mode: run
- Given: A signed-in workspace admin owns a Team Plan subscription carrying 2 monthly concurrency slots with no schedule.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel`; Stripe then delivers a signed `customer.subscription.updated` event for the now-scheduled subscription to `POST /api/webhooks/stripe`; the admin calls `.../restore` and finally `.../changes/preview` with quantity 1.
- Then: Cancel creates a schedule from the subscription and updates it (`release`, no proration) with Team plus 2 slots until the period end and a one-month Team-only phase afterward, without updating the subscription directly; `GET /api/billing/status` shows the Plan not canceling and the concurrency canceling, which stays true after the webhook (HTTP 200). Restore returns HTTP 200 and releases the schedule with `preserve_cancel_date: true`; across the webhook and restore Stripe reads the schedule twice, the schedule is updated only once overall, and the subscription is never updated directly; the status then shows neither the Plan nor the concurrency canceling. The later preview returns HTTP 200 with current 2, target 1, immediate 0 cents, next recurring 10,000 cents, USD and `effectiveAt` at the period end.

## billing-concurrency-checkout-047

- Vitest: "POST /api/billing/concurrency-checkout > returns 404 when restoring a concurrency subscription outside the org"
- Mode: run
- Given: A signed-in workspace admin is on the Team Plan, and the requested concurrency subscription ID does not belong to the workspace.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and Stripe receives no subscription update.

## billing-concurrency-checkout-048

- Vitest: "POST /api/billing/concurrency-checkout > returns 404 when cancelling a concurrency subscription outside the org"
- Mode: run
- Given: A signed-in workspace admin is on the Team Plan, and the requested concurrency subscription ID does not belong to the workspace.
- When: The admin calls `POST /api/billing/concurrency-subscriptions/:subscriptionId/cancel`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and Stripe receives no subscription update.
