# Google Ads browser conversion routing

Browser conversions use the captured campaign's verified Google Ads customer.
`@okouai/core/google-ads-account` mirrors the campaign registry in
`vm0-marketing/vite-ssr/app/lib/googleAdsAccounts.ts`, verified against Google Ads
on 2026-09-09, with additional campaigns verified on 2026-09-14. Register a newly verified campaign in both repositories before
expecting its conversions. Campaign names, UTM names and product domains do not
establish ownership; missing, unknown or conflicting IDs remain unresolved.

## Attribution parameter migration

`okou_campaign_id` and `okou_ad_group_id` are the canonical in-process and
browser URL fields. URL capture accepts both spellings and retains conflicting
values as comma-separated evidence. API and stored-metadata normalization does
not trim IDs or choose one conflicting alias, preserving account validation.
UTM parameters, click IDs, campaign ownership, first-touch precedence, event
values and conversion deduplication are unchanged.

The migration tracked in #33059 uses canonical campaign/ad-group fields for
new App requests and Clerk first-touch writes. The API and stored-data readers
still accept historical aliases. Deployment evidence for retiring the old
serialization is recorded below. These remaining boundaries are intentional:

- Existing first-touch records remain authoritative. The runtime does not
  rewrite them or manufacture a touch from a later visit.
- Stripe customer/checkout/subscription metadata and signed purchase previews
  carry equal Okou and VM0 aliases so old API and marketing consumers keep the
  same account decision. New internal readers normalize the pair once.
- PostHog event properties retain equal legacy aliases for existing reports.
  Marketing does the same for GA4 and Stripe `gdm_*` delivery metadata. Each
  event is still sent once with its original transaction and deduplication ID.

The existing brand-neutral database campaign/ad-group columns and the cookie,
session and conversion-deduplication storage keys stay in place. The companion
`vm0-ai/vm0-marketing` registry change uses its already-deployed normalization
of URL/Clerk/Stripe inputs to Okou names and retains the same provider payloads. Either repository can deploy first
against the currently deployed alias-aware predecessor.

The alias-aware API reader from #33149 (`a222108b4eccfdab77fa3f6f3c08fa6ea2bdfac7`)
is an ancestor of the enforced production rollback floor
`669d0befc9a181e44e3f1f9e39093efddabcc0f8`. Release
[`826d131351049b7f35f45cad577618e01b231544`](https://github.com/vm0-ai/vm0/actions/runs/34794788803)
promoted the production API successfully on 2026-09-14 at 01:11:42 UTC and App
at 01:13:20 UTC. Thus serving and permitted rollback APIs already accept both
campaign/ad-group spellings; no client floor or rollback setting is changed.

Marketing's alias-aware reader from #676
(`5877e98af09ac8ae4b6596615ffead32ab5f60e8`) is included in release
`c7d04e7d7980f807826ab58439bf7229991e5918`.
[Production deployment](https://github.com/vm0-ai/vm0-marketing/actions/runs/34804958741)
completed on 2026-09-14 at 04:13:40 UTC. Marketing rollbacks must retain that
reader after canonical-only Clerk writes begin. Its workflow allows selecting
a commit explicitly; this is an operator prerequisite, not an enforced floor.

Remove Stripe/analytics
aliases after all readers, report dimensions and recovery tools have migrated.
Retire old input readers only after their supported clients/links and persisted
records have been migrated or explicitly retired. Record each gate under #33059;
merging these PRs alone does not complete that issue's historical-data cleanup.
Use [operation 016](../turbo/packages/db/scripts/migrations/016-okou-attribution/README.md)
for the stable census, bounded additive backfill, and full reconciliation.

## Remaining field inventory

| Current field or storage key                                                                     | Target / disposition                                                       | Compatibility and cleanup condition                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vm0_campaign_id`, `vm0_ad_group_id`                                                             | `okou_campaign_id`, `okou_ad_group_id`                                     | New requests/Clerk writes are canonical. Keep old inputs for historical links, cached clients and stored records; retire after their census and explicit retirement.                                                                        |
| Stripe/GA4/PostHog `vm0_campaign_id`, `vm0_ad_group_id`; invoice `gdm_vm0_*`                     | Equal canonical aliases, including `gdm_okou_*`                            | Keep dual properties on the same event/receipt until report dimensions and recovery readers migrate; never emit a second conversion.                                                                                                        |
| `vm0_source`                                                                                     | `okou_source`                                                              | Still written/read by landing/auth capture, the strict attribution API/Clerk schema and analytics. Prepare readers for the target first; activate new writers/backfill only after old strict API readers and rollback targets are excluded. |
| `vm0_experiment`, `vm0_variant`                                                                  | `okou_experiment`, `okou_variant`                                          | Same reader-first gate as source; preserve original experiment identity and values. Campaign/ad-group acceptance alone does not make these new keys safe.                                                                                   |
| `vm0_attribution`, `vm0.adAttribution`, existing conversion delivery markers                     | Keep opaque storage identities during this migration                       | Retire only after supported browsers/marketing readers migrate and cookie/session lifetimes and conversion deduplication history are reconciled.                                                                                            |
| `org_metadata.acquisition_*`                                                                     | Existing brand-neutral columns, including `acquisition_first_party_source` | No cosmetic schema rename or rewrite. Operation 016 checks all attribution values read-only.                                                                                                                                                |
| Archived SQL/scripts, published links, historical analytics and provider-owned billing snapshots | Historical evidence                                                        | Do not rewrite immutable history or manufacture a new first touch. Keep compatible input readers while that history is supported.                                                                                                           |

This inventory defines the related field targets without enabling incompatible
source/experiment writers. Their strict-reader preparation is a distinct
rollout requirement; a campaign ID backfill does not satisfy it.

## Verified campaign registry

The two additional campaigns `24239997272` and `24240467199` were verified on
2026-09-14 from Google Ads `campaign.resource_name` under customer `7935750692`.
Both repositories register that ownership so the existing account-specific
browser/offline actions can be selected. Pending events within the existing
cron lookback can retry normally; already-submitted events remain deduplicated.
Older historical recovery retains its separate original-event and
deduplication checks below.

## Conversion behavior

Signed-in onboarding and checkout events resolve ownership through
`POST /api/attribution/google-ads-account`. A saved Clerk first touch is
authoritative, including an unresolved or malformed saved touch. The request's
captured attribution is used only when no first touch has been saved. Signup
uses the account returned by the existing signup attribution endpoint.

| Event                                    | Customer 1001302527                   | Customer 7935750692                                  |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| Signup, onboarding start, checkout start | Its own website action                | Its own website action                               |
| Paid invoice, product milestone          | Existing offline UPLOAD_CLICKS action | Its own website action and existing offline fallback |

Paid responses resolve the invoice's attribution snapshot as a whole. Only an
invoice without advertising attribution can use the organization's saved
acquisition campaign. An invoice click without a campaign cannot borrow the
organization's campaign. The API omits the optional browser paid payload unless
the resolved customer is 7935750692; milestone responses likewise return no
browser milestones for other or unresolved customers. This also prevents
already-open older clients from firing those new-account actions.

New clients require the account decision before firing a website conversion.
Unresolved attempts do not advance delivery markers. The existing milestone
baseline policy remains: events already earned on a browser's first resolved
sync are historical, and historical recovery uses the offline path. Existing
transaction IDs and per-action browser deduplication keys are preserved.

The new response fields are optional so older API responses remain readable.
A new client receiving an old response or a 404 from the new resolver withholds
the conversion. Old clients still accept the existing request and response
shapes. Already-open older clients retain their old signup/onboarding/checkout
JavaScript until refreshed; no force-upgrade floor is changed in this patch.

Historical recovery is a separate controlled operation. Reconcile original
clicks, event times and prior delivery evidence; preserve the original transaction
ID and send only to its confirmed account/action. API acceptance is not proof
that Google ultimately attributed the conversion. Persist the request receipt
and check the Data Manager processing status. Neither this code change nor a
browser refresh replays historical conversions automatically.
