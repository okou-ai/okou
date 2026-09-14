# Impact attribution owned by Marketing

Implements the Impact slice of https://github.com/vm0-ai/vm0/issues/33886 with
`vm0-ai/vm0-marketing`. GA/Google Ads, PostHog, Plausible, and removing the
remaining App Google tags are subsequent slices.

## Ownership

With cutover enabled, neither the App browser nor the canonical App API retrieves
Impact attribution from Marketing. Marketing owns consented cookies, capture
history, order attribution decisions, submission state and refund receipts in its
operational Cloudflare D1 database. No new Impact fields are written to App
purchase records, Clerk, or Stripe metadata, and no App DB migration is needed.
Existing legacy fields are ignored after cutover; this change does not erase
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

Marketing allows a 10-minute window after the first payment webhook for a delayed
iframe handoff. Its webhook returns an expected `503 pending_identity` with
`Retry-After: 600`; Stripe owns redelivery, and the user's payment does not wait.
After the window, Marketing selects the latest admin-associated click captured
no later than the purchase, received within that window, and covered by consent.
It freezes the capture reference or an unattributed result. Later clicks, handoffs,
Customer metadata changes and webhook retries cannot rewrite that decision.

Marketing rechecks consent and order eligibility before each new Impact submission.
The existing program, trackers, 30-day referral window, amounts, stable order IDs,
retries and refund calculations remain. Only Marketing D1 stores new submission
receipts and adjustments. Historical Stripe submission receipts can be read for
deduplication/refunds; their old click or consent fields are never imported.
Refunds may correct known submissions after withdrawal, but never create a sale.

## Configuration and rollout

The App mounts the bridge for every authenticated user with an organization,
without an App feature switch. The API and Marketing retain server cutover
configuration. Production activation requires both releases, a dedicated Marketing
D1 database and matching signing secrets.
There is no production data, credential, provider or live-switch change in this PR.

API configuration:

- `IMPACT_MARKETING_ATTRIBUTION=true` disables legacy Impact ingestion, enrichment
  and propagation. Cached Apps' old Impact inputs and pending preview snapshots
  are ignored; business fields continue to work.
- `MARKETING_ATTRIBUTION_SECRET`: the same random secret of at least 32 bytes in
  the Marketing Worker, used only to sign/verify identity proofs.
- `MARKETING_ATTRIBUTION_ORIGIN`: defaults to `https://www.okou.ai`.
- `IMPACT_APP_ORIGIN`: defaults to `https://app.okou.ai`, independently of the
  older generic `APP_URL`/Clerk auth domain.

Follow the Marketing runbook to provision its D1 binding and deploy its migration.
Verify Termly opt-in advertising consent in every supported region, cookie
classification and GPC behavior. Enable Marketing server cutover first, then API
cutover. The App bridge is enabled for all authenticated organizations. During
transition attribution may be omitted; checkout remains available. Require the new
App release before measuring coverage.
Do not reconstruct historical consent from old cookies or billing records.

To pause after cutover, disable Marketing `IMPACT_ENABLED`.
Keep both server cutover modes enabled; re-enabling legacy ingestion/delivery would
bypass the consent ledger.

## Verification and acceptance

Focused tests cover identity-only handoff, legacy/cutover/new purchase combinations,
retired metadata propagation, original purchase times, delayed and out-of-order
webhooks, immutable attribution decisions, consent withdrawal, duplicate deliveries
and refunds. Marketing tests execute the real D1 schema with SQLite. App/API tests
use isolated PostgreSQL; no schema change is introduced.

Before production activation, validate Chrome/Safari Marketing -> authentication ->
onboarding on paired HTTPS origins under the same registrable site. Current App
and Marketing preview domains are on different sites and cannot validate
SameSite=Lax iframe cookies. Complete a provider-supported Impact test for program
57423 / Subscription 87218 / Deposit 87219, including eventual acceptance, amount,
currency, order identity, duplicate count and refund. Automated tests send no live
conversion and do not replace this acceptance.
