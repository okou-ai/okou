# Global Model Catalog

The run model catalog moves from code constants and
`subscription_model_catalog` into two database tables. This document records
the end state, the constraint design, and the phased rollout.

## End state

`run_model_catalog` holds one row per stable model ID:

| Column              | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `model`             | Stable model ID (primary key).                                       |
| `display_name`      | The only source of the model's user-facing name.                     |
| `sort_order`        | The only source of model ordering in every picker.                   |
| `is_system_default` | The one model new organizations and unresolved selections use.       |
| `replaced_by`       | NULL: active and addable. Non-NULL: retired; resolves to the target. |

A retired model cannot be added, and stored selections of it resolve to its
replacement. Replacement chains are a single hop to an active model, so no
self-reference, cycle or dangling target can exist.

`model_routes` holds the executable routes of each model:

| Column                                  | Meaning                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `provider_type`                         | Route the org or member selects: `built-in`, a BYOK type or a subscription type. |
| `concrete_provider_type`                | Provider serving the request. Built-in routes list one row per candidate.        |
| `subscription_type`                     | Set only for Auto-mode personal subscription routes.                             |
| `upstream_model`                        | Model ID sent upstream.                                                          |
| `enabled`, `priority`                   | Whether the route is used and the Built-in fallback order (ascending).           |
| `service_tiers`, `default_service_tier` | Optional tiers besides implicit Standard (`priority`, `ultrafast`).              |
| `efforts`, `default_effort`             | Reasoning efforts accepted on the route and the launch default.                  |
| `price_tier`                            | Built-in display price tier (`$` to `$$$$`).                                     |
| `pricing_kind`, `pricing_provider`      | Link to the `usage_pricing` rows that bill a Built-in route.                     |

`usage_pricing` remains the billing authority. Routes link to it by
`(kind, provider)`; a foreign key is impossible because its key includes the
category. Routes carry no names or ordering of their own.

## Constraint design

The repository is retiring database triggers, so every invariant that can be
local is a constraint:

- `is_active` is a stored generated column, `replaced_by IS NULL`, and
  `UNIQUE (model, is_active)` makes it a foreign-key target.
- `replacement_target_active` is a stored generated column that is `true` when
  `replaced_by` is set and NULL otherwise. The foreign key
  `(replaced_by, replacement_target_active) → (model, is_active)` therefore
  only matches active rows. `MATCH SIMPLE` skips active rows. A self-reference,
  a retired or missing target, and therefore any cycle, are rejected.
- Retiring a replacement target changes its referenced key, so the target's
  referrers must be repointed first, in the same transaction. Deleting a
  referenced target is rejected. The key is not deferrable: Drizzle cannot
  express deferrable foreign keys and the schema-equivalence check compares
  constraint definitions. No workflow needs deferral because repointing
  referrers first is always possible.
- `CHECK (NOT is_system_default OR replaced_by IS NULL)` keeps the default
  active, and the partial unique index on `is_system_default WHERE
is_system_default` allows at most one. The index is not deferrable, so
  switching the default clears the old row before setting the new one; do both
  in one transaction. Retiring the current default requires switching first.
- `model_routes` constrains its provider types, the concrete provider of
  Built-in candidates, subscription types, tier and effort values (a default
  must be in its array), display price tiers, and requires every Built-in
  route to link to model pricing. Route identity is unique on
  `(model, provider_type, subscription_type, concrete_provider_type)` and
  fallback order on `(model, provider_type, subscription_type, priority)`, both
  `NULLS NOT DISTINCT`.

"Exactly one default" and "the default has an enabled Built-in route" span
rows, so the API catalog loader (`model-catalog.service.ts`) validates them,
re-checks replacement targets, and fails the request instead of choosing a
default. `resolveCatalogModel` returns the final active model or an explicit
unknown result; it never substitutes the system default.

## Phased rollout

- **PR-A (this change):** additive schema, seed and a read-only
  `GET /api/model-catalog`. No existing reader changes.
- **PR-B:** server readers switch to the catalog: the organization and
  new-organization default come from `is_system_default` (replacing
  `ORG_DEFAULT_RUN_MODEL` from #37416), `replaced_by` resolution applies
  everywhere a stored model is read, and queued runs recheck their model at
  dispatch.
- **PR-C:** App, CLI and integrations consume the server catalog instead of
  code constants.
- **PR-D:** retire Claude Fable 5 through `replaced_by`, then migrate stored
  configuration idempotently.
- **PR-E:** delete the code model lists, `subscription_model_catalog`,
  `allow_new_org_policy` and `org_model_policies.is_default`.

## Transitional state (PR-A)

- The seed duplicates code constants. `test-model-catalog-seed.ts` in the
  migration consistency suite fails if the seeded catalog or routes diverge
  from `SUPPORTED_RUN_MODELS`, `RETIRED_RUN_MODELS`, the labels, Built-in route
  candidates, model-first provider compatibility, run options and
  `subscription_model_catalog`. Operators changing one must change the other
  until PR-E.
- Adding a new organization policy is still decided by
  `allow_new_org_policy` for code-active models. Rows with `replaced_by` set
  are code-retired and ignored by that reader, so their flag has no effect. An
  active row with `allow_new_org_policy = false` (for example `gpt-6-sol`, or a
  model an operator had not admitted before this migration) remains
  non-addable until PR-B makes `replaced_by` authoritative; PR-B must decide
  those rows explicitly.
- Route efforts are the model's accepted efforts. The runtime still narrows
  them per execution (Pi or not, and the concrete provider for DeepSeek);
  those rules stay in code until PR-B.
