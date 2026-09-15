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
The App sends one empty `POST https://www.okou.ai/api/marketing/impact/onboarding`
when an authenticated user enters onboarding. The browser includes cookies;
there is no iframe, `postMessage`, identity-proof fetch, or Termly initialization
in this flow. The root owns the bounded request independently of route readiness,
so changing onboarding steps does not cancel it or wait for its response.

The App records an attempt in browser local storage per user/organization before
sending. Reloads and later visits in that browser do not retry it, including
network/HTTP failures. Other browsers or cleared storage can submit again; the
Marketing write is idempotent. Already-onboarded users do not submit, and missing
or invalid attribution/consent is skipped rather than waiting for new consent.

Marketing verifies the shared Clerk session cookie, including signature, expiry,
App authorized party, user identity and active admin organization. It reads its
own host-only click and consent cookies and retains server-side withdrawal and
account-binding checks. The endpoint accepts only the configured App Origin,
uses credentialed CORS and `Cache-Control: no-store`, and returns an empty `204`
for completed or skipped captures. GET does not write. No attribution data is
returned to the App or its API.

### Deployment boundary

Deploy the Marketing cookie endpoint before the App change. This cutover retires
`/finish-onboarding`, `/api/marketing/impact/config`, both signed handoff APIs,
and their iframe, identity-proof and nonce machinery. Old iframe clients and
pre-cutover rollback artifacts are outside the supported boundary; they must
refresh onto the cookie-request App to record attribution. No client-version
floor or compatibility bridge is introduced.

Marketing migration `0002_drop_impact_handoffs.sql` drops the obsolete replay
nonce table. Existing consented captures, order decisions and refund receipts
continue to serve the current cookie-based flow.

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
at the first payment webhook. Orders awaiting an eligible identity association get
a 10-minute window and return `503 pending_identity` with `Retry-After: 600`.
Stripe owns redelivery; a retry can submit as soon as eligible attribution arrives.
The user's payment never waits. After the window expires, Marketing freezes an
unattributed result if no qualifying capture exists. Later clicks, associations,
Customer changes and retries cannot change a frozen attribution decision.

Marketing rechecks consent and order eligibility before each new Impact submission.
The existing program, trackers, 30-day referral window, amounts, stable order IDs,
retries and refund calculations remain. Only Marketing PostgreSQL stores new submission
receipts and adjustments. Historical Stripe submission receipts can be read for
deduplication/refunds; their old click or consent fields are never imported.
Refunds may correct known submissions after withdrawal, but never create a sale.

## Configuration

The onboarding request has no rollout switch. Marketing uses its existing
`CLERK_SECRET_KEY`, attribution database and `IMPACT_APP_ORIGIN` configuration.
The production Clerk primary is `app.okou.ai`, with a session shared across
Okou subdomains. The App API no longer signs attribution proofs or needs
`MARKETING_ATTRIBUTION_SECRET` / `MARKETING_ATTRIBUTION_ORIGIN`.

Follow the Marketing runbook for its dedicated Neon database, credentials and
explicit Stripe live/test mode. Cached App signup requests may contain an old
Impact field; the API ignores it while processing the ordinary acquisition data.
Historical App schema columns remain for old API process compatibility, without
active attribution readers or writers. No historical consent is reconstructed.

## Verification and completion

Focused tests cover cookie identity, metadata filtering, original purchase
times, delayed and out-of-order webhooks, immutable attribution, consent withdrawal,
duplicate submissions and refunds. Marketing tests exercise the Neon HTTP driver
against isolated real PostgreSQL schemas. No destructive App migration is needed.

The owner marked the Impact phase of #33886 complete after subscription and Deposit
receipts succeeded. Remaining browser acceptance and a separate adjustable-Action
refund test were explicitly waived. The test-entry `ACTION_NOT_FOUND` was accepted
as expected. GA/Google Ads, PostHog and other destinations remain later phases.
