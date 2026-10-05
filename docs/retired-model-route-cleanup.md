# Retired model route cleanup

This data-only migration follows Custom model configuration retirement
(PR #37746). It physically removes obsolete execution routes, not model names
or historical billing identities. It must not deploy while an API version that
can admit organization API-key routes or platform multi-model candidates is
still serving. The retirement API is the rollback floor.

## Retained rows

`1322_prune_retired_model_routes` keeps:

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
consistency and required PR CI must pass before merge. The former #37758 is
closed; its complete cleanup ships only through the unified #37746. Migration
metadata was generated after integrating main's 1320 migration; numbers are not
reserved across concurrent PRs.

## Personal subscription launch defaults

`1323_preserve_subscription_route_effort_defaults` is separate from the
unchanged deletion-only cleanup. The canonical subscription rows previously had
NULL default efforts, while their retired non-subscription mirrors supplied the
native launch defaults. It preserves those defaults from migration 1298 on the
six matching active canonical subscription routes only. Explicit defaults,
disabled/future rows, member preferences, Auto and memory are not rewritten.
Luna's existing xhigh default from migration 1317 remains unchanged.

The regression also checks all seven personal launch defaults, unchanged future
metadata, repeat SQL execution, and preservation of disabled rows and explicit
configured defaults.
