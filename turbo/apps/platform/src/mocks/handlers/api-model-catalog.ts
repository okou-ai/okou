import {
  modelCatalogContract,
  type ModelCatalogResponse,
} from "@okouai/api-contracts/contracts/model-catalog";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { mockApi } from "../msw-contract.ts";

type MockCatalogModel = ModelCatalogResponse["models"][number];
type MockCatalogRoute = ModelCatalogResponse["routes"][number];

const CLAUDE_EFFORTS = ["low", "medium", "high", "extra", "max", "ultracode"];
const GPT_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const GPT_LUNA_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEEPSEEK_EFFORTS = ["low", "high", "xhigh", "max"];
const ANTHROPIC_BYOK = [
  "anthropic-api-key",
  "openrouter-api-key",
  "vercel-ai-gateway",
  "azure-foundry",
  "aws-bedrock",
  "custom-anthropic-messages",
] as const;
const OPENAI_BYOK = [
  "openai-api-key",
  "openrouter-codex",
  "vercel-ai-gateway-codex",
  "custom-openai-responses",
] as const;

// Mirrors the seeded production catalog (migration 1298), including retired
// models and their single-hop replacements.
const MODEL_ROWS: readonly (readonly [
  model: string,
  displayName: string,
  sortOrder: number,
  replacedBy: string | null,
])[] = [
  ["okou-1.0", "Auto", 10, null],
  ["claude-fable-5-1", "Claude Fable 5.1", 20, null],
  ["claude-fable-5", "Claude Fable 5", 30, "claude-fable-5-1"],
  ["claude-opus-5-5", "Claude Opus 5.5", 40, null],
  ["claude-opus-5", "Claude Opus 5", 50, null],
  ["claude-opus-4-8", "Claude Opus 4.8", 60, "claude-opus-5-5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", 70, null],
  ["claude-sonnet-5", "Claude Sonnet 5", 80, null],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 90, "claude-sonnet-5-5"],
  ["gpt-6-astra", "GPT 6 Astra", 100, null],
  ["gpt-6.1-sol", "GPT 6.1 Sol", 110, null],
  ["gpt-6-sol", "GPT 6 Sol", 120, null],
  ["gpt-6-luna", "GPT 6 Luna", 130, null],
  ["gpt-5.6-sol", "GPT 5.6 Sol", 140, null],
  ["gpt-5.6-luna", "GPT 5.6 Luna", 150, null],
  ["gpt-5.5", "GPT 5.5", 160, "gpt-6-luna"],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 170, null],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 180, "gpt-6-luna"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 190, null],
];

interface MockModelProfile {
  builtIn: string;
  priceTier: string;
  efforts: readonly string[];
  defaultEffort: string | null;
  serviceTiers: readonly string[];
  byok: readonly string[];
  subscription: string | null;
}

function profileFor(model: string): MockModelProfile {
  if (model === "okou-1.0") {
    return {
      builtIn: "openrouter-codex",
      priceTier: "$",
      efforts: [],
      defaultEffort: null,
      serviceTiers: [],
      byok: [],
      subscription: null,
    };
  }
  if (model.startsWith("claude-")) {
    const premium = model.startsWith("claude-fable");
    const opus = model.startsWith("claude-opus");
    return {
      builtIn: "anthropic-api-key",
      priceTier: premium ? "$$$$" : opus ? "$$$" : "$$",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: premium ? "max" : "high",
      serviceTiers: [],
      byok: ANTHROPIC_BYOK,
      subscription: "claude-code-oauth-token",
    };
  }
  if (model.startsWith("deepseek-")) {
    return {
      builtIn: "deepseek",
      priceTier: "$",
      efforts: model === "deepseek-v4.1-flash" ? [] : DEEPSEEK_EFFORTS,
      defaultEffort: model === "deepseek-v4.1-flash" ? null : "high",
      serviceTiers: [],
      byok: ["deepseek", "openrouter-codex", "custom-openai-responses"],
      subscription: null,
    };
  }
  const luna = model.includes("luna") || model === "gpt-5.5";
  return {
    builtIn: "openai-api-key",
    priceTier: model === "gpt-6-astra" ? "$$$$" : luna ? "$" : "$$$",
    efforts: luna ? GPT_LUNA_EFFORTS : GPT_EFFORTS,
    defaultEffort: "max",
    serviceTiers: ["priority"],
    byok: OPENAI_BYOK,
    subscription: "codex-oauth-token",
  };
}

function gatewayUpstreamModel(model: string, providerType: string): string {
  if (
    providerType !== "openrouter-codex" &&
    providerType !== "vercel-ai-gateway-codex"
  ) {
    return model;
  }
  return `${model.startsWith("deepseek-") ? "deepseek" : "openai"}/${model}`;
}

function routesFor(model: string): MockCatalogRoute[] {
  const profile = profileFor(model);
  const base = {
    model,
    subscriptionType: null,
    upstreamModel: model,
    enabled: true,
    priority: 0,
    efforts: [...profile.efforts],
    defaultEffort: profile.defaultEffort,
  };
  const routes: MockCatalogRoute[] = [
    {
      ...base,
      providerType: "built-in",
      concreteProviderType: profile.builtIn,
      serviceTiers: [...profile.serviceTiers],
      defaultServiceTier: null,
      priceTier: profile.priceTier,
    },
  ];
  for (const providerType of profile.byok) {
    routes.push({
      ...base,
      // Gateway routes send the vendor-prefixed upstream ID, as seeded.
      upstreamModel: gatewayUpstreamModel(model, providerType),
      providerType,
      concreteProviderType: providerType,
      // Astra Ultrafast is temporarily disabled: the seeded direct OpenAI
      // route offers no Ultrafast tier, as in migration 1298.
      serviceTiers: [...profile.serviceTiers],
      defaultServiceTier: null,
      priceTier: null,
    });
  }
  if (profile.subscription) {
    routes.push({
      ...base,
      providerType: profile.subscription,
      concreteProviderType: profile.subscription,
      serviceTiers: [...profile.serviceTiers],
      defaultServiceTier: null,
      priceTier: null,
    });
  }
  return routes;
}

function resolveReplacement(model: string): string {
  const row = MODEL_ROWS.find(([candidate]) => {
    return candidate === model;
  });
  return row?.[3] ? resolveReplacement(row[3]) : model;
}

// Plan policy seeded by migration 1300.
/** Seeded `run_model_catalog.built_in_on_restricted_plans` (migration 1300). */
const RESTRICTED_PLAN_BUILT_IN_MODELS: ReadonlySet<string> = new Set([
  "okou-1.0",
]);

/** Seeded `run_model_catalog.pi_route_class` (migration 1301). */
const PI_ROUTE_CLASS_BY_MODEL: Readonly<
  Record<string, "claude-native" | "gpt-codex" | "deepseek">
> = {
  "okou-1.0": "gpt-codex",
  "claude-opus-5-5": "claude-native",
  "claude-opus-5": "claude-native",
  "claude-sonnet-5-5": "claude-native",
  "claude-sonnet-5": "claude-native",
  "gpt-6.1-sol": "gpt-codex",
  "gpt-6-sol": "gpt-codex",
  "gpt-6-luna": "gpt-codex",
  "gpt-5.6-sol": "gpt-codex",
  "gpt-5.6-luna": "gpt-codex",
  "deepseek-v4.1-flash": "deepseek",
  "deepseek-v4-flash": "deepseek",
};

/** The seeded catalog's system default. */
export const MOCK_SYSTEM_DEFAULT_MODEL = "okou-1.0";

export function createMockModelCatalog(
  systemDefaultModel = MOCK_SYSTEM_DEFAULT_MODEL,
): ModelCatalogResponse {
  const models: MockCatalogModel[] = MODEL_ROWS.map(
    ([model, displayName, sortOrder, replacedBy]) => {
      return {
        model,
        displayName,
        sortOrder,
        isSystemDefault: model === systemDefaultModel,
        replacedBy,
        resolvedModel: resolveReplacement(model),
        priceTier: profileFor(model).priceTier,
        builtInOnRestrictedPlans: RESTRICTED_PLAN_BUILT_IN_MODELS.has(model),
        piRouteClass: PI_ROUTE_CLASS_BY_MODEL[model] ?? null,
      };
    },
  );
  return {
    systemDefaultModel,
    models,
    routes: MODEL_ROWS.flatMap(([model]) => {
      return routesFor(model);
    }),
  };
}

let mockModelCatalog: ModelCatalogResponse = createMockModelCatalog();

export function getMockModelCatalog(): ModelCatalogResponse {
  return mockModelCatalog;
}

/** Test lookups against the current mock catalog. */
export function mockCatalogDisplayName(model: string): string {
  return (
    mockModelCatalog.models.find((entry) => {
      return entry.model === model;
    })?.displayName ?? model
  );
}

export function mockCatalogHasModel(model: string | null | undefined) {
  return mockModelCatalog.models.some((entry) => {
    return entry.model === model;
  });
}

export function mockCatalogActiveModels(): string[] {
  return mockModelCatalog.models
    .filter((entry) => {
      return entry.replacedBy === null;
    })
    .map((entry) => {
      return entry.model;
    });
}

export function mockCatalogBuiltInProvider(
  model: string,
): OrgModelPolicy["runtimeProviderType"] {
  return (mockModelCatalog.routes.find((route) => {
    return route.model === model && route.providerType === "built-in";
  })?.concreteProviderType ?? null) as OrgModelPolicy["runtimeProviderType"];
}

export function setMockModelCatalogSystemDefault(model: string): void {
  mockModelCatalog = createMockModelCatalog(model);
}

/** Operators change a model's plan policy for restricted plans. */
export function setMockModelCatalogRestrictedPlanAccess(
  model: string,
  access: Pick<MockCatalogModel, "builtInOnRestrictedPlans">,
): void {
  mockModelCatalog = {
    ...mockModelCatalog,
    models: mockModelCatalog.models.map((entry) => {
      return entry.model === model ? { ...entry, ...access } : entry;
    }),
  };
}

export function resetMockModelCatalog(): void {
  mockModelCatalog = createMockModelCatalog();
}

export const apiModelCatalogHandlers = [
  mockApi(modelCatalogContract.get, ({ respond }) => {
    return respond(200, mockModelCatalog);
  }),
];
