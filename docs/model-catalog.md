# Run Models and Subscription Metadata

## Product boundary

There are two execution sources:

1. Platform **Auto**: `okou-1.0` → `openrouter-codex` → `@preset/okou-1-0`
   by default, with an operator-only `org_metadata.openrouter_preset` override.
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
  "defaultModel": "okou-1.0",
  "models": [
    {
      "model": "okou-1.0",
      "modelLabel": "Auto",
      "defaultProviderType": "built-in",
      "runtimeProviderType": "openrouter-codex",
      "credentialScope": "org",
      "modelProviderId": null
    }
  ]
}
```

The example omits route-status and member-capability fields; the route contract
in `turbo/packages/api-contracts/src/contracts/run-models.ts` and its response
schema `availableRunModelsResponseSchema` (defined in
`turbo/packages/api-contracts/src/contracts/model-providers.ts`) are
authoritative.
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

## Billing and history

Actual Auto settlement continues through `usage_pricing`, existing pricing
resolution and captured usage attribution. Auto reports under `okou-1.0`; its
existing long-context classification threshold is 272001 total input tokens.
Personal subscription runs do not become platform-model usage charges; unrelated
billable tools and connectors retain their existing accounting.

Model names and pricing identities needed by historical records remain readable.
Historical `agent_runs.model_provider` / `model_provider_type` values are treated
as opaque strings. Image generation keeps its own provider keys and pricing.
