import type { PiCatalogSource } from "../pi-execution";

/**
 * Active rows of `run_model_catalog` and every `model_routes` row remaining
 * after migration 1326 (Auto on `openrouter-codex` plus personal Claude Code
 * and Codex subscriptions), so admission tests read the same catalog data the
 * API serves.
 */
export const SEEDED_MODEL_CATALOG: PiCatalogSource = {
  models: [
    { model: "okou-1.0", piRouteClass: "gpt-codex" },
    { model: "claude-fable-5-1", piRouteClass: null },
    { model: "claude-opus-5-5", piRouteClass: null },
    { model: "claude-opus-5", piRouteClass: null },
    { model: "claude-sonnet-5-5", piRouteClass: null },
    { model: "claude-sonnet-5", piRouteClass: null },
    { model: "gpt-6-astra", piRouteClass: null },
    { model: "gpt-6.1-sol", piRouteClass: "gpt-codex" },
    { model: "gpt-6-sol", piRouteClass: "gpt-codex" },
    { model: "gpt-6-luna", piRouteClass: "gpt-codex" },
    { model: "gpt-5.6-sol", piRouteClass: "gpt-codex" },
    { model: "gpt-5.6-luna", piRouteClass: "gpt-codex" },
    { model: "deepseek-v4.1-flash", piRouteClass: null },
    { model: "deepseek-v4-flash", piRouteClass: null },
  ],
  routes: [
    {
      model: "claude-fable-5-1",
      providerType: "claude-code-oauth-token",
      concreteProviderType: "claude-code-oauth-token",
      subscriptionType: "claude-code-oauth-token",
      upstreamModel: "claude-fable-5-1",
      enabled: true,
      priority: 0,
      serviceTiers: [],
    },
    {
      model: "claude-opus-5-5",
      providerType: "claude-code-oauth-token",
      concreteProviderType: "claude-code-oauth-token",
      subscriptionType: "claude-code-oauth-token",
      upstreamModel: "claude-opus-5-5",
      enabled: true,
      priority: 0,
      serviceTiers: [],
    },
    {
      model: "claude-sonnet-5-5",
      providerType: "claude-code-oauth-token",
      concreteProviderType: "claude-code-oauth-token",
      subscriptionType: "claude-code-oauth-token",
      upstreamModel: "claude-sonnet-5-5",
      enabled: true,
      priority: 0,
      serviceTiers: [],
    },
    {
      model: "deepseek-v4.1-flash",
      providerType: "built-in",
      concreteProviderType: "openrouter-codex",
      subscriptionType: null,
      upstreamModel: "deepseek/deepseek-v4.1-flash",
      enabled: true,
      priority: 1,
      serviceTiers: [],
    },
    {
      model: "gpt-6-astra",
      providerType: "codex-oauth-token",
      concreteProviderType: "codex-oauth-token",
      subscriptionType: "codex-oauth-token",
      upstreamModel: "gpt-6-astra",
      enabled: true,
      priority: 0,
      serviceTiers: ["priority"],
    },
    {
      model: "gpt-6-luna",
      providerType: "codex-oauth-token",
      concreteProviderType: "codex-oauth-token",
      subscriptionType: "codex-oauth-token",
      upstreamModel: "gpt-6-luna",
      enabled: true,
      priority: 0,
      serviceTiers: ["priority"],
    },
    {
      model: "gpt-6-sol",
      providerType: "codex-oauth-token",
      concreteProviderType: "codex-oauth-token",
      subscriptionType: "codex-oauth-token",
      upstreamModel: "gpt-6-sol",
      enabled: true,
      priority: 0,
      serviceTiers: ["priority"],
    },
    {
      model: "gpt-6.1-sol",
      providerType: "codex-oauth-token",
      concreteProviderType: "codex-oauth-token",
      subscriptionType: "codex-oauth-token",
      upstreamModel: "gpt-6.1-sol",
      enabled: true,
      priority: 0,
      serviceTiers: ["priority"],
    },
    {
      model: "okou-1.0",
      providerType: "built-in",
      concreteProviderType: "openrouter-codex",
      subscriptionType: null,
      upstreamModel: "@preset/okou-1-0",
      enabled: true,
      priority: 0,
      serviceTiers: [],
    },
  ],
};

/** Distinct provider types of a model's enabled seeded routes. */
export function seededProviderTypes(model: string): readonly string[] {
  return [
    ...new Set(
      SEEDED_MODEL_CATALOG.routes
        .filter((route) => {
          return route.enabled && route.model === model;
        })
        .map((route) => {
          return route.providerType;
        }),
    ),
  ];
}

/** Seeded catalog models with at least one enabled route, in catalog order. */
export const SEEDED_ROUTED_MODELS: readonly string[] =
  SEEDED_MODEL_CATALOG.models
    .map((entry) => {
      return entry.model;
    })
    .filter((model) => {
      return seededProviderTypes(model).length > 0;
    });
