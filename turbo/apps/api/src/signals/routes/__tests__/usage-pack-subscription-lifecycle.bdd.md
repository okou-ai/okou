# usage-pack-subscription-lifecycle

## usage-pack-subscription-lifecycle-001

- Vitest: "usage pack subscription Stripe lifecycle > grants usage pack buckets once for initial payment while the switch is off"
- Mode: run
- Given: Row `initial payment`. A workspace admin with 0 credits checked out a Pro usage-pack plan via `POST /api/billing/usage-pack-checkout` with a $20 pack for themselves and a $20 pack for a pending invitation; no feature switch is enabled. Stripe reports the subscription with two $20 pack items for the current 30-day period.
- When: Stripe delivers `checkout.session.completed` twice (distinct events for the same Checkout), `customer.subscription.created`, and the same `invoice.paid` twice to `POST /api/webhooks/stripe`; the admin reads `GET /api/billing/usage-pack-credits`, `GET /api/billing/usage-pack-subscription` and `GET /api/billing/status`.
- Then: Before payment there are no grants and billing shows `limited-free-1` with `hasSubscription: true`. After payment the admin has exactly one bonus grant of 400 and one purchased grant of 20000, both expiring at the period end; there is one allocation for the admin with a $20 pack, and billing shows tier `pro` with 0 credits.

## usage-pack-subscription-lifecycle-002

- Vitest: "usage pack subscription Stripe lifecycle > grants usage pack buckets once for renewal while the switch is off"
- Mode: run
- Given: Row `renewal`. A workspace admin with 0 credits checked out a Pro usage-pack plan with $20 packs for themselves and a pending invitation; no feature switch is enabled. The checkout, subscription creation and first `invoice.paid` have been delivered.
- When: Stripe moves the subscription to the next 30-day period and delivers a renewal `invoice.paid` to `POST /api/webhooks/stripe`, and the admin reads `GET /api/billing/usage-pack-credits`.
- Then: The admin has four grants in total, two of which expire at the renewal period end.

## usage-pack-subscription-lifecycle-003

- Vitest: "usage pack subscription Stripe lifecycle > floors prorated purchased and bonus grants independently"
- Mode: run
- Given: A workspace admin checked out a Pro usage-pack plan with a $50 pack (2600 bonus credits). Stripe reports the subscription for the current period.
- When: Stripe delivers an `invoice.paid` whose $50 pack line is prorated to 1667/5000 of the full amount, and the admin reads `GET /api/billing/usage-pack-credits`.
- Then: The response shows 16670 purchased, 866 bonus and 17536 total credits with `hasUsagePack: true`, exactly two grants (bonus 866 and purchased 16670, fully remaining, expiring at the period end), and one member entry with the same totals and the same two grants.

## usage-pack-subscription-lifecycle-004

- Vitest: "usage pack subscription Stripe lifecycle > grants fully discounted renewal credits without a refundable amount"
- Mode: run
- Given: A workspace admin with 0 credits checked out a Pro usage-pack plan with a $20 pack, and Stripe created the subscription.
- When: Stripe delivers a fully discounted `invoice.paid` to `POST /api/webhooks/stripe`, then Clerk reports the member's organization membership deleted, and a remaining admin reads `GET /api/billing/usage-pack-credits`.
- Then: The member first receives a purchased grant of 20000 and a bonus grant of 400. After the membership deletion no Stripe refund is created and the remaining admin sees no grants.

## usage-pack-subscription-lifecycle-005

- Vitest: "usage pack subscription Stripe lifecycle > shows usage packs after purchasing the new pro plan"
- Mode: run
- Given: Row `pro`. A workspace admin checked out the new Pro usage-pack plan with a $20 pack.
- When: Stripe delivers the first `invoice.paid` to `POST /api/webhooks/stripe` and the admin reads `GET /api/billing/status`.
- Then: Billing status shows tier `pro` and `showUsagePack: true`.

## usage-pack-subscription-lifecycle-006

- Vitest: "usage pack subscription Stripe lifecycle > shows usage packs after purchasing the new team plan"
- Mode: run
- Given: Row `team`. A workspace admin checked out the new Team usage-pack plan with a $20 pack.
- When: Stripe delivers the first `invoice.paid` to `POST /api/webhooks/stripe` and the admin reads `GET /api/billing/status`.
- Then: Billing status shows tier `team` and `showUsagePack: true`.

## usage-pack-subscription-lifecycle-007

- Vitest: "usage pack subscription Stripe lifecycle > rejects an invoice line that extends beyond the current Stripe period"
- Mode: run
- Given: A workspace admin with 0 credits checked out a Pro usage-pack plan with a $20 pack; Stripe reports the current period.
- When: Stripe delivers a half-prorated `invoice.paid` whose line ends one second after the current period, then redelivers the same invoice with the line inside the period, to `POST /api/webhooks/stripe`.
- Then: The first delivery returns HTTP 500 and no grants exist. The corrected delivery returns HTTP 200 and two grants exist.

## usage-pack-subscription-lifecycle-008

- Vitest: "usage pack subscription Stripe lifecycle > fulfills an older paid invoice without rewinding the current period"
- Mode: run
- Given: A workspace admin with 0 credits checked out a Pro usage-pack plan with a $20 pack; Stripe reports the subscription in the next (current) 30-day period.
- When: Stripe delivers `invoice.paid` for the current period and then a different `invoice.paid` for the older period to `POST /api/webhooks/stripe`.
- Then: Four grants exist, and billing status keeps `currentPeriodEnd` at the current period's end.

## usage-pack-subscription-lifecycle-009

- Vitest: "usage pack subscription Stripe lifecycle > keeps paid grants through scheduled cancellation and uses the existing terminal fallback"
- Mode: run
- Given: A workspace admin with 0 credits checked out a Pro usage-pack plan with a $20 pack, and the first `invoice.paid` was fulfilled.
- When: Stripe delivers `customer.subscription.updated` with cancellation at period end, then `customer.subscription.deleted`, to `POST /api/webhooks/stripe`; the admin reads billing status and usage-pack credits after each.
- Then: After scheduling, billing shows tier `pro` with `cancelAtPeriodEnd: true` and two grants remain. After deletion, billing shows `limited-free-1`, `hasSubscription: false` and `showUsagePack: false`, and the two paid grants remain.

## usage-pack-subscription-lifecycle-010

- Vitest: "usage pack subscription Stripe lifecycle > settles a paid invoice delivered after deletion without reactivating the subscription"
- Mode: run
- Given: A workspace admin with 0 credits checked out a Pro usage-pack plan with a $20 pack. Stripe completed the Checkout and then deleted the subscription (status `canceled`).
- When: Stripe delivers the paid first invoice twice to `POST /api/webhooks/stripe` after the deletion, and the admin reads billing status and usage-pack credits.
- Then: Exactly two grants exist, and billing still shows `limited-free-1` with `hasSubscription: false`.

## usage-pack-subscription-lifecycle-011

- Vitest: "usage pack subscription Stripe lifecycle > preserves personal onboarding credits through the first usage pack purchase"
- Mode: run
- Given: A workspace admin checked out a Pro usage-pack plan with a $20 pack, then provisioned the workspace and completed onboarding, receiving a personal 1000-credit bonus grant. Billing status shows `limited-free-1` with 0 org credits and no org grants.
- When: Stripe delivers the first `invoice.paid` to `POST /api/webhooks/stripe`, then delivers the same invoice again, and the admin reads `GET /api/billing/usage-pack-credits` each time.
- Then: Before payment the member has 1000 total (1000 bonus, 0 purchased) and `hasUsagePack: false`. After payment billing shows `pro` with 0 org credits, and the member has 21400 total (20000 purchased, 1400 bonus), `hasUsagePack: true`, and three grants including the original onboarding grant. The replay leaves the usage-pack credits unchanged.

## usage-pack-subscription-lifecycle-012

- Vitest: "usage pack subscription Stripe lifecycle > preserves a first-upgrade balance of 0 and does not waive later renewal debt"
- Mode: run
- Given: Row `0`. A workspace admin checked out a Pro usage-pack plan with a $20 pack while the organization had 0 credits and no existing grants.
- When: Stripe delivers the first `invoice.paid`, the organization then spends into -3000 credits, and Stripe delivers a renewal `invoice.paid` for the next period to `POST /api/webhooks/stripe`.
- Then: After the first invoice billing shows `pro` with 0 credits and two new grants. After the renewal billing shows `pro` with -3000 credits (the debt is not waived) and four grants in total.

## usage-pack-subscription-lifecycle-013

- Vitest: "usage pack subscription Stripe lifecycle > preserves a first-upgrade balance of 2000 and does not waive later renewal debt"
- Mode: run
- Given: Row `2000`. A workspace admin checked out a Pro usage-pack plan with a $20 pack; the organization then earned 2000 credits from a Slack install reward and the admin received a 100-credit connector bonus grant.
- When: Stripe delivers the first `invoice.paid`, the organization then spends into -3000 credits, and Stripe delivers a renewal `invoice.paid` for the next period to `POST /api/webhooks/stripe`.
- Then: After the first invoice billing shows `pro` with 2000 credits and the existing 100 bonus grant plus two new grants. After the renewal billing shows `pro` with -3000 credits and the existing grant plus four new grants.

## usage-pack-subscription-lifecycle-014

- Vitest: "usage pack subscription Stripe lifecycle > fulfills concurrent first invoices once and preserves new debt when the invoice is replayed"
- Mode: run
- Given: A workspace admin's organization is at -5000 credits and the admin checked out a Pro usage-pack plan with a $20 pack.
- When: Stripe delivers the same first `invoice.paid` twice concurrently to `POST /api/webhooks/stripe`; the organization later spends into -3000 credits and Stripe replays the invoice.
- Then: After the concurrent deliveries billing shows `pro` with 0 credits and exactly two grants. After the replay billing shows -3000 credits and the grants are unchanged.

## usage-pack-subscription-lifecycle-015

- Vitest: "usage pack subscription Stripe lifecycle > rolls back debt forgiveness and grants when the subscription cannot be persisted"
- Mode: run
- Given: A workspace admin's organization is at -5000 credits and the admin checked out a Pro usage-pack plan with a $20 pack. Stripe first reports the subscription with an invalid status that cannot be stored.
- When: Stripe delivers the first `invoice.paid` to `POST /api/webhooks/stripe`, then retries after the subscription reports `active`.
- Then: The first delivery returns HTTP 500 and billing status and grants are exactly as before payment. The retry returns HTTP 200, billing shows `pro` with 0 credits, and two grants exist.

## usage-pack-subscription-lifecycle-016

- Vitest: "usage pack subscription Stripe lifecycle > preserves debt after a previous credit_purchase even when the organization is free again"
- Mode: run
- Given: Row `credit_purchase`. A workspace admin with 0 credits checked out a usage-pack plan, temporarily had a legacy Pro plan, bought 10000 credits, and the legacy plan was then deleted so the organization is free again with 10000 credits; it then spent into -5000 credits.
- When: Stripe delivers the first usage-pack `invoice.paid` to `POST /api/webhooks/stripe`.
- Then: Billing shows `pro` with -5000 credits (the debt is preserved) and two grants exist.

## usage-pack-subscription-lifecycle-017

- Vitest: "usage pack subscription Stripe lifecycle > preserves debt after a previous auto_recharge even when the organization is free again"
- Mode: run
- Given: Row `auto_recharge`. A workspace admin with 0 credits checked out a usage-pack plan, temporarily had a legacy Pro plan, enabled auto-recharge via `PUT /api/billing/auto-recharge` (threshold 1000, amount 10000) which paid a 10000-credit invoice, then disabled it; the legacy plan was deleted so the organization is free again with 10000 credits, then it spent into -5000 credits.
- When: Stripe delivers the first usage-pack `invoice.paid` to `POST /api/webhooks/stripe`.
- Then: Billing shows `pro` with -5000 credits (the debt is preserved) and two grants exist.

## usage-pack-subscription-lifecycle-018

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > grants a Plan once and refunds the later usage pack payment once"
- Mode: run
- Given: A workspace admin with 0 credits has both a legacy Pro plan purchase and a $20 usage-pack plan purchase, both created before either was paid.
- When: Stripe delivers `invoice.paid` for the Plan, the usage pack, the usage pack again, and the Plan again to `POST /api/webhooks/stripe`.
- Then: Billing shows tier `pro` with one org credit grant and no usage-pack member grants. The usage-pack invoice receives exactly one `duplicate` credit note (idempotency key `duplicate-subscription:<invoice>:refund`) and its subscription is cancelled without invoicing or proration (idempotency key `duplicate-subscription:<subscription>:cancel`).

## usage-pack-subscription-lifecycle-019

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > grants a usage pack once and refunds the later Plan payment once"
- Mode: run
- Given: A workspace admin with 0 credits has both a legacy Pro plan purchase and a $20 usage-pack plan purchase, both created before either was paid.
- When: Stripe delivers `invoice.paid` for the usage pack, the Plan, the Plan again, and the usage pack again to `POST /api/webhooks/stripe`.
- Then: Billing shows tier `pro` with no org credit grants and two usage-pack member grants. The Plan invoice receives exactly one `duplicate` credit note and its subscription is cancelled once without invoicing or proration.

## usage-pack-subscription-lifecycle-020

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > grants one of two concurrently paid initial purchases and refunds the other once"
- Mode: run
- Given: A workspace admin with 0 credits has both a legacy Pro plan purchase and a $20 usage-pack plan purchase, both created before either was paid.
- When: Stripe delivers both `invoice.paid` events concurrently to `POST /api/webhooks/stripe`, then redelivers both.
- Then: At least one concurrent delivery succeeds. Exactly one purchase is granted (either one org credit grant for the Plan or two member grants for the usage pack), and the other purchase's invoice is refunded once with a `duplicate` credit note and its subscription cancelled once.

## usage-pack-subscription-lifecycle-021

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > keeps the first effective Plan of duplicate initial purchases with the lower tier first"
- Mode: run
- Given: Row `lower tier first`. A workspace admin with 0 credits has two legacy Plan purchases created before either was paid: Pro first, then Team.
- When: Stripe delivers `invoice.paid` for Pro, Team, Team again, and Pro again to `POST /api/webhooks/stripe`.
- Then: Billing keeps tier `pro` with one org credit grant. The Team invoice is refunded once with a `duplicate` credit note, and exactly one subscription is cancelled.

## usage-pack-subscription-lifecycle-022

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > keeps the first effective Plan of duplicate initial purchases with the higher tier first"
- Mode: run
- Given: Row `higher tier first`. A workspace admin with 0 credits has two legacy Plan purchases created before either was paid: Team first, then Pro.
- When: Stripe delivers `invoice.paid` for Team, Pro, Pro again, and Team again to `POST /api/webhooks/stripe`.
- Then: Billing keeps tier `team` with one org credit grant. The Pro invoice is refunded once with a `duplicate` credit note, and exactly one subscription is cancelled.

## usage-pack-subscription-lifecycle-023

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > grants one of two concurrently paid initial Plans and refunds the other once"
- Mode: run
- Given: A workspace admin with 0 credits has two legacy Team plan purchases created before either was paid, and both deliveries pass the duplicate check before either publishes.
- When: Stripe delivers both `invoice.paid` events concurrently to `POST /api/webhooks/stripe`, then redelivers both.
- Then: Billing shows tier `team` with one org credit grant. The losing invoice is refunded once with a `duplicate` credit note and exactly one subscription is cancelled. The redeliveries leave billing and grants unchanged and cause no further refunds or cancellations.

## usage-pack-subscription-lifecycle-024

- Vitest: "usage pack subscription Stripe lifecycle > duplicate initial Plan and usage pack purchases > upgrades a paid Plan created earlier without refunding it"
- Mode: run
- Given: A workspace admin checked out a usage-pack plan. A legacy Pro plan was paid, and a legacy Team plan was bought one minute after the Pro plan was paid.
- When: Stripe delivers `invoice.paid` for Pro, then Team twice, to `POST /api/webhooks/stripe`.
- Then: Billing shows tier `team` and no credit note (refund) is created.

## usage-pack-subscription-lifecycle-025

- Vitest: "usage pack subscription Stripe lifecycle > preserves debt for a returning legacy Pro subscriber after its old billing period"
- Mode: run
- Given: The date is fixed to 2035-05-15. A workspace admin with 0 credits checked out a usage-pack plan. A legacy Pro subscription was paid for a billing period that started 60 days earlier, giving tier `pro` with no org credit grants, and was then deleted so the organization is `limited-free-1`; the organization then spent into -5000 credits.
- When: Stripe delivers the first usage-pack `invoice.paid` to `POST /api/webhooks/stripe`.
- Then: Billing shows tier `pro` with -5000 credits (the debt is preserved) and two usage-pack grants exist.

## usage-pack-subscription-lifecycle-026

- Vitest: "usage pack subscription Stripe lifecycle > preserves debt after a one-time credit purchase has expired"
- Mode: run
- Given: A workspace admin with 0 credits checked out a usage-pack plan, then redeemed the one-time campaign `ZERO100` via `POST /api/billing/redeem/ZERO100`; Stripe completed the paid Checkout, giving 100000 credits. The clock advances 31 days and the organization spends into -5000 credits.
- When: Stripe delivers the first usage-pack `invoice.paid` to `POST /api/webhooks/stripe`.
- Then: Billing shows tier `pro` with -5000 credits (the debt is preserved) and two usage-pack grants exist.

## usage-pack-subscription-lifecycle-027

- Vitest: "usage pack subscription Stripe lifecycle > rolls back invalid Product metadata and succeeds when Stripe retries"
- Mode: run
- Given: A workspace admin with 0 credits checked out a Pro usage-pack plan with a $20 pack. The usage pack Product's `bonusCredits` metadata is first `not-an-integer`, later corrected to `400`.
- When: Stripe delivers the first `invoice.paid` to `POST /api/webhooks/stripe`, then retries the same invoice after the metadata is fixed.
- Then: The first delivery returns HTTP 500, no grants exist and billing remains `limited-free-1`. The retry returns HTTP 200 and two grants exist.
