import {
  modelCatalogContract,
  type ModelCatalogResponse,
} from "@okouai/api-contracts/contracts/model-catalog";
import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import {
  AUTO_RUN_MODEL,
  AUTO_RUN_PROVIDER,
  AUTO_RUN_UPSTREAM_MODEL,
} from "@okouai/core/auto-run-model";
import { mockApi } from "../msw-contract.ts";

type MockCatalogModel = ModelCatalogResponse["models"][number];
type MockCatalogRoute = ModelCatalogResponse["routes"][number];

const CLAUDE_EFFORTS = ["low", "medium", "high", "extra", "max", "ultracode"];
const GPT_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const GPT_LUNA_EFFORTS = ["low", "medium", "high", "xhigh"];
// Mirrors the seeded production catalog rows, including retired models and
// their single-hop replacements. DeepSeek V4.1 Flash backs memory maintenance
// and is never offered as a foreground route.
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
  ["gpt-5.6-terra", "GPT 5.6 Terra", 200, "gpt-6-luna"],
  ["okou-1.0-pro", "Okou 1.0 Pro", 210, "okou-1.0"],
  ["okou-1.0-max", "Okou 1.0 Max", 220, "okou-1.0"],
];

interface MockSubscriptionProfile {
  efforts: readonly string[];
  defaultEffort: string | null;
  serviceTiers: readonly string[];
  subscription: "claude-code-oauth-token" | "codex-oauth-token";
}

/** The personal subscription route of a model; null without one. */
function subscriptionProfileFor(model: string): MockSubscriptionProfile | null {
  if (model.startsWith("claude-")) {
    return {
      efforts: CLAUDE_EFFORTS,
      defaultEffort: model.startsWith("claude-fable") ? "max" : "high",
      serviceTiers: [],
      subscription: "claude-code-oauth-token",
    };
  }
  if (!model.startsWith("gpt-")) {
    return null;
  }
  const luna = model.includes("luna");
  return {
    efforts: luna
      ? GPT_LUNA_EFFORTS
      : model === "gpt-5.5"
        ? [...GPT_LUNA_EFFORTS, "max"]
        : GPT_EFFORTS,
    defaultEffort: luna ? "xhigh" : "max",
    serviceTiers: ["priority"],
    subscription: "codex-oauth-token",
  };
}

const AUTO_ROUTE: MockCatalogRoute = {
  model: AUTO_RUN_MODEL,
  providerType: "built-in",
  concreteProviderType: AUTO_RUN_PROVIDER,
  subscriptionType: null,
  upstreamModel: AUTO_RUN_UPSTREAM_MODEL,
  enabled: true,
  priority: 0,
  serviceTiers: [],
  defaultServiceTier: null,
  efforts: [],
  defaultEffort: null,
};

function subscriptionRouteFor(
  model: string,
  replacedBy: string | null,
): MockCatalogRoute[] {
  const profile = subscriptionProfileFor(model);
  if (!profile || replacedBy !== null) {
    return [];
  }
  return [
    {
      model,
      providerType: profile.subscription,
      concreteProviderType: profile.subscription,
      subscriptionType: profile.subscription,
      upstreamModel: model,
      enabled: true,
      priority: 0,
      serviceTiers: [...profile.serviceTiers],
      defaultServiceTier: null,
      efforts: [...profile.efforts],
      defaultEffort: profile.defaultEffort,
    },
  ];
}

function resolveReplacement(model: string): string {
  const row = MODEL_ROWS.find(([candidate]) => {
    return candidate === model;
  });
  return row?.[3] ? resolveReplacement(row[3]) : model;
}

/** Seeded `run_model_catalog.built_in_on_restricted_plans` (migration 1300). */
const RESTRICTED_PLAN_BUILT_IN_MODELS: ReadonlySet<string> = new Set([
  "okou-1.0",
]);

/** Seeded `run_model_catalog.pi_route_class` (migration 1301). */
const PI_ROUTE_CLASS_BY_MODEL: Readonly<Record<string, "gpt-codex">> = {
  "okou-1.0": "gpt-codex",
  "gpt-6.1-sol": "gpt-codex",
  "gpt-6-sol": "gpt-codex",
  "gpt-6-luna": "gpt-codex",
  "gpt-5.6-sol": "gpt-codex",
  "gpt-5.6-luna": "gpt-codex",
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
        replacedBy,
        resolvedModel: resolveReplacement(model),
        builtInOnRestrictedPlans: RESTRICTED_PLAN_BUILT_IN_MODELS.has(model),
        piRouteClass: PI_ROUTE_CLASS_BY_MODEL[model] ?? null,
      };
    },
  );
  return {
    systemDefaultModel,
    models,
    routes: [
      AUTO_ROUTE,
      ...MODEL_ROWS.flatMap((row) => {
        return subscriptionRouteFor(row[0], row[3]);
      }),
    ],
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

export function mockCatalogBuiltInProvider(
  model: string,
): AvailableRunModel["runtimeProviderType"] {
  return (mockModelCatalog.routes.find((route) => {
    return route.model === model && route.providerType === "built-in";
  })?.concreteProviderType ?? null) as AvailableRunModel["runtimeProviderType"];
}

export function setMockModelCatalogSystemDefault(model: string): void {
  mockModelCatalog = createMockModelCatalog(model);
}

/** Operators change a model's plan runModel for restricted plans. */
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
