# Retired model route cleanup

This data-only migration follows Custom model configuration retirement
(PR #37746). It physically removes obsolete execution routes, not model names
or historical billing identities. It must not deploy while an API version that
can admit organization API-key routes or platform multi-model candidates is
still serving. The retirement API is the rollback floor.

## Retained rows

`1321_prune_retired_model_routes` keeps:

- Auto: `okou-1.0` / `built-in` / `openrouter-codex` /
  `@preset/okou-1-0`, with no subscription marker.
- Internal memory: `deepseek-v4.1-flash` / `built-in` /
  `openrouter-codex` / `deepseek/deepseek-v4.1-flash`, with no subscription
  marker. Both Stage 1 and Phase 2 still use this independent binding.
- Personal Claude and Codex subscription routes whose provider, concrete
  provider and subscription marker agree. Disabled routes and future model
  additions in these two subscription families remain unchanged.

All other `model_routes` rows are deleted, including direct vendor routes,
organization API-key routes, gateways, retired platform alternatives and the
unused direct DeepSeek memory candidate. A NULL subscription marker is not a
personal subscription and must not survive SQL three-valued logic.

The migration rejects an uncontracted Custom schema or a missing, disabled or
drifted required Auto/memory binding before deleting anything. The migration
runner owns the transaction, default lock/statement timeouts and journal entry.
It does not recreate missing bindings or silently fall back to another model.

## Preserved data

No other table is changed. In particular:

- `run_model_catalog` retains personal model metadata, historical labels and
  replacement chains. A route-less row is metadata, not execution authority.
- Usage pricing, raw and hourly usage, run snapshots, credits, workflows,
  personal accounts, credentials and built-in keys are unchanged.
- Jev, auxiliary generation and image handling are outside this migration.

A read-only MaskDB census on 2026-10-05 found 80 routes: 71 match the deletion
predicate and 9 survive (Auto, memory and 7 personal subscription routes).
These are a point-in-time inventory, not an execution receipt or a hard-coded
row-count gate. No production SQL was executed.

## Validation

From `turbo/packages/db`, using a disposable local PostgreSQL database:

```bash
DATABASE_URL=postgresql://user@127.0.0.1:55432/postgres pnpm test:retired-model-route-cleanup
```

The regression replays the real preceding migrations, adds a future disabled
subscription and an adjacent non-subscription route, then verifies exact
retained rows, unchanged retained tables, rejection/rollback for uncontracted
schema and invalid bindings, one committed journal entry, and journaled and
SQL-level retries. It also validates the surviving seeded catalog.

The check is included in `test:migration-consistency`. Full migration/schema
consistency and required PR CI must pass before merge. This PR is stacked on
#37746; retarget and regenerate migration metadata against the eventual main
before merging it. Migration numbers are not reserved across concurrent PRs.
