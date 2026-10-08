# Run Models and Subscription Metadata

## Product boundary

There are two execution sources:

1. Platform **Auto**: the empty (`null`) selection. Its runs use the internal
   run model `okou-1.0` → `openrouter-codex` → `@preset/okou-1-0` by default,
   with an operator-only `org_metadata.openrouter_preset` override.
2. A member's connected personal ChatGPT/Codex or Claude subscription.

Auto is defined by `@okouai/core/auto-run-model`, not a mutable platform-model
directory. Catalog entries cannot add platform candidates,
change Auto's upstream, or provide a vendor fallback. Only nullable operator
metadata projects an organization preset: NULL/absent uses the ordinary default,
invalid values reject, and captured launches retain their preset. Logical model,
vendor, pricing and token limits stay fixed; there is no preset management API/UI. Auto runs use Pi/OpenRouter;
personal Codex follows its admitted runtime capabilities and personal Claude
continues through the vendor harness.

## Public read APIs

### `GET /api/run-models`

Returns the authenticated member's available choices:

```json
{
  "models": [
    {
      "model": null,
      "modelLabel": "Auto",
      "modelProviderId": null,
      "memberEffective": {
        "providerType": "built-in",
        "runtimeProviderType": "openrouter-codex",
        "credentialScope": "org",
        "availability": "available",
        "accountSelection": "not_applicable"
      }
    }
  ]
}
```

The example omits subscription option fields; the route contract
in `turbo/packages/api-contracts/src/contracts/run-models.ts` and its response
schema `availableRunModelsResponseSchema` (defined in
`turbo/packages/api-contracts/src/contracts/model-providers.ts`) are
authoritative.
The Auto entry has `model: null` and is always the default.
Unconnected members have only Auto. Personal entries reflect the caller's own
subscription accounts, route status, subscription options and effective member
capabilities. An organization administrator does not gain another member's
subscription credentials.

### `GET /api/model-catalog`

Supplies readonly Auto and personal-subscription metadata: display names,
upstream identifiers, service tiers, reasoning efforts and Pi capability classes.
It is not a platform-model configuration API. Auto/default metadata is derived
from the fixed code constants; public comparison-price fields are null.

The remaining database catalog supports subscription capabilities, replacement
lineage and historical model identity. Keeping historical rows does not admit
those models as platform choices. Invalid subscription metadata is reported as an
operator error rather than silently inventing a route.

## Selection and credentials

- Auto is represented only by `null`: thread `selected_model`, member
  preference, create/send/metadata request `model`, `/api/run-models` and
  CLI/iOS/Web payloads. `okou-1.0` is the Auto run model id (captured inputs,
  `agent_runs.selected_model`, the catalog row, pricing); it is not a selection
  value and is rejected like any other unselectable id.
- Auto requires no provider connection or model-provider ID. Persisted/wire
  `credentialScope: "org"` denotes Auto; personal subscriptions use `member`.
- Personal provider management uses `/api/me/model-providers` and the supported
  ChatGPT/Codex and Claude subscription connection flows.
- Personal selection retains account ownership, reconnect behavior, supported
  effort and Codex service-tier validation.
- User preferences and automation selections retain valid subscription choices.
  A stored selection that is neither Auto nor an available personal subscription
  model fails closed with an explicit error; it never silently becomes Auto.
  Catalog resolution follows `replaced_by` chains and reports unknown models
  instead of substituting the system default.
- Built-in key availability still applies to the fixed OpenRouter route. A
  provider failure fails that run; there is no route cooldown, and the next
  request tries the route again. Failure is not permission to choose another
  platform model/vendor.

## Retired models

A retired model keeps its `run_model_catalog` row with `replaced_by` set; chains
are allowed and resolve to the final active model. Retired models have no
routes and are never offered as choices.

- Capturing an input resolves the selection to the final successor. The input,
  the run and `agent_runs.selected_model` record the successor.
- When a thread's stored or requested selection is a retired model, the
  transaction that enqueues the input also rewrites the thread: the
  `chat_threads.selected_model` snapshot becomes the successor and one
  `model_selection_updated` event carries it. A Fast tier the successor does
  not offer is cleared with a `service_tier_updated` event. Every send and
  enqueue entry point (Web, CLI, iOS, MCP, integrations and workflow
  automations) shares this capture. Unless the send itself selects a model, the
  rewrite only applies while the thread still stores the retired model, so a
  concurrent model change wins and the rewrite writes no events; the input
  still runs the successor it captured.
- A thread that is not sent to keeps its stored id until its next input.
  Clients display the successor through the catalog's `resolvedModel`. Web
  shows and sends the successor when the member can run it; like any
  unavailable pin, it otherwise shows Auto and its send selects Auto.
- Model selection writes (metadata PATCH, MCP thread updates and integration `/model`) store the
  successor in both the snapshot and its event, so event replay never restores
  a retired id.
- When the successor requires a personal subscription the member has no
  account for, the send is rejected with a message naming the required
  subscription (select Auto or connect it). A connected account that needs
  reconnecting, or a disconnected account that is still retained, keeps the
  subscription; its input is accepted and the pick reports the reconnect error.
  Integration and automation inputs that cannot capture are enqueued unchanged
  and the queue pick rejects them visibly with the same message, or with the
  reconnect error when the member retains an account of that subscription.

## Billing and history

Actual Auto settlement continues through `usage_pricing`, existing pricing
resolution and captured usage attribution. Auto runs report under the run model `okou-1.0`; its
existing long-context classification threshold is 272001 total input tokens.
Personal subscription runs do not become platform-model usage charges; unrelated
billable tools and connectors retain their existing accounting.

Model names and pricing identities needed by historical records remain readable.
Historical `agent_runs.model_provider` / `model_provider_type` values are treated
as opaque strings. Image generation keeps its own provider keys and pricing.
