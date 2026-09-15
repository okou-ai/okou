# Database trigger retirement

Issue [#33747](https://github.com/vm0-ai/vm0/issues/33747) tracks the complete
nine-trigger migration plan, domain-specific concurrency requirements, and
release evidence. A–D preparation shipped before migration `1132`; the sections
below retain the writer and repair contracts established by those releases.

## A-D contraction: migration 1132

`1132_retire_prepared_domain_triggers` removes exactly the eight A–D triggers
and eight functions. It retains E's `marketing_privacy_withdrawal` trigger,
ordinary constraints, indexes, pending guards, and both legacy invitation
columns. The withdrawn privacy feature stays withdrawn. This is part of
#33747; it does not complete all nine behaviors or #32575's column cleanup.

The verified rollback artifact is **API 1.600.1**, tag `api-v1.600.1`, at
`eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`. Its
[promotion log](https://github.com/vm0-ai/vm0/actions/runs/34915532910/job/104212801721)
records that checkout, build version and `api.vm0.ai` alias at
**2026-09-15 01:07:30 UTC**. A bounded Vercel read found exactly one READY
production deployment for that SHA, `dpl_FFSpvSwiDJXUAZ73dswXhMr51jjP`.
The **2026-09-15 02:56–02:57 UTC** alias/deployment read resolved `api.vm0.ai`
to READY deployment
`dpl_9ZpnkRGxSvqExXz6jr6m1GwgNrKm`, **API 1.601.0** at
`3ace38cfefa54eb9df33715131a3ee8be1be3c27`, a verified descendant of the floor.
All four preparation merge commits are ancestors of both artifacts. Billing
reconciliation and cleanup crons are routes in the same API build, as are
Stripe/Clerk webhooks; the writer inventory below contains no independent
background database writer to upgrade. Historical numbered scripts are not
supported current repair entry points.

The rollback resolver now requires the verified API 1.600.1 release as an
ancestor, including the canonical-only invitation mapping. The previous floor
`6e1abbb785dc1613d0f5cd1b1dd80fae694abb46` contained A/B but excluded C/D.
The rollback workflow checks out current `main`, so an old target cannot
replace this guard. API rollback does not restore triggers; earlier artifacts
require a separately reviewed schema restoration and reconciliation.

Migration 1132 takes table locks in billing-root → pending-guard → organization
metadata → entitlement → connector-parent → OAuth-config → site → deployment
order. It does not take row/advisory locks after those table locks. The audit
is a separate statement under READ COMMITTED, so it observes committed writers
that finished before the lock was granted. The runner's **1 second lock / 10
second statement** limits remain unchanged; a timeout rolls back every drop.

Before deletion it checks exact trigger definitions/enabled state and function
identity/body/configuration, known-tier metadata entitlement presence, managed
credit capability, OAuth pairs/orphans, requested slugs, deployment organization
ownership, and exact pending guard counts. Manual entitlements and grandfathered
pending roots are preserved. It does not compare historical site ownership to
mutable/deleted run metadata: ownership deliberately survives run/thread cleanup.
No data correction, cancellation, repair or backfill happens in this migration.
Unknown catalog drift, bad data, dependencies or a journal failure abort the
whole transaction. Drops use RESTRICT, with no CASCADE or replacement trigger.

The existing production release first runs migrations on its production smoke
clone, then on production before API promotion. Both executions must succeed.
The content-free `prepared_domain_trigger_retirement_v1` receipt identifies
counts and audit results. A notice alone is **not committed evidence**: require
the production journal insertion and `Migrations complete`, separately from
smoke-clone success. This PR does not claim that production contraction ran.

The bounded MaskDB read on **2026-09-15 02:48 UTC** found **6,812** metadata
organizations created by **02:47:36 UTC**, all with entitlements; the cutoff
count was unchanged after scanning. MaskDB still exposes neither the pending
roots/guards, OAuth configs nor PostgreSQL catalogs, and does not expose
`can_buy_credits`. This is limited presence evidence, not a complete production
invariant proof. The migration's locked checks provide the missing release-time
precondition and fail closed instead of inferring success from inaccessible data.

The [combined preparation evidence](https://github.com/vm0-ai/vm0/issues/33747#issuecomment-5666495664)
records direct persisted-state comparisons on main `3c8b18e`, all-eight-absent
route checks, and retained/outgoing controls. Current private API suites load
legacy function definitions from immutable 1078/1098 SQL into their owned
schemas; they remain valid after public functions disappear. Current route
suites use the fully contracted database. Retired outgoing-only route fixtures
are removed; retained private controls stay through the 1132 transition.
The 1132 verification based on main `de87aa7c0e75df187eecfdf8c14b90b0bde5fe0f`
passed the same 795 cases across 26 current API route files on each schema,
with none skipped, plus 230 private compatibility cases. Post-route counts and
invariants match; the existing entitlement-only teardown fixture leaves one
missing entitlement on each schema and is recorded separately from writer
creation behavior. All seven other audited invariant counts are zero.
`test-prepared-domain-trigger-retirement.ts` verifies actual migration/journal
atomicity, unchanged data/constraints/privacy, grandfathered roots, audit
rejections, a fresh snapshot after a blocked writer, timeout and retry. A
synthetic 10,000 organizations/roots/connectors/sites plus 20,000 deployments
completed the migration in 69 ms on PostgreSQL 17.10 with the default limits;
this is bounded local load evidence, not a production timing prediction.
After merging main `4a60b74daa3cba9e11fdb6a072fa989dd1a242d3`, the expanded
migration-consistency chain, including the independent historical blob audit,
passed with the unchanged 1132 SQL. All 230 private compatibility cases and
329 cases in five affected billing, lifecycle and chat route files passed on
each schema. Their scenario results, persisted projections and invariant counts
match. The 26-file matrix above remains evidence for its recorded prior base.

After main `9d3e9f181a3b86c2c215bd15549eeee84b10bd69` added the independent
erasure-journal check, both validators remain registered. Its journal test,
all 19 retirement scenarios, permanent schema checks and 230 private cases
passed. The hosting slug-helper extraction was also verified with the same
13 API cases on each schema; their persisted state matches and all eight
audited invariant counts are zero. Earlier broader matrices retain their
recorded bases.

Retire transition controls only after the production journal, completed compatibility cycle and permanent surviving
coverage satisfy `turbo/packages/db/MIGRATIONS.md`.

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

Both operations use the canonical runtime entitlement mapping introduced by
#33909. Current invitation admission derives from normalized `status`; neither
operation names or mirrors either legacy invitation column. Migration 1132
removes the status-mirror trigger without an API mirror;
#32575 retains ownership of the two physical columns and client cleanup.

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
| Billing/webhook/cron plan changes                | Continue using `upsertOrgPlanEntitlement`; current invitation admission derives from normalized status.                                                     |

Current test setup routes for usage, credit settlement, Slack, Teams, Telegram,
cron cleanup, billing reconciliation, and the chat-thread benchmark explicitly
complete their metadata writes. `upsertOrgMetadataFixture` already writes the
managed entitlement. Deliberately divergent entitlement fixtures use the same
canonical runtime mapping and explicit status.

The frozen private-schema compatibility fixtures still simulate old writers.
The current-route-only legacy metadata/plan fixtures are retired with 1132.

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

All three organization-entitlement triggers were retained during preparation
and are removed together by 1132. An existing trigger can create the row
before the API ensure runs; `ON CONFLICT DO NOTHING` preserves it without reapplying grants or
overwriting a manual entitlement. During preparation the retained invitation
trigger served outgoing API statements; current API writers do not depend on it.

The compatibility tests use private schemas with actual PostgreSQL constraints
on the retained schema, without entitlement triggers, and after dropping both
legacy invitation columns. They exercise all tiers, managed sources, status
changes, preservation, rollback,
retry, and a verified blocked concurrent writer. Shared/public triggers are
never disabled by the tests. Full route suites run in the PR pipeline.

The 1132 release boundary above records the prepared artifact and enforced
rollback floor. Production migration/journal completion remains a release gate;
application rollback does not recreate triggers. The two physical invitation
columns and remaining client cleanup stay with the
[invitation contraction gate](deployment-compatibility.md#invitation-and-free-member-contract-cleanup-2026-09-14)
owned by #32575.

The purchase, OAuth, hosting, and privacy work packages remain tracked in
#33747. In particular, [the privacy implementation rollback](marketing-privacy-choices.md)
retains shipped privacy data and triggers while the replacement design is
reconsidered. Entitlement preparation does not resume that withdrawn feature.

## Custom connector OAuth preparation

`custom-connector-oauth-write.service.ts` owns
`writeCustomConnectorOAuthState(tx, identities, write)`. Production creation,
update and repair complete mode/config writes inside this operation and the
caller's transaction. The operation
locks existing parent connectors in ascending `(id, org_id)` order before the
callback writes either table. Newly created parents are protected by their
insert and ordinary primary/foreign keys.

After the callback completes, it reads each surviving parent's final mode and
config together: `oauth` requires one config, and `none`, `manual`, and
`automatic` require none. The config primary key already enforces at most one
row. A failure must escape the owning transaction so all definition, config,
and companion writes roll back. Do not catch an invariant failure and commit,
or change a checked mode/config later in that transaction. Legal intermediate
states remain possible, including changing the mode before inserting or
removing its config.

### OAuth writer inventory

Paths below are relative to `turbo/apps/api/src/signals/`.

| Writer                                                                                      | Transaction and behavior                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/custom-connector.service.ts`                                                      | Create and update complete skill storage, definition and OAuth config writes in the existing transaction. Update retains its optimistic version/timestamp check and parent row lock before the shared operation. Existing automatic OAuth registration cleanup and post-commit runtime publication keep their owners. |
| `services/feishu-custom-connector.service.ts`                                               | Both Feishu and Lark creation/repair use the shared operation. Lock order remains installation advisory lock, installation row, then parent connector; the final installation association stays in the same transaction.                                                                                              |
| Generic deletion, Feishu/Lark removal, `services/connector-owner-cleanup.service.ts`        | Parent deletion atomically removes its OAuth config through the ordinary composite foreign key's `ON DELETE CASCADE`. This remains a database constraint; there is no business-trigger cleanup effect to replace.                                                                                                     |
| `routes/test-connector-credential-storage-state.ts`                                         | The automatic OAuth and runtime batch fixtures insert new `automatic` or `manual` parents without an organization OAuth config. These are consistent by construction and do not rely on either trigger.                                                                                                               |
| `routes/test-runtime-state.ts`, `routes/test-custom-connector-skill-version-association.ts` | Existing fixtures change only injection templates or skill references, preserving mode and config ownership.                                                                                                                                                                                                          |
| Numbered `013-kms-account-rotation` script                                                  | Re-encrypts an existing config secret without changing its mode, connector key or organization key. It preserves the relationship and is a historical migration, not a mode/config repair entry point.                                                                                                                |

Member OAuth tokens, connector accounts, and automatic OAuth DCR registrations
are distinct from the organization OAuth application config. Their existing
credential and authorization operations remain authoritative.

### OAuth repair and compatibility contract

A repair or config-key move must pass **both old and new** `(connectorId, orgId)`
identities to one shared operation, before taking individual parent/config
locks. Complete both final pairs inside the callback. The final check covers
both keys even when a config moves across organizations; the ordinary composite
foreign key still rejects a mismatched organization. There is no public API for
moving configs. New repair/backfill writers must use this transaction contract,
rather than issue standalone SQL that relied on deferred triggers.

Both OAuth triggers and their functions were retained during preparation and
are removed by 1132. They only validated, so they coexisted with the explicit
API operation without duplicate side effects. Outgoing generic and Feishu/Lark
writers already lock the parent before config changes and can coexist with the prepared writer.

The compatibility suite uses private schemas with the shipped checks, unique
keys, composite config foreign key, and either retained or absent OAuth
triggers. It covers all modes, replacement/retry, invalid final states, caller
rollback, old/new config keys, cascaded deletion, ownership constraints, and
actual blocked concurrent prepared/outgoing writers. It never disables shared
triggers. Product behavior remains covered by generic connector, Feishu and
Lark API route suites.

The 1132 contraction uses the recorded prepared serving/background artifact
and enforced rollback floor above. New writers and repairs must retain this
explicit transaction contract after physical removal.

## Hosted-site ownership preparation

`hosted-site-scope.service.ts` owns the explicit counterparts of
`canonicalize_hosted_site_scope_0753` and
`enforce_hosted_deployment_scope_0753`:

- `lockHostedRunChatThreadId(tx, runId)` reads the current run under `FOR SHARE`.
  Missing runs, absent IDs, null `trigger_source`, and null chat IDs retain null
  ownership. Runs without trigger metadata are still locked, so a concurrent
  metadata update cannot change their ownership during admission. Historical
  text references retain the trigger's exact `id::text` comparison semantics;
  canonical UUIDs use the primary-key lookup rather than a cast on the column.
- `canonicalizeHostedSiteScope(tx, values, existingSiteId?)` fills a null
  requested slug from `slug` and a null owner from the originating run. Explicit
  values, including an empty requested slug, are preserved. Updates/repairs
  supply the complete intended scope and the existing site ID. The operation
  locks that organization's site and rejects clearing or moving an established
  owner **before** applying the derived owner. Write its returned columns in
  the same transaction; an ordinary update of unrelated columns needs no
  canonicalization.
- `assertHostedDeploymentScope(tx, args)` locks the run and the site, scoped by
  organization, and compares their final ownership, including null. It must
  precede deployment insertion in the same transaction. Scope errors escape
  the transaction before the route converts them to an HTTP conflict.

### Hosting writer and lock inventory

Paths below are relative to `turbo/apps/api/src/` unless stated otherwise.

| Writer                                                           | Transaction and behavior                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signals/services/host.service.ts`: prepare/allocation           | `createHostedSiteDeployment` locks the run before selecting/locking or creating a site. It performs the unscoped-site conflict check, canonical creation, version allocation, final admission and deployment insert in one transaction. Public and private deployments share the ownership check. |
| `signals/services/host.service.ts`: completion/promotion         | Retains the existing site row lock and updates only deployment status and active-version fields. It does not change ownership, requested slug or originating run. Existing completion authorization and chat checks remain in place.                                                              |
| `signals/routes/test-cron-cleanup-sandboxes-state.ts`            | Current setup explicitly canonicalizes site ownership and admits its deployment in one transaction. Its teardown deletes only the owned site; ordinary foreign keys cascade deployments.                                                                                                          |
| `test-fixtures/hosted-sites.ts`                                  | The historical VM0-brand fixture explicitly writes its requested slug and has no originating run/chat owner. It is already independent of the two triggers.                                                                                                                                       |
| `signals/routes/test-runtime-state.ts`                           | The two hosted `*-as-previous-api` operations are removed with 1132. Historical writer controls remain in the private compatibility suite.                                                                                                                                                        |
| `turbo/packages/db/scripts/test-migration-consistency-schema.ts` | Checks the contracted trigger/function inventory and surviving ordinary constraints; the API owns current business behavior.                                                                                                                                                                      |
| Numbered `014-public-artifact-registration` backfill             | Reads sites/deployments for artifact registration; it does not write their ownership. Preserve this historical migration.                                                                                                                                                                         |

Acquire run row locks before site row locks. Allocation uses `FOR UPDATE` on
an existing site; standalone admission uses `FOR SHARE`. Both prevent a
concurrent non-key ownership update, whereas `FOR KEY SHARE` would not.
Allocation's unique indexes and `ON CONFLICT DO NOTHING` still arbitrate new
site/public-slug races. The run lock is retained when an outgoing allocator
already holds the site lock. Promotion takes only its existing site lock and
does not subsequently write run metadata. No thread-row lock or new foreign
key is added: the stored chat ID must survive deletion of its originating
thread or run.

Prepared requests perform one additional site read for final admission. A
canonical run reference also adds an admission run read; a newly created site
whose run has null ownership additionally resolves its canonical scope. These
are awaited within the existing transaction, with primary-key run/site
lookups. Runless requests add no run queries. The preparation changes neither
the public-slug retry bound nor the existing organization/public versus
user/private authorization rules.

### Hosting repair and removal gate

There is no current product endpoint that moves site ownership. A repair must
inventory the site's existing deployments and intended complete scope, acquire
all referenced run locks before site locks (sort IDs when repairing multiple
rows), then use the canonicalizer with the existing site ID and persist its
result in that transaction. Do not clear a non-null owner to force adoption.
Creating a deployment uses the explicit admission operation in the same
transaction; do not catch a failed admission and commit the allocation.
Run/chat cleanup preserves the denormalized site owner. Direct SQL that relied
on either trigger is not a supported repair path after contraction.

The private PostgreSQL suite uses shipped site/deployment constraints and
retained or absent hosting triggers, without changing shared/public triggers.
It exercises canonical/null semantics, immutable ownership, explicit repair,
cross-chat rejection, actual allocation transactions, concurrent versions,
public/private behavior, insertion failure and retry, and run/site row locks.
API route coverage exercises site reuse, chat isolation, organization-site
adoption rejection, completion permissions, public/private workflows and
concurrent prepares. The previous-API control remains in its private retained
schema; a trigger-dependent writer is unsupported after contraction.

Both hosting triggers/functions coexisted with prepared values during the
preparation releases and are removed by 1132. Historical writer controls stay
in private schemas; current-route legacy fixtures are retired. The exact
remaining catalog is checked by migration consistency. API rollback does not
restore database triggers.

## Pending usage-pack purchase preparation

`usage-pack-pending-snapshot.service.ts:writeUsagePackPendingSnapshots` owns
subscription mutations and the explicit counterpart of
`sync_usage_pack_pending_snapshot_guard_0954`. Its callback and guard writes
commit together. It preserves the two pending statuses (`checkout_pending`,
`purchase_pending`), rejects a newly pending purchase when another remains,
and releases the guard for any transition out of that set or a deletion.
Changing between the two pending statuses is idempotent. Existing competing
pre-0954 snapshots retain their exact count; retaining or retiring those rows
does not admit an additional pending purchase.

### Pending writer inventory

Paths below are relative to `turbo/apps/api/src/` unless stated otherwise.

| Writer                                                                                                             | Transaction and companion behavior                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signals/services/usage-pack-subscription.service.ts`: prepare, serialized Checkout and saved-card preview/confirm | The explicit operation replaces the existing purchase transaction boundary. Resolution retires unwanted/expired snapshots before creating a replacement; the root, allocations, Stripe correlation and final guard stay atomic. Existing Stripe idempotency keys, retry/redirect decisions and cancellation ownership remain.                                             |
| Same service: synchronization, invalidation, deletion, plan activation and invoice fulfillment                     | Checkout/subscription/invoice webhooks enter these operations through `webhooks-stripe.service.ts`. All status changes release/maintain the guard in the same transaction as allocation, credit and organization projections. Fulfillment retains its existing outer usage-pack billing lock before entering the pending operation. Repeated events keep the final count. |
| Same service: reconciliation                                                                                       | `cron-billing-entitlements.service.ts` enters the same lifecycle writers. Both uncorrelated stale snapshots and expired Checkout Sessions retire through the explicit operation. Per-candidate failure handling and scoped test cron selection remain unchanged.                                                                                                          |
| `signals/services/usage-pack-subscription-migration.service.ts:materializeUsagePackSnapshot`                       | Keeps its outer usage-pack billing lock, then enters the pending operation before locking the migration and materializing the root/allocations. Stripe-derived non-pending subscriptions leave a zero guard.                                                                                                                                                              |
| `signals/services/usage-pack-allocation-change.service.ts`                                                         | Its only direct root update changes `cancelAtPeriodEnd`/`updatedAt`; neither triggers pending effects. Allocation/plan/invitation changes otherwise read roots and write their own ledgers. Subsequent Stripe lifecycle status changes use the explicit writer above.                                                                                                     |
| `signals/services/usage-pack-plan-change.service.ts`, `usage-pack-invitation-purchase.service.ts`                  | Read subscription roots; do not insert/delete them or change their organization/status. Existing usage-pack billing serialization is retained.                                                                                                                                                                                                                            |
| `signals/services/org-deletion-billing.service.ts`                                                                 | Reads billing correlations to cancel Stripe objects. It does not delete local roots; cancellation callbacks/reconciliation use the explicit lifecycle writer. Roots have no organization foreign key and do not disappear through an organization cascade. Preserve existing billing retention.                                                                           |
| `signals/routes/test-usage-pack-subscription-state.ts`                                                             | Current seed and both root cleanup operations use the explicit boundary. Timestamp/legacy Checkout correlation actions change neither status nor organization. The explicitly named pre-serialization fixture deliberately reconstructs historical competing roots and calls the explicit repair operation. It is fixture-owned setup, not a current admission path.      |
| `signals/routes/test-billing-reconciliation-state.ts`                                                              | Setup and cleanup lock their complete, uniquely owned organization set before writing any root, allocation or organization metadata. Guard release is part of cleanup.                                                                                                                                                                                                    |
| `turbo/packages/db/scripts/test-migration-consistency-schema.ts`                                                   | Checks contracted inventory and permanent guard uniqueness/range. Private API suites own pending behavior and historical writer controls. No current numbered external-data migration writes these roots. Shipped migrations and historical numbered scripts remain unchanged.                                                                                            |

There is no current product/admin endpoint for moving a root to another
organization or physically deleting it. A new administrative writer must use
the explicit operation and its complete old/new organization scope, and update
any related allocation/ledger ownership under its own reviewed business rules.
This preparation does not introduce such an endpoint or move existing data.

### Lock order and old/new writer protocol

1. If the caller already needs the `usage_pack_billing:<org>` advisory lock,
   acquire all needed organization locks in sorted order first. Never acquire
   this lock inside a pending callback.
2. Acquire `billing_purchase:<org>` advisory transaction locks for every
   affected organization in sorted, deduplicated order. Current outgoing
   purchase creation already shares this lock.
3. Lock all existing subscription roots for those organizations with
   `FOR UPDATE`, ordered by root ID, before touching a guard. This includes
   multiple grandfathered roots. IDs loaded before the transaction are also
   locked and their organization scope is rechecked before taking any guard;
   a stale lifecycle callback cannot update a root moved to another organization.
   Checkout confirmation selects its root with both ID and organization predicates.
   Outgoing terminal writers take a root lock
   before their AFTER trigger takes its guard lock, so prepared writers must
   not reverse that order.
4. Ensure guard rows exist, then lock guards in sorted organization order.
   Read the current roots/counts under these locks. A mismatched persisted
   count fails the transaction and requires explicit repair.
5. Execute the awaited callback. Every root it writes must belong to the
   declared organization set; include both organizations for a move and use
   scoped predicates. Retire replaced purchases before inserting their
   replacement. Acquire allocation, migration, fulfillment and organization
   metadata locks only after entering this boundary.
6. Read the final pending identities, validate admission (including movement
   into another organization), and **assign** the exact final guard count.
   Do not increment/decrement in API code. The retained trigger may already
   have performed its original effects; assigning the same final count is
   idempotent. There is no trigger-presence probe selecting an effect owner.

Pending-to-pending updates preserve an established root, including
pre-0954 duplicates. New pending identities are allowed only when no competing
pending root remains. All API callbacks retain their existing mutation order;
they do not create a competing pending root and then discard it to bypass
admission. A failed callback, conflict, validation failure or commit failure rolls back
both primary and guard writes. Do not catch a failed admission and commit the
surrounding transaction. The operation can use an existing transaction through
a savepoint, but must enter before that transaction takes subordinate row locks.
Direct historical SQL and pre-0954 writers without the shared purchase
serialization are not new supported administrative interfaces.

For one organization, this boundary executes seven queries around the callback:
one advisory lock, one ordered root lock, guard creation/lock, the initial root
read, the final root read, and count assignment. This excludes transaction
control; fulfillment and migration add a savepoint pair inside their existing
outer transaction. Existing purchase transactions already performed the advisory lock. Multi-organization operations
add four queries per additional organization. The organization index bounds
root scans; all existing roots are deliberately locked so a batch retirement
cannot take a guard before a later root. Slow Stripe work retains these locks
until its existing transaction completes. Keep external retry and network
bounds intact; measure representative organization histories before contraction.

`usagePackPurchaseSerializationSchemaAvailable` now checks the relations used
by the writer, the valid/ready unique organization guard index, its indexed
column, the non-null integer count and validated count constraint. It follows
the writer's search path and no longer requires a trigger or function. Removing
just the trigger/function therefore does not disable Checkout.

### Pending repair, verification and removal gate

Use `repairUsagePackPendingSnapshotGuards(db, orgIds)` for an explicitly scoped
repair/backfill. It uses the same organization/root/guard lock order and
reconstructs counts from actual pending rows, preserving grandfathered
purchases. It does not cancel purchases or silently pick a winner. Review the
intended organization set and billing correlations before calling it; use
bounded batches without pre-acquiring subordinate locks. Never reset a live
guard to zero to force a purchase through. Keep raw historical fixtures and
permanent migrations as evidence, not executable current repair instructions.

The private PostgreSQL suite exercises retained/absent triggers, guard/index
prerequisites, admission, duplicate requests, all terminal releases, deletion,
rollback, grandfathered rows, repair, organization movement and deterministic
blocked prepared/outgoing transactions. API route coverage exercises Checkout,
saved-card confirmation, webhook/invoice processing, migration, scoped billing
cron and cleanup. A cron-expired snapshot must permit a subsequent real
Checkout request. Run the same routes in isolated UTC databases with the
trigger retained and with only this trigger/function absent; never drop shared
suite triggers to select a test mode.

Migration 1132 removes the shipped trigger/function and retains the guard
table, unique index and count constraint. Its release record must include the
prepared immutable API artifacts serving requests and background jobs, the oldest supported rollback artifact, fresh writer inventory, guard
reconciliation evidence and this compatibility matrix in #33747. Every
serving/background/rollback writer must use the explicit operation. Keep the
guard/index after contraction. A source audit or merged preparation PR is not
proof that the serving/rollback gate passed. Rolling back below the prepared
floor after contraction requires a separately reviewed schema restoration and
reconciliation; application rollback does not recreate a trigger. The
contraction PR does not itself run production migration or continuous
deployment observation, and does not resume marketing privacy functionality.
