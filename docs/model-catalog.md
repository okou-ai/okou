# Global Model Catalog

The run model catalog lives in two database tables, `run_model_catalog` and
`model_routes`, and is served by `GET /api/model-catalog`. The server catalog
is the only product authority for model names, ordering, the system default,
retirement and replacement, display price tiers and route capabilities
(service tiers and reasoning efforts). App, iOS, CLI and integrations read it
instead of code constants. Code keeps only runtime knowledge that cannot live
in data: the protocol adapter of each executable model (framework, environment
bindings, context limits). A catalog model without an adapter cannot be the
system default and is rejected when selected.

## Catalog tables

`run_model_catalog` holds one row per stable model ID:

| Column                     | Meaning                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `model`                    | Stable model ID (primary key).                                         |
| `display_name`             | The only source of the model's user-facing name.                       |
| `sort_order`               | The only source of model ordering in every picker and list.            |
| `is_system_default`        | The one model every organization uses without a thread or member pick. |
| `replaced_by`              | NULL: active and addable. Non-NULL: retired; resolves along the chain. |
| `lineage_rank`             | Acyclicity rank; every replacement hop strictly increases it.          |
| `replaced_by_lineage_rank` | Copy of the target's rank, maintained by the self foreign key.         |

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
category. Routes carry no names or ordering of their own. Personal
subscription routes (formerly `subscription_model_catalog`) are
`model_routes` rows with `subscription_type` set.

## API surface

`GET /api/model-catalog` returns `systemDefaultModel`, every catalog model
(`model`, `displayName`, `sortOrder`, `isSystemDefault`, `replacedBy`,
`resolvedModel` — the final active model of the whole chain — and the Built-in
`priceTier`) and every route. Clients:

- show `displayName` and order by `sortOrder`;
- mark the default from `systemDefaultModel`;
- show a stored retired selection as its `resolvedModel`;
- offer only active models (`replacedBy` null) in pickers;
- take effort choices and defaults from the model's routes.

## Replacement chains

A retired model cannot be added, and every stored selection of it resolves to
the final active model of its chain. Chains may have several hops. The API
loader (`model-catalog.service.ts`) follows `replaced_by` hop by hop and fails
the request on a dangling target or cycle instead of picking a model;
`resolveCatalogModel` returns the final active model or an explicit unknown
result and never substitutes the system default.

Approved replacements (owner decisions, 2026-09-30), all single-hop today:

| Retired model       | Replacement         |
| ------------------- | ------------------- |
| `claude-fable-5`    | `claude-fable-5-1`  |
| `claude-opus-4-8`   | `claude-opus-5-5`   |
| `claude-sonnet-4-6` | `claude-sonnet-5-5` |
| `deepseek-v4-pro`   | `gpt-6-luna`        |
| `gpt-5.5`           | `gpt-6-luna`        |

Retiring X in favor of Y: if `Y.lineage_rank <= X.lineage_rank`, raise
`Y.lineage_rank` first (raising a rank only widens the gap to its referrers;
`ON UPDATE CASCADE` refreshes their copies), then set `X.replaced_by = Y` and
`X.replaced_by_lineage_rank = Y.lineage_rank` in one statement.

## System default

Exactly one active model is the system default (`okou-1.0`, Auto, today). It
is not stored per organization: `GET /api/model-policies` projects it into
every organization's policy list as a non-deletable Built-in system policy
with a stable derived ID. `PUT /api/model-policies` does not need to list it;
a client that still sends it is accepted and that entry is ignored. Stored
rows of the default model are superseded by the projection. Model resolution
for a new run is thread selection, then member preference, then the system
default. Switching the default is a catalog change (clear the old row, set the
new one, in one transaction); it needs no per-organization data migration.

## Route selection

A replacement resolves only the model. The route is chosen again among the
replacement's own `model_routes` under the caller's permissions, provider
connections and plan. Built-in routes fall back by ascending `priority`.

No silent cross-provider billing: credentials, BYOK, subscription or
custom-gateway bindings and upstream IDs of a retired model are never copied
onto its replacement. When the replacement has no route of the stored
selection's provider type — for example a DeepSeek BYOK selection of
`deepseek-v4-pro` replaced by `gpt-6-luna` — the request fails with an
explicit error ("was replaced and its replacement has no compatible route in
this workspace"); it never falls back to the system default or to Built-in
platform billing.

## Efforts

Route `efforts` are the only accepted reasoning efforts and `default_effort`
is the launch default. An explicit effort from the caller is kept when the
replacement's route accepts it and rejected otherwise. Saved per-model effort
preferences are keyed by model ID and are not transplanted at read time; the
stored-configuration migration copies a retired model's member effort to its
replacement when the replacement's Built-in route accepts it, otherwise uses
that route's default (no default, no entry). The runtime still narrows efforts
per execution (Pi or not, and the concrete provider for DeepSeek).

## Queued inputs and history

A queued input captures its model at enqueue. At dispatch the captured model
is re-resolved against the current catalog, so a model retired after enqueue
runs as its final replacement; an unknown model is left as captured so run
admission rejects it explicitly. Historical runs, chat events (including
queued-input events), usage and billing keep the original model ID and are
never rewritten.

## Stored-configuration migration

Migration `1297_model_catalog_stored_selections` rewrites mutable stored
selections of retired models to the final active model of their chain. It is
re-runnable (it only selects rows that still reference a retired model) and
takes the per-organization policy advisory locks in `org_id` order.

- `org_model_policies.model`: rewritten only when the replacement has an
  enabled route of the same provider type. Incompatible retired policies are
  dropped rather than transplanted (the count is logged via `RAISE NOTICE`).
  One policy per organization and replacement survives: an existing
  replacement policy wins, otherwise the retired default, then the oldest. The
  legacy `is_default` flag moves to a surviving replacement policy.
- `org_members_metadata.selected_model` and `model_settings` (effort copy as
  above; the retired key stays).
- `agents.selected_model` and `model_providers.selected_model`. An agent
  pinned to a provider connection keeps its selection unless that provider
  type serves the replacement; the API resolves and rejects it on read.

Never touched: history (`agent_runs`, `chat_events` including queued inputs,
usage and billing, session conversations), `org_plan_entitlements`
restrictions, custom-gateway `model_mappings`, and chat thread selections
(`chat_threads` and its `chat_thread_events` stream). A thread rewrite would
have to append `model_selection_updated` events with reserved sequence
ranges, so the API resolves thread selections along the chain on read instead.

## Constraint design

The repository is retiring database triggers, so every invariant that can be
local is a constraint:

- `UNIQUE (model, lineage_rank)` makes the pair a foreign-key target. The
  self foreign key `(replaced_by, replaced_by_lineage_rank)` →
  `(model, lineage_rank)` with `ON UPDATE CASCADE` rejects dangling targets
  and keeps the copied rank current. Deleting a referenced target is rejected.
- `CHECK (replaced_by_lineage_rank > lineage_rank)` makes every hop strictly
  increase the rank, so no path can return to a row: self-references and
  cycles are impossible. `CHECK (replaced_by <> model)` states the self case
  directly.
- `CHECK ((replaced_by IS NULL) = (replaced_by_lineage_rank IS NULL))` sets
  both replacement columns together, so `MATCH SIMPLE` cannot skip the foreign
  key for a retired row.
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
together with "the default has a runtime adapter", re-checks replacement
chains, and fails the request instead of choosing a default. The catalog is
loaded per request so an operator change is visible to the next request.

## Remaining compatibility removals

Only physical deletions justified by rolling deploys and released clients
remain. Each is removed in a later change once its condition holds:

| Item                                                                             | Kept because                                                                                          | Delete when                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `org_model_policies.is_default` column                                           | API versions from before the catalog still read and write it during the rollout.                      | No deployed API version reads or writes it (the release after this one is fully rolled out).       |
| `run_model_catalog.allow_new_org_policy` column                                  | Older API versions gate adding a policy with it; the new API uses `replaced_by`.                      | No deployed API version reads it, and the owner has decided every unrecognized active-looking row. |
| `subscription_model_catalog` table                                               | Older API versions list personal subscription models from it; the new API reads `model_routes`.       | No deployed API version reads it.                                                                  |
| Response fields `isDefault`, `workspaceDefaultModel`, `workspaceDefaultPolicyId` | Released iOS builds decode `isDefault` as required; they are derived from the catalog system default. | No supported iOS, App or CLI release reads them (force-upgrade floor past the catalog release).    |
