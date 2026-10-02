# Global Model Catalog

The run model catalog lives in two database tables, `run_model_catalog` and
`model_routes`, and is served by `GET /api/model-catalog`. The server catalog
is the only product authority for model names, ordering, the system default,
retirement and replacement, display price tiers and route capabilities
(service tiers and reasoning efforts). App, iOS, CLI and integrations read it
instead of code constants for names, order, the default and replacement. Code
still keeps runtime knowledge that is not catalog data: protocol adapters
keyed by provider, never by model ID (framework, environment bindings, Built-in
vendor key pools). A catalog model is runnable iff it resolves to an active row
with an enabled route whose provider has an adapter
(`isCatalogRouteExecutable` in `model-catalog.service.ts`: a Built-in route's
`concrete_provider_type` has a vendor key pool, any other route's
`provider_type` is a known provider type). There is no static list of run
models; IM model pickers (Slack, Teams, Feishu, Discord, Telegram,
AgentPhone) and the CLI list the org's valid policies with catalog display
names, and a model added only as catalog and route rows on an existing
protocol runs end to end.

Remaining model-keyed code data is protocol or billing data, not product
authority:

- `OKOU_MODEL_METADATA` is the OpenRouter preset protocol metadata for
  `okou-1.0`: the preset upstream (`@preset/...`) is opaque, so the Pi and
  Codex runtimes need its context window, output limit and modalities from
  code.
- `PI_RUNTIME_RESOLVABLE_MODELS` (`@okouai/core`) mirrors what the pinned Pi
  runtime can resolve, keyed by Pi provider and the identity the runtime is
  asked for. Built-in and API-key Responses routes ask for the route's
  `upstream_model`, so a catalog-only model whose route points at a known
  upstream (for example `openrouter-codex` → `openai/gpt-6-luna`) runs on
  Pi when its row has a `pi_route_class`; routes that pin `catalogModel`
  (native Claude, Codex subscription, custom gateways, presets) resolve by
  the catalog model ID. Capabilities (context window, output tokens,
  modalities, reasoning) are not catalog columns: the runtime takes them from
  its pinned provider catalog for the upstream model.
  Plan access of restricted plans is catalog data too (see
  [Plan restriction](#plan-restriction)). A
  catalog model without an executable route cannot be the system default, is
  never offered for a new policy and is rejected when selected.

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
| `long_context_min_total_input_tokens`   | Built-in long-context pricing trigger; NULL bills a single tier.                 |

`usage_pricing` remains the billing authority. Routes link to it by
`(kind, provider)`; a foreign key is impossible because its key includes the
category. Routes carry no names or ordering of their own. Personal
subscription routes are
`model_routes` rows with `subscription_type` set.

## Billing chain

`usage_pricing` is the billing authority for Built-in model usage, reached
through the pricing link of the route a run was assigned:

1. **Run creation.** Run creation (the queue pick, or Pi maintenance) selects
   and captures the Built-in concrete route (`builtInModelRuntimeRoute`), then
   `prepareModelUsageContext` (`execution-model-source.service.ts`) reads that
   route's `pricing_provider` from the same catalog snapshot
   (`catalogBuiltInRoute`) as `modelUsageProvider`, together with the billable
   firewalls and the long-context threshold
   `modelUsageLongContextMinTotalInputTokens`, the same route's
   `long_context_min_total_input_tokens` (see
   [Long-context classification](#long-context-classification)). Only Built-in
   runs have billable `model-provider:*` firewalls. The run's selected model,
   display name and upstream ID stay the actual model; only the usage label
   follows the pricing link. A Built-in run whose route has no pricing link
   fails before launch instead of reporting unpriced usage. Admission also
   runs the [route pricing preflight](#route-pricing-preflight).
   These values are written into the run's `runner_job_queue`
   `execution_context` in the same statement that inserts the run. Every
   Runner claim and retry of that run reads the stored context and never the
   catalog, so a started run keeps its pricing identity and captured route
   after an operator relinks or reorders routes; only runs created later use
   the new link.
2. **Runner addon.** The Runner passes `modelUsageProvider` and the threshold
   to the mitm addon through the proxy registry sandbox entry. For each
   billable model response the addon emits one usage event per positive token
   category with `kind = "model"`, `provider = modelUsageProvider` and a
   category from `tokens.input`, `tokens.output`, `tokens.cache_read` and
   `tokens.cache_creation`, with the `.long_context` infix when the response's
   total input reaches the threshold and the `.fast` / `.ultrafast` suffix for
   the observed service tier.
3. **Usage webhook.** The addon posts the events to the sandbox usage webhook,
   which stores them in `usage_event` unchanged.
4. **Settlement.** Settlement (`credit-usage.service.ts`) prices every pending
   event by `(kind, provider, category)` from `usage_pricing`, falling back to
   the provider's `__fallback__` category. A missing row charges zero and
   records the `missing_pricing` billing error.

Usage events and billing history keep the provider they captured; changing a
route's pricing link affects only runs created afterwards. BYOK and subscription routes
have no pricing link (a schema CHECK and the API catalog loader both enforce
it) and are not platform-billed: they have no billable model firewall, and
their `modelUsageProvider` stays the catalog model ID as before.

`usage_pricing` rows are operator data seeded outside migrations, so no schema
constraint or migration check can prove that a linked provider has rows for
every category a route can produce. The API catalog loader validates the link
itself (Built-in: kind `model` and a provider; other routes: none), and new
Built-in runs are admitted only on fully priced routes (below); settlement
still surfaces a missing row on historical usage as `missing_pricing`. Usage displays name
model usage by the run's actual model, not the pricing provider (see
[Usage display](#usage-display)).

### Long-context classification

The long-context threshold is part of a Built-in route's pricing rule, next to
its pricing link: `model_routes.long_context_min_total_input_tokens` is the
inclusive total-input boundary (input + cache read + cache creation) at which
usage on that route bills the `.long_context` categories. NULL means the route
bills a single tier; the schema CHECK and the catalog loader reject a value on
BYOK and subscription routes and a non-positive value anywhere. It is per
route, not per model or pricing provider, because it is a trigger of the
route's `usage_pricing` rule: two routes of one model may price differently,
and a pricing alias never changes a route's threshold. Migration
`1302_model_route_long_context_threshold` backfilled every Built-in route from
the former code resolution (pricing provider, then catalog model, then
upstream model, all 272,001 at the time), so no existing route changed how it
bills. A new model with long-context pricing sets the column on its routes;
no code change or release is needed.

The API captures the assigned route's value into the run's execution context
together with the usage provider, and the Runner forwards it unchanged:

| Hop                                  | Field                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Catalog route                        | `long_context_min_total_input_tokens` (NULL: single tier)                                              |
| API claim / direct-run context       | `modelUsageLongContextMinTotalInputTokens` (positive threshold, `0` = explicit single tier)            |
| Runner `ExecutionContext` → registry | `model_usage_long_context_min_total_input_tokens` → sandbox `modelUsageLongContextMinTotalInputTokens` |
| Addon flow metadata                  | `MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS`                                                      |

The API always sends the assigned route's value (`0` for a NULL route and
for runs that are not platform-billed). Like the pricing link, the captured
value is frozen for the run: relinking or re-thresholding a route affects
only runs created afterwards. Service-tier
suffixes come from the response's observed tier, not from a model-keyed
table. Rollout order is in
[deployment compatibility](deployment-compatibility.md#long-context-threshold-in-the-runner-payload-2026-10-01).

Pi memory Stage 1 extraction follows the same catalog value: the credential
captures the served Built-in route's threshold (Built-in extraction) or the
threshold of the model's highest-priority Built-in route priced under the
model's own ID (BYOK cost observation), and usage classification uses it.

### Usage display

Usage records keep the provider they were billed under. The usage reports
(`GET /api/usage/record` breakdowns, member usage breakdowns and new
`usage.recorded` chat events) join model usage rows to `agent_runs` by
`run_id` and name them by `agent_runs.selected_model`, the model the run
actually used; usage without a run, or whose run row is gone, keeps its
recorded provider. The App maps that model ID to its catalog display name, so
a run billed under a pricing alias reads as the model's own name. Existing
`usage.recorded` events are not rewritten and keep the provider they
captured.

### Route pricing preflight

A new Built-in run must not execute on a route whose billable categories lack
`usage_pricing` (`built-in-route-pricing.ts`). The categories a route can
produce are the four token categories, their `.long_context` variants when
the route has a `long_context_min_total_input_tokens` (the value the Runner
receives),
and, for the run's requested service tier, their `.fast` or `.ultrafast`
variants; standard-tier categories are always included. Each must resolve with
settlement's lookup (`findUsagePricing`: the exact
`(kind, pricing_provider, category)` row, else the provider's `__fallback__`
row), so a route admitted as priced is priced at settlement. The rows for all
of the model's Built-in candidates are read in one query per selection.

- Route selection skips an unpriced candidate like any other unavailable one
  and uses the next priced candidate; with none left, the run is rejected
  with the existing `503 MODEL_PROVIDER_UNAVAILABLE`.
- `prepareModelUsageContext` re-checks the assigned route (including a route
  captured earlier) and rejects with `503 PROVIDER_UNAVAILABLE` naming the
  unpriced categories.
- Catalog reads, BYOK and subscription routes, and historical settlement are
  unaffected.

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
the final active model of its chain. Chains may have several hops (A → B → C):
the schema only requires each hop to point at an existing row with a strictly
higher `lineage_rank` (see [Constraint design](#constraint-design)), so a
replacement target may itself be retired later without rewriting its
referrers. The API
loader (`model-catalog.service.ts`) follows `replaced_by` hop by hop and fails
the request on a dangling target or cycle instead of picking a model;
`resolveCatalogModel` returns the final active model or an explicit unknown
result and never substitutes the system default.

Approved replacements (owner decisions, 2026-09-30). The seeded data happens
to be single-hop; nothing in the schema or the loader depends on that:

| Retired model       | Replacement         |
| ------------------- | ------------------- |
| `claude-fable-5`    | `claude-fable-5-1`  |
| `claude-opus-4-8`   | `claude-opus-5-5`   |
| `claude-sonnet-4-6` | `claude-sonnet-5-5` |
| `deepseek-v4-pro`   | `gpt-6-luna`        |
| `gpt-5.5`           | `gpt-6-luna`        |
| `gpt-5.6-terra`     | `gpt-6-luna`        |
| `okou-1.0-pro`      | `okou-1.0`          |
| `okou-1.0-max`      | `okou-1.0`          |

`gpt-5.6-terra`, `okou-1.0-pro` and `okou-1.0-max` were seeded by migrations
1191 and 1194 and lost their code support in #37363 and #37368. Migration 1298
keeps their rows with their former labels (GPT 5.6 Terra, Okou 1.0 Pro, Okou
1.0 Max), no routes, and retires them into
the targets above (owner decision, 2026-10-01).

Retiring X in favor of Y: if `Y.lineage_rank <= X.lineage_rank`, raise
`Y.lineage_rank` first (raising a rank only widens the gap to its referrers;
`ON UPDATE CASCADE` refreshes their copies), then set `X.replaced_by = Y` and
`X.replaced_by_lineage_rank = Y.lineage_rank` in one statement.

## System default

Exactly one active model is the system default (`okou-1.0`, Auto, today). The
database owns it: the API reads the single row with `is_system_default = true`
on every request (no code constant such as `ORG_DEFAULT_RUN_MODEL` decides it).
It is not stored per organization: `GET /api/model-policies` projects it into
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
connections and plan.

What runtime routing reads from `model_routes` today:

- Built-in candidates: the enabled `built-in` routes of the model, in
  ascending `priority`, with their `concrete_provider_type` and
  `upstream_model`. Only a concrete provider whose adapter (vendor key pool,
  environment bindings) exists in code is used; any other candidate is
  skipped. A previously captured Built-in route is re-checked against the
  current enabled candidates. The Built-in framework follows the primary
  candidate's concrete provider.
- Provider-type compatibility: whether a model can run on a selected BYOK,
  subscription or Built-in route is an enabled `model_routes` row of that
  provider type.
- Personal subscription models are listed from subscription routes.

Upstream model IDs on BYOK and subscription routes come from the route's
`upstream_model` in the API (`catalogProviderUpstreamModel`); the API no
longer calls `getProviderRuntimeModel`.

Pi eligibility is catalog data too: migration `1301_model_catalog_pi_route_class`
adds `run_model_catalog.pi_route_class` (`claude-native`, `gpt-codex`,
`deepseek`; NULL means not Pi-eligible) and `@okouai/core` `pi-execution.ts`
reads it from the catalog row. This work is in progress in the same PR; see
the PR body for its verified state.

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

## Run-scoped snapshot and admission

Each run decision reads one catalog snapshot. The queue pick
(`createThreadClaimRunObjects` in `thread-claim-run.service.ts`) loads it once per claim
(`claimCatalog$`) and passes it to every step from model resolution to run
creation: policy projection, model pin, provider admission, Built-in route
and framework, provider environment, reasoning effort, usage context and
final admission. Pi memory maintenance, the only run created outside the
queue, loads it once per admission and carries it on its model inputs
(`RunModelProviderArgs.catalog`); the provider environment takes the system
default from that snapshot. A chat send loads it once for its validation,
thread settings and input model capture.

The queued or requested model resolves through one function on every path,
`resolveRunSelectionModel` (`model-selection.service.ts`): the catalog model
the ID names — the ID itself, or a route `upstream_model` that belongs to
exactly one catalog model (`catalogModelForSelectedId`, for example
`deepseek/deepseek-v4-flash`) — followed along its replacement chain. Enqueue
validation, the pick (chat and workflow-automation copies of the pick graph),
`resolveModelSelectionPin` and run preparation (`selectedModelOverride`) all
call it; an ID the catalog does not know is rejected at enqueue and pick and
stays the provider's own model on a direct run.

The pick never writes model policies. The former lazy per-organization
policy seeding (`ensureOrgModelPoliciesLocked` under the policy advisory lock)
is removed from the pick: `orgModelPolicyFactsFromSnapshot` projects the
catalog's system default into the policy list read-only, which covers the
case the seeding handled (an organization without a stored default policy).

Admission (`checkOrgPlanRunAdmission` and `checkCatalogRunRoute` in
`run-admission.service.ts`) requires the selected model to be an active
catalog model and a Built-in run to have an enabled Built-in route. The
selected ID is normalized through the catalog as above before both the route
check and the restricted-plan check (`catalogRunModelRouteAccess`), so a
provider-prefixed ID is judged as the model it names. An ID that names no
catalog model is accepted only on the provider's own route and rejected as
retired when every catalog model it is an upstream of is retired. Reasoning
efforts come from the route (`catalogRouteEfforts`,
`catalogRouteDefaultEffort`), and member preference service tiers from the
route's `service_tiers` (`isCatalogFastServiceTierSupported`,
`isCatalogUltrafastServiceTierSupported` in `model-selection.service.ts`).

Remaining reads outside the snapshot: `loadMemberSubscriptionModels`
(`member-subscription-models.service.ts`) still reads subscription routes
from `model_routes` separately during the pick.

## Queued inputs and history

A queued input captures its model at enqueue. At the pick the captured model
is re-resolved against the claim's catalog snapshot, so a model retired after
enqueue runs as its final replacement; an unknown model is rejected
explicitly. Runs that already started are never re-resolved. Historical runs, chat events (including
queued-input events), usage and billing keep the original model ID and are
never rewritten.

History shows the model the run actually used, under that model's own name.
Retired rows stay in the catalog with their own `display_name`, so a run or
credit-usage row of `claude-opus-4-8` reads "Claude Opus 4.8", not the name of
its replacement. The App's credit-usage rows (`lib/credit-usage-display.ts`)
name run models only from the catalog: an ID (the run's model, see
[Usage display](#usage-display)) that is a catalog model
uses that row; an upstream route ID such as `openai/gpt-6-luna` maps to the one
catalog model whose `model_routes.upstream_model` it is; anything else is
shown verbatim. Image and video generation models are not run models and are
not in this catalog; their labels still come from the generation model tables
in `@okouai/core`.

## Stored-configuration migration

Migration `1299_model_catalog_stored_selections` rewrites mutable stored
selections of retired models to the final active model of their chain. It is
re-runnable (it only selects rows that still reference a retired model) and
takes the per-organization policy advisory locks in `org_id` order.

- `org_model_policies.model`: rewritten only when the replacement has an
  enabled route of the same provider type. Incompatible retired policies are
  dropped rather than transplanted (the count is logged via `RAISE NOTICE`).
  One policy per organization and replacement survives: an existing
  replacement policy wins, otherwise the oldest.
- `org_members_metadata.selected_model` and `model_settings` (effort copy as
  above; the retired key stays).
- `agents.selected_model` and `model_providers.selected_model`. An agent
  pinned to a provider connection keeps its selection unless that provider
  type serves the replacement; the API resolves and rejects it on read.
- Chat thread selections (`chat_threads.selected_model` and `model_settings`),
  appending one `model_selection_updated` event per re-pinned thread with an
  agent. A thread whose legacy provider pin has no enabled route on the
  replacement keeps its retired model and pin; the API resolves it along the
  chain on read and rejects the incompatible route explicitly.

Never touched: history (`agent_runs`, `chat_events` including queued inputs,
usage and billing, session conversations) and custom-gateway
`model_mappings`. `org_plan_entitlements.restricted_built_in_models` is a
boolean and stores no model IDs, so there is nothing to rewrite there (see
[Plan restriction](#plan-restriction)).

Production impact: as of MaskDB on 2026-09-30, no chat thread, organization
policy, member preference, agent or model provider references any of
`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `deepseek-v4-pro`,
`gpt-5.5`, `gpt-5.6-terra`, `okou-1.0-pro` or `okou-1.0-max`. The migration
therefore rewrites zero production rows. The single-transaction thread scan
needs no batching: measured on synthetic data at production and 5x scale it
finishes in 0.2 s and 1.3 s (see `turbo/packages/db/MIGRATIONS.md`,
"Migration 1299 performance evidence").

## Plan restriction (free plans)

`org_plan_entitlements.restricted_built_in_models` marks a free plan. It is
true for `limited-free-1`, the only current free organization tier. Legacy
Free is retired; the database rejects its tier and plan key. Paid plans
(`pro`, `team`, `custom`) keep it false and their model access is unchanged.

A free organization may run a model only on:

1. **Built-in**, when the catalog row has `built_in_on_restricted_plans`
   (default false; migration `1300_model_catalog_restricted_plans` seeds it
   true only for `okou-1.0`). Every other model, and every model added later,
   is paid-only on Built-in until an operator flips the row; no code list
   exists.
2. **The member's own personal subscription**: a connected, valid (not
   reconnect-required) Claude Code or Codex account held by the requesting
   member, used with member credential scope through the model's catalog
   subscription route (`model_routes.subscription_type`), in Auto and Custom
   mode alike (a Custom member-scope Claude Code or Codex policy qualifies).
   One predicate, `isMemberSubscriptionRoute`, decides it from current
   connection facts for policy projections, explicit selection, pre-queue
   admission, the queue pick and the claim; a model name or provider type
   alone is never exempt. Such a run is billed to the subscription, never
   to Built-in usage, and does not fall back to Built-in.

Organization API keys (BYOK), organization-scoped credentials and custom
gateways are not a free-plan entitlement on any model.

`getCatalogRunModelRouteAccess` (`@okouai/api-contracts`) applies rule 1; the
API decides rule 2 first and passes an unrestricted plan when it holds. The
API reads the flag through `catalogRunModelRouteAccess` for policy writes and
run admission (send, queue pick, claim), after normalizing the selected ID
through the catalog (a provider-prefixed upstream ID of exactly one catalog
model is that model), consistently with `checkCatalogRunRoute`. A denied
catalog model returns `PRO_REQUIRED` naming the model's `display_name`, the
catalog's free Built-in models and the subscription alternative
(`restrictedPlanModelRequired`); member policy projections report
`plan_restricted`. Stored selections of a now-restricted model (member
preferences, thread selections, stored policies) are kept and fail explicitly
with that error; they are not replaced (`replaced_by` is a global retirement,
not a plan rule). The Platform reads the same flag from the catalog response.

`packages/db/scripts/test-model-catalog-seed.ts` (run by the migration
consistency check) verifies the seeded entitlement: the flag is set on every
row and is true for exactly `okou-1.0`.

Custom-gateway mapping is also route data: a model may be served by a custom
gateway when it has no enabled non-Built-in route, or when one of those routes
is a third-party gateway type (`catalogModelAllowsCustomGateway`).

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
