# Impact attribution owned by Marketing

Implements the Impact slice of https://github.com/vm0-ai/vm0/issues/33886 with
`vm0-ai/vm0-marketing`. Google Ads/GA4, PostHog, Plausible, and removing the
remaining App Google tags are subsequent slices.

Marketing captures `im_ref` only after initialized Termly advertising consent.
The Marketing-owned `__Host-okou_impact_v2` cookie carries the click ID, original
capture time, and consent epoch. The App does not read that cookie or receive
those values in URLs. A dedicated iframe at
`https://www.okou.ai/finish-onboarding` performs the handoff. It loads the Termly
consent bridge, without the Marketing app shell or analytics SDKs.

The App mounts this bridge for authenticated users, including onboarding and
returning subscribers. API-issued HMAC proofs contain only the authenticated
user/org, admin authority, exact Marketing/App origins, a nonce, and a 120-second
expiry. They are passed with `postMessage`, never query strings or App session
credentials. Both windows check the exact origin and source; acknowledgments
must match the nonce. The iframe lifetime is cancelled on unmount/account
change; retries do not block routing or payments.

Marketing validates the proof and persists the consent epoch and immutable
capture in its operational Cloudflare D1 database. An epoch cannot be rebound
to another account. Only an authenticated admin can select org attribution;
older clicks cannot replace newer clicks. Revocation tombstones and user denial
times prevent late grants from resurrecting attribution. A pending browser
revocation survives network failures, and must be delivered before regrant.
GPC overrides advertising consent. Consent synchronization continues on later
visits and between open Marketing contexts.

The canonical API retrieves org attribution server-to-server from Marketing.
The result includes an opaque `impact_capture_id` alongside the click/time in
Stripe billing snapshots. Credit Checkout, invoice, PaymentIntent, subscription,
auto-recharge, and invitation purchases retain their existing snapshot rules.
Migration `1118_impact_marketing_invitation_snapshot` adds one nullable reference
to the existing invitation purchase snapshot; it does not make the App database
the attribution authority. Existing rows remain null and are not backfilled.

Marketing's Stripe webhook checks consent at capture/event time and again before
new Impact submissions. The original purchase capture must match; a later
customer click never repairs an earlier unattributed purchase. Missing or
revoked proof suppresses new delivery. Timeouts/429/5xx retain Stripe retry
semantics and stable order IDs. D1 records a submission lease and queued receipt;
permanent rejections require review. `QUEUED` is not an accepted conversion.
Refunds can correct known submissions after opt-out, including recovering a
receipt when the Stripe metadata write failed; refunds never create new
conversions after cutover.

## Configuration and rollout

Both PRs are safe to merge with migration switches off. Apply the additive DB
migration before deploying the new API. Production activation is a separate,
coordinated step; this PR does not change live credentials, consent settings,
provider configuration, or feature overrides.

API runtime configuration:

- `IMPACT_MARKETING_ATTRIBUTION=true` switches legacy Impact ingestion and
  billing lookups to Marketing. Old signup request shapes remain accepted, but
  their Impact fields and Clerk Impact metadata are ignored.
- `MARKETING_ATTRIBUTION_SECRET`: the same random secret of at least 32 bytes
  configured in the Marketing Worker; never expose it in a browser build.
- `MARKETING_ATTRIBUTION_ORIGIN`: defaults to `https://www.okou.ai`.
- `IMPACT_APP_ORIGIN`: defaults to `https://app.okou.ai`. This is deliberately
  separate from the older generic `APP_URL`/Clerk primary auth domain.
- `impactMarketingAttribution`: the App/API feature switch, initially off.

Follow the companion Marketing runbook to create a dedicated D1 database,
configure its binding/secret, and deploy the Worker routes and migration.
Before activation, verify Termly uses opt-in advertising consent in every
supported region, classify the attribution cookie as advertising, and classify
the minimal preference receipt as consent-management storage.

Activate Marketing's server mode first (suppressing legacy unproven conversions),
then API server mode, then the App feature switch. The brief transition may omit
attribution, while checkout stays available. Do not reconstruct consent for old
cookies, Clerk records, or purchases. Cached old Apps remain safe because the
API ignores their Impact input after cutover. Require the new App release before
measuring completeness. Legacy `app.vm0.ai` and previews on unrelated registrable
domains cannot use this same-site cookie design; test with paired HTTPS origins
on the same site and a separate non-production database/secret.

After cutover, pause with `IMPACT_ENABLED=false` in Marketing and/or disable the
App bridge. Keep both server cutover modes enabled. Reverting to legacy ingestion
or delivery would bypass the new consent ledger and is not a safe rollback.

## Validation and operational acceptance

Automated coverage exercises signed identity/role guards, nonce replays,
consent revocation and regrant, first-party cookie behavior, hostile message
sources, duplicate payment delivery, original invoice snapshots, permanent
rejections, and refund recovery. PostgreSQL validates the additive snapshot
migration; Marketing tests execute real SQLite SQL against its D1 schema.

Before enabling production, complete Chrome/Safari checks across Marketing,
authentication and onboarding, then a provider-supported test conversion using
program 57423 / Subscription 87218 / Deposit 87219 and the existing 30-day
referral window. Verify the eventual Impact action, amount/currency/order ID,
replay count, and refund outcome. The current different-site staging domains
are not evidence for first-party cookie behavior. No real purchase or live
Impact conversion is sent by the automated tests.
