# Database trigger retirement

Issue [#33747](https://github.com/vm0-ai/vm0/issues/33747) tracks the complete
nine-trigger migration plan, domain-specific concurrency requirements, and
release evidence. Preparation changes do not authorize trigger removal.

## Organization entitlement preparation

`org-plan-entitlements.service.ts` owns the explicit write operations:

- `ensureOrgMetadataPlanEntitlement(tx, metadata)` fills an absent entitlement
  from the metadata row returned by a database write. It preserves the existing
  entitlement on an organization-key conflict, including manual capabilities,
  source metadata, and timestamps. Known tiers retain the historical
  `org_metadata_migration` defaults; unknown legacy tiers remain untouched.
- `writeOrgMetadataWithDefaultPlanEntitlement(tx, orgId, write)` locks an
  existing metadata row before an upsert and applies the insert-only bootstrap
  effect only when metadata did not already exist. Ordinary updates keep a
  pre-existing missing-entitlement invariant visible instead of silently
  repairing it. The original atomic conflict update still owns credit changes.
- `upsertOrgPlanEntitlement(tx, args)` explicitly replaces a managed plan
  snapshot when a billing or bootstrap operation intends to change the plan.
  Its tier values already include the managed-source credit-purchase rule.

The ensure and managed upsert operations explicitly derive the physical
`member_invitation_allowed`
compatibility value from the same status normalization used by current API
admission. The companion update runs under the preceding entitlement write's
row lock. It is not a configurable invitation capability. Canonical inserts
continue to omit that legacy column; column retirement belongs to #32575.

Metadata writes and their entitlement operation must share a transaction.
Pass the **returned** `orgId` and `tier`, not the attempted insert values: a
database default or conflict update can select a different tier. Retrying an
ensure operation never replaces an existing entitlement. A conditional write
that returns no rows performs no companion operation.

### Writer inventory

Paths below are relative to `turbo/apps/api/src/signals/`.

| Writer                                           | Transaction and behavior                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/billing-customer.service.ts`           | Retains the Stripe customer advisory lock and completes metadata/entitlement writes before committing.                                                      |
| `services/credit-usage.service.ts`               | Uses the existing credit settlement transaction and actual returned tier.                                                                                   |
| `services/onboarding-credit-grants.service.ts`   | Keeps the idempotent grant, credit balance, and entitlement in the caller's transaction.                                                                    |
| `services/webhooks-stripe.service.ts`            | Covers credit grants, Atom metadata admission, and Clerk organization/customer binding. Existing plan-changing paths still use the explicit managed writer. |
| `services/cli-auth.service.ts`                   | Completes test-organization metadata and its absent entitlement in one transaction.                                                                         |
| `services/onboarding.service.ts`                 | Completes the conditional onboarding metadata write and its entitlement together.                                                                           |
| `services/acquisition-attribution.service.ts`    | Completes first-touch metadata creation and its entitlement together; retains the conditional first-touch update.                                           |
| `services/impact-attribution.service.ts`         | Completes the conditional latest-click metadata upsert and its entitlement together.                                                                        |
| `routes/billing-credit-checkout.ts`              | Completes metadata creation before continuing to the existing auto-recharge operation.                                                                      |
| `services/org-limited-free-bootstrap.service.ts` | Already explicitly writes both rows through `writeOrgMetadataWithPlanEntitlements`; keeps the intentional bootstrap plan change.                            |
| Billing/webhook/cron plan changes                | Continue using `upsertOrgPlanEntitlement`; status-only changes also update the legacy invitation mirror.                                                    |

Current test setup routes for usage, credit settlement, Slack, Teams, Telegram,
cron cleanup, billing reconciliation, and the chat-thread benchmark explicitly
complete their metadata writes. `upsertOrgMetadataFixture` already writes the
managed entitlement. Deliberately divergent entitlement fixtures explicitly
maintain the status-derived invitation value.

`insertOrgMetadataAsLegacyWriterFixture`,
`updateOrgPlanKeyAsLegacyWriterFixture`, and the frozen migration compatibility
fixtures intentionally simulate old writers. They continue to exercise the
retained triggers during preparation; retire those expectations only after
the corresponding serving/rollback gate passes.

### Repair and backfill writes

The numbered `005-backfill-clerk-metadata` script is a historical migration,
including its original Clerk field mappings and trigger-dependent write
contract. Preserve the script; it is not the current production repair entry
point.

A current repair must live in the API service boundary and explicitly call
`ensureOrgMetadataPlanEntitlement` in the metadata mutation's transaction, with
the returned row. A deliberate managed plan correction must instead call
`upsertOrgPlanEntitlement`. Inventory the targeted rows and intended source
before executing a repair; direct metadata SQL alone will no longer produce
entitlements after trigger retirement. No production repair is performed by
this preparation change.

## Compatibility and removal gate

All three organization-entitlement triggers remain installed during this
preparation release. An existing trigger can create the row before the API
ensure runs; `ON CONFLICT DO NOTHING` preserves it. Explicit invitation writes
agree with the installed trigger's derivation and do not reapply grants or
overwrite a manual entitlement.

The compatibility tests use private schemas with actual PostgreSQL constraints
and either the installed legacy triggers or no entitlement triggers. They
exercise all tiers, managed sources, status changes, preservation, rollback,
retry, and a verified blocked concurrent writer. Shared/public triggers are
never disabled by the tests. Full route suites run in the PR pipeline.

Production migrations precede API promotion. Before shipping a new migration
that removes these triggers, record the prepared serving/background artifacts,
the oldest supported rollback artifact, and proof that all relevant writers
have migrated. A merge alone is not deployment evidence. After removal, an
application rollback must target a prepared artifact; it does not recreate the
database triggers. Keep the legacy invitation column until its separate
consumer retirement gate passes.

The purchase, OAuth, hosting, and privacy work packages remain tracked in
#33747. In particular, [the privacy implementation rollback](marketing-privacy-choices.md)
retains shipped privacy data and triggers while the replacement design is
reconsidered. Entitlement preparation does not resume that withdrawn feature.
