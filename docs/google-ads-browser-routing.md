# Retired App browser attribution

Issue [#33886](https://github.com/vm0-ai/okou/issues/33886) moved acquisition
attribution and provider delivery to Marketing. The App is no longer an
attribution producer, reader, or transport.

## Current boundary

Marketing owns consent, first-touch capture, identity binding, frozen business
events, and Google Ads, GA4, and PostHog acquisition delivery. The App keeps only
product analytics and authenticated business facts:

- App sends `onboarding-start` and `checkout-start` to Marketing through
  `POST /api/events` with `{ tag, eventId }`.
- App PostHog keeps its existing product events, user `distinct_id`, organization
  `org_id`, and event time. Paid-onboarding events contain only product-flow
  properties such as step, role, checkout source, and route.
- App does not parse click IDs, UTM/campaign fields, landing context, or the
  Marketing attribution cookie. It does not persist those values or register
  them as PostHog super properties.
- Sign-in and sign-up retain an explicit trusted `redirect_url`; otherwise a new
  account enters `/onboarding` without constructing an attribution redirect.

Marketing-to-App URL builders are the single link boundary. They omit acquisition
parameters before producing App onboarding or sign-up URLs while preserving
product navigation such as prompts, templates, showcases, and connectors. The App
does not add a second query-parameter sanitizer for arbitrary incoming URLs.

Pre-cutover browsers can retain `vm0.adAttribution`,
`okou.impactAttribution`, and registered PostHog campaign properties after the
old bundle is replaced. The replacement App does not read or update those
session keys and does not add a migration for historical browser state.
Historical Clerk, Stripe, analytics, and provider records are likewise not
rewritten by this change.

## Deployment compatibility

The replacement App must be live before raising the API client-version floor.
Production promotes API before App, so raising the floor in the same release can
make users reload the still-old bundle. After the new App is confirmed online, a
later API release may reject the preceding App version and thereby stop already
open pages from running the retired collector.

Marketing activation and its UTC cutoff are separate production controls. Neither
an App deployment nor a browser refresh promotes historical Marketing events or
replays an old conversion.

## Remaining field inventory

This inventory is historical evidence for operation 016 and related cleanup. It
does not describe active App behavior.

| Historical field or storage                                                   | Current disposition                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vm0_campaign_id`, `vm0_ad_group_id`                                          | Historical aliases remain readable where retained Clerk, Stripe, or provider records require them. Marketing uses canonical `okou_*` campaign fields for new attribution.       |
| `vm0_source`, `vm0_experiment`, `vm0_variant`                                 | No longer collected or propagated by App attribution code. Existing provider-owned and analytics history is left unchanged.                                                     |
| `vm0_attribution`                                                             | Retired cross-site browser attribution cookie. Marketing uses its own host-only consented storage; App does not read it.                                                        |
| `vm0.adAttribution`, `okou.impactAttribution`                                 | No active App reader or writer; this change does not add a browser-state migration.                                                                                             |
| Historical PostHog click, UTM, campaign, landing, and Impact super properties | No new App registration; already-persisted browser state is not migrated by this change.                                                                                        |
| Clerk `signup_attribution` and Stripe acquisition metadata                    | No active App/API writer or reader. Physical historical cleanup is a separate key-level operation that must preserve billing, organization, financial, and `impact_*` metadata. |
| `org_metadata.acquisition_*`                                                  | Historical database fields; no browser fallback or reconstructed first touch.                                                                                                   |
| Archived SQL/scripts, published links, analytics rows, and provider receipts  | Immutable historical evidence. Never use a later visit to manufacture or replay an earlier conversion.                                                                          |

Operation 016 remains the bounded historical campaign/ad-group alias census and
backfill. It does not submit conversions, alter the Marketing cutoff, or authorize
physical deletion of retained attribution history.
