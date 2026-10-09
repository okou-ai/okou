# Retired model route cleanup

This data-only migration follows Custom model configuration retirement
(PR #37746). It physically removes obsolete execution routes, not model names
or historical billing identities. It must not deploy while an API version that
can admit organization API-key routes or platform multi-model candidates is
still serving. The retirement API is the rollback floor.

## Retained rows

`1326_prune_retired_model_routes` keeps:

- Auto: `okou-1.0` / `built-in` / `openrouter-codex` /
  `@preset/okou-1-0`, with no subscription marker.
- Internal memory: `deepseek-v4.1-flash` / `built-in` /
  `openrouter-codex` / `deepseek/deepseek-v4.1-flash`, with no subscription
  marker. This was the independent memory binding at the cleanup boundary.
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

Migrations 1325–1327 shipped to production on 2026-10-07, and their one-shot
transition regression (`test-retired-model-route-cleanup.ts`) was removed.
The surviving invariants run in `pnpm test:migration-consistency`:
`test-model-catalog-seed.ts` checks the retained route families and historical
replacement chains, and `test-model-catalog-permanent.ts` checks the catalog
and route constraints.

The former #37758 is closed; its complete cleanup shipped through the unified
#37746.

Migration `1347_pi_memory_luna_route` subsequently restores the existing
OpenRouter Luna route for new Stage 1 and Phase 2 memory work. Migration
`1353_retire_deepseek_memory_route` removes the retained DeepSeek execution
routes after captured work and late usage have drained. Auto, internal Luna
and personal subscription routes remain. The explicit Luna API rollback floor
prevents DeepSeek admission from returning; see
[the retirement contract](https://github.com/okou-ai/okou/blob/efdfb1ce76686698e2446eceb5a439caf88cd854/docs/deployment-compatibility.md#deepseek-memory-execution-retirement-2026-10-08).
Historical DeepSeek catalog metadata and pricing remain unchanged.

## Personal subscription launch defaults

`1327_preserve_subscription_route_effort_defaults` is separate from the
unchanged deletion-only cleanup. The canonical subscription rows previously had
NULL default efforts, while their retired non-subscription mirrors supplied the
native launch defaults. It preserves those defaults from migration 1298 on the
six matching active canonical subscription routes only. Explicit defaults,
disabled/future rows, member preferences, Auto and memory are not rewritten.
Luna's existing xhigh default from migration 1317 remains unchanged.

Its transition regression (all seven personal launch defaults, unchanged
future metadata, repeat SQL execution, and preservation of disabled rows and
explicit configured defaults) was removed with the 1325–1327 validators after
the migration shipped.
