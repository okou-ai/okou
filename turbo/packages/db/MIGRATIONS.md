# Database Migrations

Generate migrations with `pnpm -F @okouai/db db:generate` and verify them with
`pnpm -F @okouai/db test:migration-consistency`. Do not edit an existing migration
or snapshot after it has shipped.

Transactional migrations start with a `1s` `lock_timeout` and a `10s`
`statement_timeout`. A migration that needs more time may override either
default with a later `SET LOCAL` statement in that migration. Non-transactional
migrations do not receive these defaults and must manage their own timeout
requirements.

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

### Active transition validators

- `scripts/test-marketing-privacy-retirement.ts` protects migration
  `1134_retire_marketing_privacy_storage` (#33747): populated/empty storage,
  unrelated state preservation, restrictive external dependencies, shared
  cleanup/table locks, default lock timeout, retry and journal-failure rollback.
  Keep it until the production journal and completed prepared-cleanup rollout
  satisfy the three retirement conditions. Current schema equivalence and exact
  trigger/function inventory remain permanent. Historical 1108–1110 SQL and the
  A–D 1132 transition controls remain unchanged.

- `scripts/test-prepared-domain-trigger-retirement.ts` protects migration
  `1132_retire_prepared_domain_triggers` (#33747): all eight A–D drops in one
  transaction, exact original catalogs, invariant rejection, unchanged data,
  preserved ordinary constraints/privacy, grandfathered counts, default lock
  timeout, retry and journal-failure rollback. The four private API write suites
  retain shipped legacy functions in owned schemas alongside the contracted
  variants. Keep these transition controls until the production journal and
  completed rollout satisfy all three conditions above. Current API route
  coverage, guard constraints and the exact remaining catalog are permanent.

- `scripts/test-pi-candidate-trigger-retirement.ts` protects migration
  `1121_retire_pi_candidate_reference_trigger` (#33975): original catalog
  identity, single-snapshot candidate ownership, narrowly classified #33973
  residuals, default timeouts, post-drop/journal rollback and content-free
  migration receipts. Test-only B lock/decision coverage lives in the API
  candidate accounting suite. Retain both until the contract migration has
  shipped and the B rollback window is closed; permanent current-schema
  trigger/function inventory and C ownership coverage remain.

- `scripts/test-member-invitation-retirement.ts` protects migration
  `1098_retire_member_invitation_capability` (#32573). It checks removal of
  manual invitation overrides, legacy INSERT/UPSERT/RETURNING statements, and
  current status-only writes observed by old API readers. Migration 1132 removes
  the derived-status trigger. The physical columns
  remain for #32575's separate contraction; keep this validator until that
  column transition passes its release gates. The current
  application uses a canonical-only runtime mapping and no longer mirrors the
  legacy usage-pack column. The validator also exercises that mapping's real
  insert, conflict update, select and returning on an isolated contracted table.
  This is readiness coverage, not evidence that production contraction shipped;
  retain the migration-only declarations and validator until the
  [remaining release gates](../../../docs/deployment-compatibility.md#invitation-and-free-member-contract-cleanup-2026-09-14)
  pass.

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
   schema equivalence, and complete trigger/function inventory. The
   [current-schema API tests](../../apps/api/src/signals/routes/__tests__/goal-schema-contraction.test.ts)
   retain real launches, callbacks, late billing and publication/retention races;
   [literal history tests](../../apps/api/src/signals/routes/__tests__/goal-retirement-history.test.ts)
   retain all four statuses, malformed provenance, hot/snapshot/search/export,
   new and unchanged old shares, and ordinary continuation. Shared archive
   contracts, Platform rendering and fail-closed security coverage remain.

The expired [1093/1094 validator](https://github.com/vm0-ai/vm0/blob/1cd69b0219c6fe67b7d2fd15bcb7e914ffd8f52e/turbo/packages/db/scripts/test-goal-retirement-migration.ts)
and [1105/1106 validator](https://github.com/vm0-ai/vm0/blob/1cd69b0219c6fe67b7d2fd15bcb7e914ffd8f52e/turbo/packages/db/scripts/test-goal-schema-contraction.ts)
remain immutable historical evidence for replay, locks and the measured census.
Keep shipped SQL, snapshots, journal and numbered external-data operation 014
(including its original README/code/exports) unchanged. The
[completed 014 record](../../../docs/goal-archive-search-recovery.md) is not an
execution entry for the contracted schema. Unrelated transition validators and
the complete migration consistency command remain active.

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

When a migration adds a trigger or function, update
`EXPECTED_PERMANENT_TRIGGERS` or `EXPECTED_PERMANENT_FUNCTIONS` in
`scripts/test-migration-consistency-schema.ts` in the same change. Trigger keys
include the complete `pg_get_triggerdef` output, and function keys include the
MD5 of the function body. Changing trigger timing, the function it executes, an
`UPDATE OF` column list, or a function body therefore makes the permanent
inventory test fail until the expected inventory is updated.
