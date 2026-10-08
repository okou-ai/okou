# Database Migrations

Generate migrations with `pnpm -F @okouai/db db:generate` and verify them with
`pnpm -F @okouai/db test:migration-consistency`. Do not edit an existing migration
or snapshot after it has shipped.

Transactional migrations start with a `1s` `lock_timeout` and a `10s`
`statement_timeout`. A migration that needs more time may override either
default with a later `SET LOCAL` statement in that migration. Non-transactional
migrations do not receive these defaults and must manage their own timeout
requirements.

## PostgreSQL validation versions

Development and CI use PostgreSQL 17. The migration wrapper can also be run
against a disposable PostgreSQL 18 database with pgvector installed. Set
`DATABASE_URL` to that cluster, then run from `turbo`:

```bash
pnpm -F @okouai/db test:migration-consistency
```

PostgreSQL 18 reports `ON DELETE RESTRICT` violations as SQLSTATE `23001`
(`restrict_violation`), where PostgreSQL 17 reports `23503`
(`foreign_key_violation`). The SSH credential and Cloudflare Access migration
tests accept only these two codes for deleting referenced resources and require
the exact owner foreign-key constraint. Child ownership violations still require
`23503`; other constraint checks retain their exact SQLSTATE expectations.

## Transition validators

A transition validator protects an expand → contract rollout while old and new
application versions and data shapes may coexist. Delete one only after all
three event-based conditions are satisfied:

1. Its target migration has shipped in a production release. Confirm that the
   production `__drizzle_migrations.created_at` is greater than or equal to the
   migration's `when` value in `src/migrations/meta/_journal.json`.
2. The expand → contract cycle it covers is complete. The contract migration is
   deployed, and no dual-write or dual-read compatibility window remains.
3. Every invariant it asserts that still applies to the current schema has been
   promoted to the permanent tier of the migration consistency suite.

There is no time-based retention window. Elapsed time does not determine whether
a transition validator still protects a live rollout. The squash line advances
to the last migration in the most recent production release. When that removes a
referenced migration tag from the journal, the consistency suite fails and the
expired transition validator must be deleted.

### Retired invitation transition validators

The #32575 cleanup removes the invitation transition validators and frozen
outgoing API fixture after migration `1137_retire_legacy_invitation_columns`
from #34317 shipped in API 1.604.0 / App 0.900.0. The
[production receipt](../../../docs/deployment-compatibility.md#legacy-invitation-column-contraction-2026-09-15)
records release #34303, the real production migration completion at
2026-09-15 10:31:12.0275988 UTC, and the immutable runner/SQL evidence establishing
the committed journal frontier `1789460587817` and column contraction. It also
records current serving artifacts and the enforced canonical-only API rollback
floor. This is execution evidence, not a direct production journal SELECT. The
compatibility cycle is complete and the surviving coverage is permanent below.

`test-org-plan-entitlement-permanent.ts` exercises canonical
INSERT/UPSERT/SELECT/RETURNING, suspension/reactivation and explicit package
visibility for all managed entitlement sources. The schema consistency suite
runs it against both replayed historical migrations and a freshly generated
schema. It has no historical migration-tag or outgoing-schema dependency.
The runner suite retains generic timeout, retry and transactional journal
coverage; the exact current trigger/function inventory remains enforced.

`test-show-usage-pack-migration.ts` retains historical backfill and data
preservation coverage. Current API transaction tests retain corruption,
constraint-failure rollback and verified lock-contention cases. Billing status,
invitation and App page suites retain normalized status, Free invitations,
suspended direct/paid rejection, administrator authorization, reactivation and
explicit `showUsagePack: false` behavior.

### Retired chat event sequence transition validators (2026-09-25)

The chat event sequence bridge, backfill and routing-preparation validators are
retired. Migration `1236_contract_chat_event_sequence_bridge` shipped in API
1.676.0 (release #36823): the production migration job succeeded and
`chat_threads.last_chat_event_seq_id` is absent. The expand and contract cycle is
complete; no API that rollback can select writes the retired counter. The
permanent tier of `apps/api/scripts/chat-event-sequences/acceptance.ts` keeps
first-append initialization, concurrent and cross-thread batches, idempotent
conflicts, gaps, statement rollback, retention, event FK lock compatibility and
cascade cleanup against the current schema.

### Retired lock-driven validators (2026-09-26)

The marketing privacy retirement validator for migration 1139 was retired.
Production API 1.681.3 (`355e1acda73b`) includes the contraction; the
[production promotion job](https://github.com/okou-ai/okou/actions/runs/36211542983/job/108319416479)
completed both its migration smoke test and production migrations. Historical
SQL, generated-schema equivalence and the permanent trigger/function inventory
remain. The dedicated billing-attribution backfill validator was also removed
from CI; this does not certify production backfill completion or retire the
operator tool and its two documented reader fallbacks.

### Retired integration DM transition validator (2026-09-28)

`scripts/test-integration-dm-single-thread.ts` protected migration
`1279_integration_dm_single_thread_routes`. That migration shipped with release
7 (#37200, release #37237) and the release 7 API is the rollback floor. Migration
`1282_drop_retired_integration_agent_tables` contracts the cycle: it drops the
Feishu/Lark `default_agent_id` column that 1279 rebinds and the self-hosted
Telegram route owner that 1279 left in place, so 1279 can no longer replay on
the current table shapes. The validator asserted only the one-time route
consolidation and installation rebinding; the resulting canonical DM route keys
are enforced by the integration ingress tests.

### Active transition validators

- `scripts/test-usage-allowance-retirement.ts` protects migration
  `1345_drop_organization_usage_allowance`: positive team Allowance rows are
  discarded while ordinary usage quantities, original credit charges and wallets
  remain unchanged; lock timeout and journal failures roll back all DDL/data,
  new credit-only hourly writes work, and a completed retry is a no-op. The owner
  explicitly requested removal of team-only history and separately accepted the
  outgoing API's deployment-window errors, including external organizations'
  shared billing/usage paths, for this single-release contraction. The API/DB
  cutover is not rolling-compatible; migration precedes API promotion, and a
  failed promotion can extend the interruption. This design/risk acceptance is
  not authorization to execute a production rollout. The production rollback
  resolver enforces the canonical migration commit as its API floor, not a
  migration-to-promotion serving boundary. Keep the validator until the production contraction
  and serving/rollback drain satisfy the transition gates above. Shipped SQL and
  snapshots remain immutable. See
  [deployment compatibility](../../../docs/deployment-compatibility.md#organization-usage-allowance-retired).

- `scripts/test-connector-catalog-entry-columns.ts` protects migrations
  `1339_expand_connector_catalog_entry_columns` and
  `1340_backfill_connector_catalog_entry_columns`: historical/current hashes
  keep the complete payload while independent columns match application writes;
  SQL and TypeScript permission summaries agree for duplicate and empty
  permissions, allow/deny policy ties, unknown policies, categories and MCP;
  outgoing payload-only writes remain valid and backfill retries are idempotent.
  Retain it through the payload dual-write/dual-read rollout and contraction.

- `scripts/test-unselectable-thread-model-cleanup.ts` protects migration
  `1335_clear_unselectable_thread_models_and_unused_model_keys`: unresolvable
  thread selections return to Auto with ordered `model_selection_updated` and
  `service_tier_updated` events, resolvable selections and agentless streams
  are respected, only the OpenRouter built-in key remains, and a rerun is a
  no-op. Retire it once the migration has shipped and the journal squash line
  passes it.

- `scripts/test-auto-model-selection-null.ts` protects migration
  `1341_auto_model_selection_null`: thread and member selections of active
  catalog models without an enabled subscription route (`okou-1.0` and
  Built-in-only models, by catalog or unique upstream id, plus retired models
  replaced into them such as `okou-1.0-pro`) return to NULL with
  their tiers cleared, threads get ordered `model_selection_updated` and
  `service_tier_updated` events in contiguous per-stream positions, agentless
  threads get no event, subscription and NULL selections are kept,
  and a rerun is a no-op. Retire it once the migration has shipped and the
  journal squash line passes it.

- `scripts/test-file-run-provenance.ts` protects migration
  `1323_detach_file_run_provenance`: unreconciled thread/org associations reject
  the contraction, existing files keep their identities and owners, Run and
  thread deletion preserve file-owned children, provenance-based upserts still
  work without a Run parent, and explicit file deletion owns child cleanup.
  Retain this through the file-lifetime contraction rollout. Migration 1322's
  backfill validator remains active independently.

- `scripts/test-file-thread-associations.ts` protects migration
  `1322_backfill_file_thread_associations`: keyset writes across more than two
  batches, preservation of existing thread/org/owner/file identity, unrelated
  and threadless files, and idempotent reruns. Retain it through the file
  association expand/contract rollout; this does not authorize production
  backfill execution or removal of the Run foreign key.

- `scripts/test-legacy-free-retirement.ts` protects migration
  `1316_retire_legacy_free_tier`: safe legacy and entitlement-only normalization,
  unchanged credits/configuration/billing provenance/suspension, paid pending
  targets, rejected ambiguous or subscription-linked rows with full DDL/data
  rollback, and all three validated constraints.

- `scripts/test-model-catalog-seed.ts` validates the current catalog's
  default, replacement, route, subscription and pricing invariants. Database
  constraint scenarios live in `scripts/test-model-catalog-permanent.ts`.

- `scripts/test-retire-v7-chat-event-snapshots.ts` protects migration
  `1294_retire_v7_chat_event_snapshots`: it proves missing V8 counterparts fail
  without deleting pointers, 6,001 V7 pointers are removed in committed batches
  (including the zero UUID), and every V8 row is unchanged,
  the `= 8` check is validated, and a completed retry is a no-op. The historical
  1286 rewrite validator is removed with the V7 API transition code; historical
  SQL remains unchanged, while schema equivalence and the permanent migration
  suite retain the V8 constraint and exact event/context type sets.

- `scripts/test-pi-inference-lifecycle.ts` protects migrations
  `1134_pi_inference_lifecycle` and `1135_validate_pi_inference_launch` (#34242):
  old/new launch writes, sparse-table invariants, real lock and journal rollback,
  bounded validation retry, unchanged historical records and indexed capacity
  plans at representative retained-table scale. Retain it until all three
  transition conditions above pass; current launch-shape and final schema
  equivalence checks remain in the permanent migration suite.

- `scripts/test-prepared-domain-trigger-retirement.ts` protects migration
  `1132_retire_prepared_domain_triggers` (#33747): all eight A–D drops in one
  transaction, exact original catalogs, invariant rejection, unchanged data,
  preserved ordinary constraints/privacy, grandfathered counts, default lock
  timeout, retry and journal-failure rollback. The four private API write suites
  retain shipped legacy functions in owned schemas alongside the contracted
  variants. Keep these transition controls until the production journal and
  completed rollout satisfy all three conditions above. Current API route
  coverage, guard constraints and the exact remaining catalog are permanent.
- `scripts/test-pi-memory-stage1-cost.ts` protects D's 1141/1142 context expansion
  and separate validation transactions (#34267). It runs from the full
  schema-consistency test on isolated current-schema clones, with actual
  1118/1119 pre-D checks/capture, 134,426 raw and 321,528 hourly rows, default
  timeouts, lock-mode inspection, mixed writers and exact-numeric query plans.
  Retire its historical replay only after the three gates above; preserve the
  Stage 1 current-schema checks, capture body inventory and API infrastructure
  compaction/immutable-identity tests. This validator authorizes no production
  SQL or attribution backfill.

- `scripts/test-pi-candidate-trigger-retirement.ts` protects migration
  `1121_retire_pi_candidate_reference_trigger` (#33975): original catalog
  identity, single-snapshot candidate ownership, narrowly classified #33973
  residuals, default timeouts, post-drop/journal rollback and content-free
  migration receipts. Test-only B lock/decision coverage lives in the API
  candidate accounting suite. Retain both until the contract migration has
  shipped and the B rollback window is closed; permanent current-schema
  trigger/function inventory and C ownership coverage remain.

- `scripts/test-pi-memory-checkpoint-settlement.ts` protects migration
  `1079_pi_memory_checkpoint_settlement` (#31937): real PostgreSQL checks exact
  live legacy grandfathering, valid sandbox leases, unsafe-shape rollback and
  rejection of fresh null/null or mismatched claims from `1078_baseline`.
  Retire it only after the three transition conditions above are met; retain
  the current claim-shape invariants in permanent coverage.

### Retired Goal transition validators (2026-09-10)

[#33323](https://github.com/vm0-ai/vm0/issues/33323) retires the 1093/1094 and
1105/1106 Goal validators and pre-contract API fixture branches after all three
conditions above passed. The
[S5 independent production acceptance](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5623079780)
records the evidence and its limits:

1. **Production journal frontier:** 1106 has `when=1789049110365` in the
   [shipped journal](https://github.com/vm0-ai/vm0/blob/9c777819776d2bed0cfdb110653e46dcaffc0e8b/turbo/packages/db/src/migrations/meta/_journal.json#L201).
   The controller byte-verified the actual production
   [job 102972981101](https://github.com/vm0-ai/vm0/actions/runs/34507172081/job/102972981101),
   separately from its smoke clone: 1106 DDL, helper deletion and timeout resets,
   then the awaited journal INSERT, before `Migrations complete` at
   **2026-09-10 17:21:49.5878347 UTC**. The unchanged
   [runner](https://github.com/vm0-ai/vm0/blob/9c777819776d2bed0cfdb110653e46dcaffc0e8b/turbo/packages/db/scripts/migration-runner.ts#L43)
   awaits each statement and insertion of the migration's timestamp before
   [the entry point](https://github.com/vm0-ai/vm0/blob/9c777819776d2bed0cfdb110653e46dcaffc0e8b/turbo/packages/db/scripts/migrate.ts#L14)
   reports completion. This acknowledged path establishes the required frontier
   and its predecessors. MaskDB exposes neither the journal nor the constraint
   and procedure catalogs; no direct SELECT of those rows is claimed. Acceptance
   combines that execution evidence with fresh physical metadata under an
   unchanged masking policy. It does not replace the frontier gate with a tag,
   elapsed time, smoke result, or an assumed catalog read.
2. **Completed compatibility cycle:** S1–S5 are independently code accepted,
   released and production verified. Release
   [#33253](https://github.com/vm0-ai/vm0/pull/33253) failed with DDL deadlock
   `40P01`; its successful smoke clone did not complete production contraction.
   The later [#33307](https://github.com/vm0-ai/vm0/pull/33307), merged by Ethan,
   completed contraction and promoted API 1.582.0 / App 0.884.1 at
   `9c777819776d2bed0cfdb110653e46dcaffc0e8b`. The accepted physical absence and
   [S1 plus combined-S4 rollback floors](../../../docs/deployment-compatibility.md#okou-goal-retirement-rollback-floor)
   close the Goal schema transition; those floors remain in force.
3. **Permanent surviving coverage:**
   [migration consistency](scripts/test-migration-consistency-schema.ts) retains
   both validated metadata checks, all 18 optional-field partial-write failures,
   discriminator requirements, autonomy bounds, valid nullable/current states,
   schema equivalence, and complete trigger/function inventory. The Goal API
   test suites and their fixtures were removed in #37034 after Goal went fully
   offline. Shared archive contracts, Platform rendering and fail-closed
   security coverage remain.

The expired [1093/1094 validator](https://github.com/vm0-ai/vm0/blob/1cd69b0219c6fe67b7d2fd15bcb7e914ffd8f52e/turbo/packages/db/scripts/test-goal-retirement-migration.ts)
and [1105/1106 validator](https://github.com/vm0-ai/vm0/blob/1cd69b0219c6fe67b7d2fd15bcb7e914ffd8f52e/turbo/packages/db/scripts/test-goal-schema-contraction.ts)
remain immutable historical evidence for replay, locks and the measured census.
Keep shipped SQL, snapshots, journal and numbered external-data operation 014
(including its original README/code/exports) unchanged. The
[completed 014 record](../../../docs/goal-archive-search-recovery.md) is not an
execution entry for the contracted schema. Unrelated transition validators and
the complete migration consistency command remain active.

## Pi stable-context retirement

Migration `1343_retire_pi_stable_context` drops `pi_stable_context_heads`,
`pi_stable_context_artifacts`, `pi_stable_context_artifact_resources` and
`pi_resource_snapshots`, renames `pi_stable_context_generations` and
`pi_stable_context_publications` to `storage_publication_generations` and
`storage_publication_tokens` (with their constraints and index), and drops
`publication_state`. It uses the default transactional timeouts. The
`DROP ... CASCADE` of the three FK-bearing tables takes brief exclusive locks
on `agents`, `storages` and `storage_versions`, bounded by the 1s
`lock_timeout`, so a busy moment can fail the migration and a retry resolves
it. Every earlier
API writes the old tables, so it is not rolling-compatible; the interruption
while the previous API drains is accepted by explicit owner decision
(2026-10-07). The production rollback resolver enforces a floor on the
first-parent `main` commit that adds 1343. Numbered operation 017 remains as a
historical record and no longer has tables to act on. See
[deployment compatibility](../../../docs/deployment-compatibility.md#pi-stable-context-tables-retired-2026-10-07).

## Model catalog

Migration `1326_prune_retired_model_routes` keeps only these execution route
families: fixed Auto (`okou-1.0` on `openrouter-codex`), personal Claude/Codex
subscriptions, and the independent OpenRouter DeepSeek memory binding.
Historical catalog metadata and pricing remain unchanged; active metadata
without a route does not grant execution. See
[cleanup boundaries](../../../docs/retired-model-route-cleanup.md).

Migrations `1330_drop_retired_model_configuration_columns` and
`1331_delete_organization_model_provider_rows` contract the remaining model
configuration schema: they drop `agents.model_provider_id`,
`agents.selected_model`, `agents.prefer_personal_provider`,
`model_providers.secret_id` and `org_plan_entitlements.support_byok`, narrow
the `model_routes` provider checks to `built-in`/`openrouter-codex` and the two
subscription types, and delete organization-owned (`__org__`)
`model_providers` rows. Rollout: an API built before 1330 still reads the
dropped columns, so it must not serve after 1330 is applied. Apply them only
after every serving API (and any rollback target) no longer reads these
columns. The production rollback resolver enforces this as a floor: it
resolves the first-parent `main` commit that added migration 1330 and rejects
earlier rollback targets. Because this is not a rolling-compatible
contraction, it requires an explicitly owner-accepted interruption under the
[deployment compatibility](../../../docs/deployment-compatibility.md) rules;
this document does not record such an acceptance.

Migration `1332_drop_chat_thread_provider_pin_columns` then drops the legacy
`chat_threads.model_provider_id`, `model_provider_type` and
`model_provider_credential_scope` pin columns; threads persist only
`selected_model`. It has the same rollout constraint and its own rollback
floor keyed to the commit that added 1332. Its owner-accepted interruption is
recorded in
[deployment compatibility](../../../docs/deployment-compatibility.md#legacy-chat-thread-provider-pin-columns-dropped).

Migration `1333_drop_dead_model_provider_columns` drops the remaining constant
model configuration columns: `model_providers.auth_method`, `is_default` (with
`idx_model_providers_one_default_per_user`) and `selected_model`,
`model_routes.price_tier` (with `chk_model_routes_price_tier`) and
`run_model_catalog.is_system_default` (with
`idx_run_model_catalog_one_system_default` and
`chk_run_model_catalog_default_active`). The system default is the API-owned
fixed Auto model; personal account import formats stay on
`model_provider_accounts.auth_method`. There is no data conversion. Rollout:
an API built before 1333 still selects these columns, so it must not serve
after 1333 is applied; apply it only after every serving API (and any rollback
target) is built from the commit that adds it. The production rollback
resolver enforces this as a floor on the first-parent `main` commit that adds 1333. `test-model-catalog-permanent.ts` and `test-model-catalog-seed.ts` cover
the surviving catalog and route invariants.

Migration `1336_retire_ultrafast_data` clears stored Ultrafast selections from
`chat_threads.codex_service_tier`, `org_members_metadata.service_tier` and
`model_routes` service tiers. `1338_retire_model_route_state` limits
route tiers to `priority` and adds the thread and member service tier checks
`NOT VALID` with a separate `VALIDATE`, per the online constraint rule below.
See
[deployment compatibility](../../../docs/deployment-compatibility.md#ultrafast-service-tier-retired-2026-10-07).

Migration `1338_retire_model_route_state` drops
`built_in_model_candidate_cooldown`; Auto no longer cools its route down after a
provider failure. There is no data conversion. Every API built before 1338
reads the table on the run claim path, so this is not a rolling-compatible
contraction; Ethan explicitly accepted (2026-10-07) the bounded interruption
while a pre-1338 API drains, recorded in deployment compatibility. The
production rollback resolver enforces this as a floor on the first-parent
`main` commit that adds 1338. The permanent `test-built-in-model-cooldown-permanent.ts` validator is
deleted with the table it checked. See
[deployment compatibility](../../../docs/deployment-compatibility.md#built-in-model-candidate-cooldown-removed-2026-10-07).

Migration `1337_retire_unused_model_route_data` clears data no live reader
uses: `run_model_catalog.pi_route_class` values other than `gpt-codex`,
`chat_threads.selected_model = 'deepseek/deepseek-v4-pro'` (NULL is the
unpinned state and resolves to Auto) and every `built_in_model_keys` row other
than `openrouter` (no foreign key references that table;
`agent_runs.built_in_model_key_id` stays as unconstrained history). Migration
`1338_retire_model_route_state` then narrows
`chk_run_model_catalog_pi_route_class` to `gpt-codex` (the table is tiny, so
the check is added directly), drops `model_provider_auth_sessions.sandbox_id`
with `idx_model_provider_auth_sessions_sandbox`, and drops the frozen OAuth
copies on `model_providers` (`token_expires_at`, `needs_reconnect`,
`last_refresh_error_code`, `workspace_name`, `plan_type`,
`subscription_reset_period`, `subscription_next_reset_at`); the live values are
on `model_provider_accounts`. Rollout: an API built before 1338 selects every
`model_providers` and `model_provider_auth_sessions` column, so this is not a
rolling-compatible contraction; Ethan explicitly accepted (2026-10-07) the bounded interruption, recorded in
deployment compatibility. The
production rollback resolver enforces a floor on the first-parent `main` commit
that adds 1338. See
[deployment compatibility](../../../docs/deployment-compatibility.md#frozen-model-provider-state-dropped-2026-10-07).

The 1325–1327 transition validators (`test-custom-model-retirement.ts`,
`test-retired-model-route-cleanup.ts`) were removed after those migrations
shipped to production on 2026-10-07. `test-model-catalog-seed.ts` permanently
checks the retained route families and historical replacement chains, and
`test-model-catalog-permanent.ts` checks the catalog and route constraints.

The following records describe historical catalog migrations; they do not
describe current routes.

The system default is the API-owned fixed Auto model (the
`run_model_catalog.is_system_default` column was dropped by 1333).
Model availability and replacement use `replaced_by`; subscription routes are
stored in `model_routes`. The owner waived pre-catalog rollback. Apply schema
contraction only after pre-catalog API instances have drained.

Replacement chains: `replaced_by` may point at a retired row; the chain ends
at the final active model. The self foreign key
`(replaced_by, replaced_by_lineage_rank) → (model, lineage_rank)` (ON UPDATE
CASCADE) rejects dangling targets, `replaced_by_lineage_rank > lineage_rank`
rejects self-references and cycles, and both replacement columns must be set
together. To retire X in favor of Y, raise Y's `lineage_rank` above X's if
needed (raising a rank never invalidates referrers), then set `replaced_by`
and `replaced_by_lineage_rank` on X in the same statement. Auto's
fixed model cannot be retired by a catalog edit; change the API constant.

Former Okou and Terra rows: `gpt-5.6-terra`, `okou-1.0-pro` and
`okou-1.0-max` (seeded by 1191 and 1194, code support removed by #37363 and
#37368) are in the 1298 seed as retired rows with their former labels (GPT
5.6 Terra, Okou 1.0 Pro, Okou 1.0 Max), `lineage_rank = 0`, no
`model_routes`, replaced by the
owner-approved targets `gpt-6-luna`, `okou-1.0` and `okou-1.0` (active, rank
100). The rows are kept, not deleted, so history stays named; 1299 rewrites
any mutable selection of them to their target (MaskDB shows zero
references in `chat_threads`, `org_model_policies`, `org_members_metadata`,
`agents` and `model_providers`). 1298 still keeps any other row outside the
seed with its ID as label, sorted last and no routes; none is known to exist.

1299 rewrites chat thread selections (`chat_threads.selected_model` and
`model_settings`) and appends one `model_selection_updated` event per
re-pinned thread with an agent, reserving one contiguous `seq_id` range per
`(user_id, org_id)` stream as 1213 did. The event carries a
`model_settings_patch` only when an effort is copied. Legacy provider pins
(`model_provider_type`, or the type of `model_provider_id`) are never
transplanted or cleared: a thread whose pin type has no enabled route on the
replacement keeps its retired model and pin, so the API resolves it along the
chain and rejects the route explicitly instead of silently re-routing it to
the organization policy or Built-in billing. Compatible pins stay as stored.
The effort domain is the replacement's route for the pin type (Built-in when
unpinned); an unsupported effort becomes that route's `default_effort`. The
chat thread rewrite is one scan of `chat_threads` in the migration
transaction, like 1213. Only rows still selecting a retired model are
written, so re-running appends nothing. As of MaskDB on 2026-09-30 no chat
thread, organization policy, member preference, agent or model provider
references any retired catalog model (`claude-fable-5`,
`claude-opus-4-8`, `claude-sonnet-4-6`, `deepseek-v4-pro`, `gpt-5.5`,
`gpt-5.6-terra`, `okou-1.0-pro`, `okou-1.0-max`), so 1299 rewrites zero
production rows. See the performance evidence below for why it needs no
batching.

`1302_model_route_long_context_threshold` adds nullable
`model_routes.long_context_min_total_input_tokens` with
`chk_model_routes_long_context_threshold` (NULL, or a positive value on a
Built-in route) and backfills the configured long-context routes to 272001. It is a small single-table update
(the catalog has tens of routes) and changes no price. Apply it before
promoting the API; the previous API does not select the column. Runner
compatibility of the captured value is in
[deployment compatibility](../../../docs/deployment-compatibility.md#long-context-threshold-in-the-runner-payload-2026-10-01).

### Migration 1299 performance evidence

Production row counts (MaskDB `vm0-prod-ro`, read-only, 2026-09-30; exact
counts by `limit 1` + `offset` bisection, which is equivalent to full
pagination): `chat_threads` 162,621; `org_model_policies` 32,810;
`model_providers` 7,374; `agents` 8,009; `org_members_metadata` 6,988;
`chat_thread_events` 143,338; `chat_thread_event_sequences` 4,476. Rows
selecting a retired model (`claude-fable-5`, `claude-opus-4-8`,
`claude-sonnet-4-6`, `gpt-5.5`, `deepseek-v4-pro`) are zero in all five
rewritten tables (the same filter returns rows for active models, so the zero
is not a filter artifact).

Index shape: none of the rewritten tables has an index on `selected_model` or
`model` (except `idx_org_model_policies_org_model (org_id, model)`, which a
`model`-only predicate cannot use), so every rewrite statement scans its table
once; the joins after the filter use primary keys. The scans are bounded by
the table sizes above; none of them touches history tables. Statement 14
(`model_selection_rewrite_threads`) is the only one that reads
`chat_threads`.

Experiment: throwaway PostgreSQL 18 (`timezone=UTC`, default `work_mem`,
`fsync=off`), all migrations applied, synthetic rows at production scale
(1x) and 5x, then the 1299 body re-run statement by statement under
`EXPLAIN (ANALYZE, BUFFERS)` with `statement_timeout = 10s` inside a rolled
back transaction. Retired-model share: 0% (production), 1% and 10%.
Statement numbers count the 1299 statements before the `ANALYZE` below was
added: 14 builds `model_selection_rewrite_threads`, 15 updates `chat_threads`
and 16 appends the `model_selection_updated` events.

| Scenario                                               | Total  | Slowest statement                                  | Other statements |
| ------------------------------------------------------ | ------ | -------------------------------------------------- | ---------------- |
| 1x, 0 matches (production)                             | 0.21 s | 14 (thread scan) 164 ms                            | each <= 11 ms    |
| 1x, 1% matches (1,597 threads, 317 policies)           | 0.27 s | 14: 103 ms; 15/16 (thread update, events) 59/54 ms | each <= 22 ms    |
| 1x, 10% matches (16,258 threads, 3,162 policies)       | 1.01 s | 15: 364 ms; 16: 331 ms; 14: 216 ms                 | each <= 25 ms    |
| 5x, 0 matches                                          | 2.28 s | 14: 1,964 ms                                       | each <= 113 ms   |
| 5x, 1% matches (8,028 threads)                         | 4.10 s | 14: 2,029 ms; 15: 869 ms; 16: 700 ms               | each <= 108 ms   |
| 5x, 1% matches, with `ANALYZE model_selection_rewrite` | 1.29 s | 15: 401 ms; 16: 390 ms; 14: 310 ms                 | each <= 58 ms    |

No statement came near the 10 s timeout. The one plan defect: temp tables
have no statistics, so without an `ANALYZE` the planner sorted every chat
thread (external merge sort) before joining the few-row rewrite map, which
grows faster than linearly with `chat_threads`. 1299 therefore analyzes
`model_selection_rewrite` right after creating its primary key; statement 14
then filters during the scan (5x: 2,029 ms to 310 ms). Batching is not needed:
production has zero matching rows, and even 5x production volume with 1%
matches finishes in about 1.3 s. Write locks are taken only on rows that
match, so the scans block no writers.

Verified: statement plans and timings on synthetic data at the stated scales,
production row counts and zero retired references at the time of the MaskDB
read. Not verified: production hardware, cache state, `work_mem`, bloat and
concurrent load; the exact production distribution of thread effort settings
and provider pins; rows that start selecting a retired model between the
MaskDB read and the deploy (1299 re-checks at run time, and the numbers above
cover up to 10% of rows).

`org_plan_entitlements.restricted_built_in_models` is a boolean flag that turns
on the code's limited-free restricted-model rule; it stores no model IDs, so
1299 has nothing to rewrite there.

## Migration patterns

The following patterns no longer have a surviving migration example, so keep
the complete SQL here.

### Run a batched backfill without blocking writers

Use the non-transactional marker so the procedure can commit each batch. Lock
only the selected rows, skip rows held by concurrent writers, and never take a
table lock. If the backfill temporarily relaxes a trigger function, restore its
accepted body byte-for-byte before the migration completes.

```sql
-- vm0:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "backfill_example"()
LANGUAGE plpgsql
AS $$
DECLARE
  affected_rows integer;
BEGIN
  LOOP
    WITH "batch" AS (
      SELECT "id"
      FROM "example_table"
      WHERE "canonical_value" IS NULL
      ORDER BY "id"
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "example_table" AS "target"
    SET "canonical_value" = "target"."legacy_value"
    FROM "batch"
    WHERE "target"."id" = "batch"."id";

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    COMMIT;
    EXIT WHEN affected_rows = 0;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "backfill_example"();
--> statement-breakpoint
DROP PROCEDURE "backfill_example"();
```

### Add and validate a constraint online

Add the constraint with `NOT VALID` so PostgreSQL enforces it for new writes
without first scanning all existing rows. Validate existing rows separately:

```sql
ALTER TABLE "child_table"
ADD CONSTRAINT "child_table_parent_id_parent_table_id_fk"
FOREIGN KEY ("parent_id") REFERENCES "parent_table" ("id")
NOT VALID;
--> statement-breakpoint
ALTER TABLE "child_table"
VALIDATE CONSTRAINT "child_table_parent_id_parent_table_id_fk";
```

### Create an index without blocking writes

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so the migration
must use the non-transactional marker:

```sql
-- vm0:non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS "table_created_at_idx"
ON "table" ("created_at");
```

## Permanent triggers and functions

New database triggers are rejected by
[`api/no-database-trigger`](../../../docs/eslint/no-database-trigger.md) in SQL
migrations and production TypeScript. Existing shipped trigger migrations have
explicit ESLint exceptions; do not extend those exceptions for new behavior.
Keep write orchestration in application transactions and invariants in database
constraints.

The nine existing definitions in `EXPECTED_PERMANENT_TRIGGERS` have individual
`eslint-disable-next-line api/no-database-trigger` comments stating that they
predate 2026-09-29 and new triggers are prohibited. The inventory script is linted
despite the general test exclusion. Do not add exceptions for new triggers.

When a migration changes or removes an existing trigger or function, or adds a
function, update `EXPECTED_PERMANENT_TRIGGERS` or `EXPECTED_PERMANENT_FUNCTIONS`
in `scripts/test-migration-consistency-schema.ts` in the same change. Trigger keys
include the complete `pg_get_triggerdef` output, and function keys include the
MD5 of the function body. Changing trigger timing, the function it executes, an
`UPDATE OF` column list, or a function body therefore makes the permanent
inventory test fail until the expected inventory is updated.
