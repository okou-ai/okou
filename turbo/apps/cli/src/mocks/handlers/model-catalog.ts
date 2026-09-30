import { http, HttpResponse } from "msw";
import type { ModelCatalogResponse } from "@okouai/api-contracts/contracts/model-catalog";

const CLAUDE_EFFORTS = ["low", "medium", "high", "extra", "max", "ultracode"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type FixtureModel = readonly [
  model: string,
  displayName: string,
  replacedBy: string | null,
  resolvedModel: string,
  priceTier: string | null,
  efforts: readonly string[],
  defaultEffort: string | null,
];

const FIXTURE_MODELS: readonly FixtureModel[] = [
  ["okou-1.0", "Auto", null, "okou-1.0", "$", [], null],
  [
    "claude-fable-5-1",
    "Claude Fable 5.1",
    null,
    "claude-fable-5-1",
    "$$$$",
    CLAUDE_EFFORTS,
    "max",
  ],
  [
    "claude-fable-5",
    "Claude Fable 5",
    "claude-fable-5-1",
    "claude-fable-5-1",
    null,
    [],
    null,
  ],
  [
    "claude-opus-5-5",
    "Claude Opus 5.5",
    null,
    "claude-opus-5-5",
    "$$$",
    CLAUDE_EFFORTS,
    "medium",
  ],
  [
    "claude-opus-5",
    "Claude Opus 5",
    null,
    "claude-opus-5",
    "$$$",
    CLAUDE_EFFORTS,
    "high",
  ],
  [
    "claude-opus-4-8",
    "Claude Opus 4.8",
    "claude-opus-5-5",
    "claude-opus-5-5",
    null,
    [],
    null,
  ],
  [
    "claude-sonnet-5-5",
    "Claude Sonnet 5.5",
    null,
    "claude-sonnet-5-5",
    "$$",
    CLAUDE_EFFORTS,
    "high",
  ],
  [
    "claude-sonnet-5",
    "Claude Sonnet 5",
    null,
    "claude-sonnet-5",
    "$$",
    CLAUDE_EFFORTS,
    "high",
  ],
  [
    "gpt-6-sol",
    "GPT 6 Sol",
    null,
    "gpt-6-sol",
    "$$$",
    [...CODEX_EFFORTS, "ultra"],
    "max",
  ],
  ["gpt-6-luna", "GPT 6 Luna", null, "gpt-6-luna", "$", CODEX_EFFORTS, "max"],
  [
    "gpt-5.6-sol",
    "GPT 5.6 Sol",
    null,
    "gpt-5.6-sol",
    "$$$",
    [...CODEX_EFFORTS, "ultra"],
    "max",
  ],
  [
    "gpt-5.6-luna",
    "GPT 5.6 Luna",
    null,
    "gpt-5.6-luna",
    "$",
    CODEX_EFFORTS,
    "max",
  ],
  ["gpt-5.5", "GPT 5.5", "gpt-6-luna", "gpt-6-luna", null, [], null],
  [
    "deepseek-v4-pro",
    "DeepSeek V4 Pro",
    "gpt-6-luna",
    "gpt-6-luna",
    null,
    [],
    null,
  ],
  [
    "deepseek-v4-flash",
    "DeepSeek V4 Flash",
    null,
    "deepseek-v4-flash",
    "$",
    ["low", "high", "xhigh", "max"],
    "high",
  ],
];

/**
 * A representative slice of the seeded global catalog: `okou-1.0` is the
 * system default and retired models resolve along their replacement chain.
 */
export const MODEL_CATALOG_RESPONSE: ModelCatalogResponse = {
  systemDefaultModel: "okou-1.0",
  models: FIXTURE_MODELS.map(
    ([model, displayName, replacedBy, resolvedModel, priceTier], index) => {
      return {
        model,
        displayName,
        sortOrder: (index + 1) * 10,
        isSystemDefault: model === "okou-1.0",
        replacedBy,
        resolvedModel,
        priceTier,
      };
    },
  ),
  routes: FIXTURE_MODELS.filter(([, , replacedBy]) => {
    return replacedBy === null;
  }).map(([model, , , , priceTier, efforts, defaultEffort]) => {
    return {
      model,
      providerType: "built-in",
      concreteProviderType: "built-in",
      subscriptionType: null,
      upstreamModel: model,
      enabled: true,
      priority: 0,
      serviceTiers: [],
      defaultServiceTier: null,
      efforts: [...efforts],
      defaultEffort,
      priceTier,
    };
  }),
};

const API_ORIGINS = [
  "http://localhost:3000",
  "https://app.okou.ai",
  "https://www.okou.ai",
] as const;

export const modelCatalogHandlers = API_ORIGINS.map((origin) => {
  return http.get(`${origin}/api/model-catalog`, () => {
    return HttpResponse.json(MODEL_CATALOG_RESPONSE, { status: 200 });
  });
});
