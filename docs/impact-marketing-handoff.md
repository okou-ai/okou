# Impact attribution owned by Marketing

Implements the Impact slice of https://github.com/vm0-ai/vm0/issues/33886 with
`vm0-ai/vm0-marketing`. GA/Google Ads, PostHog, Plausible, and removing the
remaining App Google tags are subsequent slices.

## Ownership

Neither the App browser nor the canonical App API retrieves
Impact attribution from Marketing. Marketing owns consented cookies, capture
history, order attribution decisions, submission state and refund receipts in its
dedicated Neon PostgreSQL database. No new Impact fields are written to App
purchase records, Clerk, or Stripe metadata, and no App DB migration is needed.
Existing legacy fields are ignored; this change does not erase
historical billing data.

Marketing captures `im_ref` only after initialized Termly advertising consent.
The host-only `__Host-okou_impact_v2` cookie carries the click ID, capture time and
consent epoch. Marketing-to-App links no longer carry Impact query parameters.
The App mounts `https://www.okou.ai/finish-onboarding` for authenticated users,
including onboarding and returning subscribers.

The session-only `/api/attribution/impact/handoff` endpoint signs a 120-second
identity proof containing authenticated user/org, admin authority, exact origins,
a nonce and expiry. The App passes it with `postMessage`; Marketing reads its
own cookies and associates them with that identity. The App receives only an
acknowledgment. There is no attribution lookup or billing-attribution sync API.
Both windows check the exact origin/source and nonce. The iframe lifetime ends
on unmount/account change, and retries do not block navigation or checkout.

## Payment correlation

Marketing retrieves the Stripe Customer referenced by the payment and reads
`Customer.metadata.orgId`. The canonical API already writes this normal business
identifier when it creates a Customer. Multiple Customers can belong to the same
org; Marketing never assumes the reverse mapping is unique. A missing, deleted
or invalid Customer/org mapping cannot select another org's attribution. A Stripe
lookup outage remains retryable instead of becoming an unattributed purchase.

Payment conversions use only `invoice.paid`; Checkout completion stays ignored.
Order identity and creation time are fixed in Marketing. Invoice creation time is
the default boundary. Credit, plan and invitation previews carry `purchaseCreatedAt`
as ordinary business metadata, including a fallback to hosted Checkout, so later
invoice creation does not move that boundary. Direct subscription Checkout uses
its creation time; renewals use their own invoice creation time.
This timestamp contains no referral information.

Marketing immediately freezes and submits an eligible consented capture available
at the first payment webhook. Orders awaiting an eligible iframe association get
a 10-minute window and return `503 pending_identity` with `Retry-After: 600`.
Stripe owns redelivery; a retry can submit as soon as eligible attribution arrives.
The user's payment never waits. After the window expires, Marketing freezes an
unattributed result if no qualifying capture exists. Later clicks, handoffs,
Customer changes and retries cannot change a frozen attribution decision.

Marketing rechecks consent and order eligibility before each new Impact submission.
The existing program, trackers, 30-day referral window, amounts, stable order IDs,
retries and refund calculations remain. Only Marketing PostgreSQL stores new submission
receipts and adjustments. Historical Stripe submission receipts can be read for
deduplication/refunds; their old click or consent fields are never imported.
Refunds may correct known submissions after withdrawal, but never create a sale.

## Configuration

The hidden bridge loads for every authenticated user with an organization.
Marketing attribution is permanent behavior, with no App or server rollout switch.
The API requires:

- `MARKETING_ATTRIBUTION_SECRET`: the same random secret of at least 32 bytes in
  the Marketing Worker, used only to sign/verify identity proofs.
- `MARKETING_ATTRIBUTION_ORIGIN`: defaults to `https://www.okou.ai`.
- `IMPACT_APP_ORIGIN`: defaults to `https://app.okou.ai`, independently of the
  older generic `APP_URL`/Clerk auth domain.

Follow the Marketing runbook for its dedicated Neon database, credentials and
explicit Stripe live/test mode. Cached App signup requests may contain an old
Impact field; the API ignores it while processing the ordinary acquisition data.
Historical App schema columns remain for old API process compatibility, without
active attribution readers or writers. No historical consent is reconstructed.

## Verification and completion

Focused tests cover signed identity, retired metadata filtering, original purchase
times, delayed and out-of-order webhooks, immutable attribution, consent withdrawal,
duplicate submissions and refunds. Marketing tests exercise the Neon HTTP driver
against isolated real PostgreSQL schemas. No destructive App migration is needed.

The owner marked the Impact phase of #33886 complete after subscription and Deposit
receipts succeeded. Remaining browser acceptance and a separate adjustable-Action
refund test were explicitly waived. The test-entry `ACTION_NOT_FOUND` was accepted
as expected. GA/Google Ads, PostHog and other destinations remain later phases.
