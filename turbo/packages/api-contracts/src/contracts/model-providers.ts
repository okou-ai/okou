import { z } from "zod";

import DEEPSEEK_V4_FLASH_MODEL_CATALOG from "./deepseek-model-catalog.json" with { type: "json" };
import {
  MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS,
  SUPPORTED_RUN_MODELS,
  BUILT_IN_MODEL_PRICE_TIER,
  type SupportedRunModel,
  type ModelPriceTier,
} from "./model-price-tiers";
import {
  MODEL_PROVIDER_TYPE_IDS,
  isBuiltInModelProviderType,
  type ModelProviderFramework,
  type ModelProviderType,
} from "./model-provider-types";
export { isBuiltInModelProviderType } from "./model-provider-types";
export {
  getModelProviderFirewall,
  getModelProviderPiChatCompletionsUrl,
  getModelProviderPiEndpoint,
  MODEL_PROVIDER_PI_APIS,
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "./model-provider-firewalls";
export type {
  ModelProviderPiApi,
  ModelProviderPiEndpoint,
} from "./model-provider-firewalls";
export type {
  BuiltInModelProviderType,
  ModelProviderFramework,
  ModelProviderType,
  ModelProviderWriteType,
} from "./model-provider-types";

const deepseekV4FlashCatalogModel = DEEPSEEK_V4_FLASH_MODEL_CATALOG.models[0];
if (!deepseekV4FlashCatalogModel) {
  throw new Error("DeepSeek V4 Flash model catalog entry is required");
}

const deepseekV41FlashCatalogModel = {
  ...deepseekV4FlashCatalogModel,
  slug: "deepseek-v4.1-flash",
  display_name: "DeepSeek-V4.1-Flash",
  input_modalities: ["text", "image"],
};

const DEEPSEEK_V4_1_FLASH_MODEL_CATALOG = {
  ...DEEPSEEK_V4_FLASH_MODEL_CATALOG,
  models: [deepseekV41FlashCatalogModel],
};

const DEEPSEEK_MODEL_CATALOG = {
  ...DEEPSEEK_V4_FLASH_MODEL_CATALOG,
  models: [
    deepseekV4FlashCatalogModel,
    {
      ...deepseekV4FlashCatalogModel,
      slug: "deepseek-v4-pro",
      display_name: "DeepSeek-V4-Pro",
    },
  ],
};

export {
  MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS,
  SUPPORTED_RUN_MODELS,
  BUILT_IN_MODEL_PRICE_TIER,
  type SupportedRunModel,
  type ModelPriceTier,
};

/**
 * Secret field configuration for multi-secret providers
 */
export interface SecretFieldConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  /**
   * When true, this secret is persisted server-side and MUST NOT flow to the
   * runner/sandbox. Used for OAuth refresh tokens and ID tokens that the
   * server holds for refresh + plan-type validation but the sandbox must
   * never see (per #7365). Honored by `resolveMultiAuthProviderSecrets`.
   */
  serverOnly?: boolean;
  /**
   * When true, this secret is populated by a server-side parser from another
   * secret in the same authMethod (typically a single user-input field whose
   * raw value is exploded into multiple stored fields). UI MUST NOT render an
   * input for this secret; the storage validation layer still uses it.
   *
   * Example: `codex-oauth-token` / `auth_json` — user pastes `CODEX_AUTH_JSON`,
   * server parser writes `CHATGPT_ACCESS_TOKEN` / `_REFRESH_TOKEN` /
   * `_ACCOUNT_ID` / `_ID_TOKEN`. Those four are `derived: true`.
   */
  derived?: boolean;
}

/**
 * Auth method configuration for providers with multiple auth options
 */
export interface AuthMethodConfig {
  label: string;
  helpText?: string;
  secrets: Record<string, SecretFieldConfig>;
}

export type ModelProviderEnvBindings = Record<string, string>;

export const modelProviderCodexRuntimeConfigSchema = z.object({
  providerId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  baseUrl: z.url(),
  envKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  httpHeaders: z.record(z.string(), z.string()).optional(),
  requiresOpenaiAuth: z.boolean().optional(),
  wireApi: z.literal("responses"),
  supportsWebsockets: z.boolean(),
  modelCatalog: z.record(z.string(), z.unknown()).optional(),
});

export type ModelProviderCodexRuntimeConfig = z.infer<
  typeof modelProviderCodexRuntimeConfigSchema
>;

const MODEL_PROVIDER_CODEX_RUNTIME_CONFIGS: Partial<
  Record<ModelProviderType, ModelProviderCodexRuntimeConfig>
> = {
  deepseek: {
    providerId: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    envKey: "OPENAI_API_KEY",
    requiresOpenaiAuth: false,
    wireApi: "responses",
    supportsWebsockets: false,
    modelCatalog: DEEPSEEK_MODEL_CATALOG,
  },
};

export const DEFAULT_ORG_MODEL_POLICY_MODELS = [
  "gpt-6-astra",
  "gpt-5.6-luna",
  "deepseek-v4.1-flash",
] as const satisfies readonly SupportedRunModel[];

export const DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL =
  "deepseek-v4.1-flash" as const satisfies SupportedRunModel;

export const LIMITED_FREE1_DEFAULT_RUN_MODEL =
  "deepseek-v4.1-flash" as const satisfies SupportedRunModel;

export const supportedRunModelSchema = z.enum(SUPPORTED_RUN_MODELS);

export const modelProviderCredentialScopeSchema = z.enum(["org", "member"]);

export type ModelProviderCredentialScope = z.infer<
  typeof modelProviderCredentialScopeSchema
>;

export interface DefaultOrgModelPolicySeed {
  model: SupportedRunModel;
  isDefault: boolean;
  defaultProviderType: "built-in";
  credentialScope: "org";
  modelProviderId: null;
}

const SUPPORTED_RUN_MODEL_LABELS: Record<SupportedRunModel, string> = {
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "gpt-6-astra": "GPT 6 Astra",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "gpt-5.5": "GPT 5.5",
};

const SUPPORTED_RUN_MODEL_SET: ReadonlySet<string> = new Set(
  SUPPORTED_RUN_MODELS,
);

type ActiveRunModel = Exclude<SupportedRunModel, "claude-fable-5">;

// Historical IDs remain in the wire schemas and billing catalog. Availability
// is a separate product decision, including for provider-prefixed aliases.
export const RETIRED_RUN_MODEL_MESSAGE =
  "Claude Fable 5 has been retired. Select Claude Fable 5.1.";

export function getRunModelAccess(
  model: string | null | undefined,
  restrictedBuiltInModels = false,
): "allowed" | "pro_required" | "retired" {
  const canonical = normalizeBuiltInModelId(model?.trim().toLowerCase() ?? "");
  if (canonical === "claude-fable-5") {
    return "retired";
  }
  return restrictedBuiltInModels && isLimitedFree1RestrictedRunModel(model)
    ? "pro_required"
    : "allowed";
}

export function isActiveRunModel(
  model: string | null | undefined,
): model is ActiveRunModel {
  return isSupportedRunModel(model) && getRunModelAccess(model) === "allowed";
}

export function isSupportedRunModel(
  model: string | null | undefined,
): model is SupportedRunModel {
  return typeof model === "string" && SUPPORTED_RUN_MODEL_SET.has(model);
}

/** Models supported by the Codex Fast service tier. */
export const CODEX_FAST_MODE_MODELS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const satisfies readonly SupportedRunModel[];

const CODEX_FAST_MODE_MODEL_SET: ReadonlySet<string> = new Set(
  CODEX_FAST_MODE_MODELS,
);

export function isCodexFastModeModel(
  model: string | null | undefined,
): boolean {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  return (
    typeof bareModel === "string" && CODEX_FAST_MODE_MODEL_SET.has(bareModel)
  );
}

export function getBuiltInModelPriceTier(
  model: string,
): ModelPriceTier | undefined {
  return isSupportedRunModel(model)
    ? BUILT_IN_MODEL_PRICE_TIER[model]
    : undefined;
}

export function getCanonicalModelDisplayName(model: string): string {
  return isSupportedRunModel(model) ? SUPPORTED_RUN_MODEL_LABELS[model] : model;
}

export function getDefaultOrgModelPolicySeed(
  defaultModel: SupportedRunModel = DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
): DefaultOrgModelPolicySeed[] {
  return DEFAULT_ORG_MODEL_POLICY_MODELS.map((model) => {
    return {
      model,
      isDefault: model === defaultModel,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    };
  });
}

/**
 * Mapping from built-in model names to their concrete provider type and vendor.
 * Used at build-context time to resolve the meta-provider to a real provider.
 */
export const BUILT_IN_MODEL_ROUTE_PROVIDERS = {
  "anthropic-api-key": { vendor: "anthropic" },
  "openrouter-api-key": { vendor: "openrouter" },
  deepseek: { vendor: "deepseek" },
  "openrouter-codex": { vendor: "openrouter" },
  "openai-api-key": { vendor: "openai" },
} as const satisfies Partial<Record<ModelProviderType, { vendor: string }>>;

export type BuiltInModelRouteProviderType =
  keyof typeof BUILT_IN_MODEL_ROUTE_PROVIDERS;

export interface BuiltInModelRouteCandidate {
  readonly concreteType: BuiltInModelRouteProviderType;
  // Overrides the display-name when substituting `$model` in the concrete
  // provider's env bindings. Needed when the upstream API expects a
  // different identifier than what we show to users.
  readonly apiModel?: string;
}

interface ModelConfig {
  readonly candidates: readonly [
    BuiltInModelRouteCandidate,
    ...BuiltInModelRouteCandidate[],
  ];
}

// Execution routes contain only active models. Historical recognition and
// retirement validation must not depend on a model retaining an executable route.
export const BUILT_IN_MODEL_TO_PROVIDER = {
  "claude-fable-5-1": {
    candidates: [
      { concreteType: "anthropic-api-key" },
      {
        concreteType: "openrouter-api-key",
        apiModel: "anthropic/claude-fable-5.1",
      },
    ],
  },
  "claude-opus-5": {
    candidates: [
      { concreteType: "anthropic-api-key" },
      {
        concreteType: "openrouter-api-key",
        apiModel: "anthropic/claude-opus-5",
      },
    ],
  },
  "claude-opus-4-8": {
    candidates: [
      { concreteType: "anthropic-api-key" },
      {
        concreteType: "openrouter-api-key",
        apiModel: "anthropic/claude-opus-4.8",
      },
    ],
  },
  "claude-sonnet-5": {
    candidates: [
      { concreteType: "anthropic-api-key" },
      {
        concreteType: "openrouter-api-key",
        apiModel: "anthropic/claude-sonnet-5",
      },
    ],
  },
  "claude-sonnet-4-6": {
    candidates: [
      { concreteType: "anthropic-api-key" },
      {
        concreteType: "openrouter-api-key",
        apiModel: "anthropic/claude-sonnet-4.6",
      },
    ],
  },
  "deepseek-v4.1-flash": {
    candidates: [
      {
        concreteType: "openrouter-codex",
        apiModel: "deepseek/deepseek-v4.1-flash",
      },
    ],
  },
  "deepseek-v4-flash": {
    candidates: [
      { concreteType: "deepseek" },
      {
        concreteType: "openrouter-codex",
        apiModel: "deepseek/deepseek-v4-flash",
      },
    ],
  },
  "deepseek-v4-pro": {
    candidates: [
      { concreteType: "deepseek" },
      {
        concreteType: "openrouter-codex",
        apiModel: "deepseek/deepseek-v4-pro",
      },
    ],
  },
  // Permanent Built-in availability routing: prefer OpenAI, then use
  // OpenRouter when the primary candidate has no key or is in cooldown.
  // This is operational routing, not a cross-version compatibility bridge.
  "gpt-6-astra": {
    candidates: [
      { concreteType: "openai-api-key" },
      {
        concreteType: "openrouter-codex",
        apiModel: "openai/gpt-6-astra",
      },
    ],
  },
  "gpt-5.6-sol": {
    candidates: [
      { concreteType: "openai-api-key" },
      {
        concreteType: "openrouter-codex",
        apiModel: "openai/gpt-5.6-sol",
      },
    ],
  },
  "gpt-5.6-terra": {
    candidates: [
      { concreteType: "openai-api-key" },
      {
        concreteType: "openrouter-codex",
        apiModel: "openai/gpt-5.6-terra",
      },
    ],
  },
  "gpt-5.6-luna": {
    candidates: [
      { concreteType: "openai-api-key" },
      {
        concreteType: "openrouter-codex",
        apiModel: "openai/gpt-5.6-luna",
      },
    ],
  },
  "gpt-5.5": {
    candidates: [
      { concreteType: "openai-api-key" },
      {
        concreteType: "openrouter-codex",
        apiModel: "openai/gpt-5.5",
      },
    ],
  },
} as const satisfies Record<ActiveRunModel, ModelConfig>;

export interface BuiltInModelRouteTarget {
  readonly selectedModel: SupportedRunModel;
  readonly providerType: BuiltInModelRouteProviderType;
  readonly upstreamModel: string;
  readonly vendor: string;
}

function builtInPrimaryCandidate(model: string): BuiltInModelRouteCandidate {
  if (!isActiveRunModel(model)) {
    throw new Error(
      `Unknown built-in model "${model}". Valid models: ${Object.keys(BUILT_IN_MODEL_TO_PROVIDER).join(", ")}`,
    );
  }
  return BUILT_IN_MODEL_TO_PROVIDER[model].candidates[0];
}

export function getBuiltInModelRouteCandidates(
  model: string,
): readonly BuiltInModelRouteTarget[] {
  if (!isActiveRunModel(model)) {
    throw new Error(
      `Unknown built-in model "${model}". Valid models: ${Object.keys(BUILT_IN_MODEL_TO_PROVIDER).join(", ")}`,
    );
  }
  return BUILT_IN_MODEL_TO_PROVIDER[model].candidates.map((candidate) => {
    return {
      selectedModel: model,
      providerType: candidate.concreteType,
      upstreamModel: "apiModel" in candidate ? candidate.apiModel : model,
      vendor: BUILT_IN_MODEL_ROUTE_PROVIDERS[candidate.concreteType].vendor,
    };
  });
}

export function getBuiltInModelRouteVendors(): readonly string[] {
  return [
    ...new Set(
      Object.values(BUILT_IN_MODEL_TO_PROVIDER).flatMap((config) => {
        return config.candidates.map((candidate) => {
          return BUILT_IN_MODEL_ROUTE_PROVIDERS[candidate.concreteType].vendor;
        });
      }),
    ),
  ];
}

export const BUILT_IN_MODEL_ALIAS_TO_MODEL = {
  "anthropic/claude-fable-5.1": "claude-fable-5-1",
  "anthropic/claude-fable-5": "claude-fable-5",
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-4.8": "claude-opus-4-8",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
} as const satisfies Record<string, SupportedRunModel>;

const BUILT_IN_MODEL_ALIAS_LOOKUP: Readonly<Record<string, string>> =
  BUILT_IN_MODEL_ALIAS_TO_MODEL;

const LIMITED_FREE1_ALLOWED_RUN_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.6-luna",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
]);

export function normalizeBuiltInModelId(model: string): string {
  return BUILT_IN_MODEL_ALIAS_LOOKUP[model] ?? model;
}

export function isLimitedFree1RestrictedRunModel(
  model: string | null | undefined,
): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const canonicalModel = normalizeBuiltInModelId(normalized);
  const unprefixedModel = canonicalModel.replace(
    /^(anthropic|deepseek|openai)\//,
    "",
  );
  return !LIMITED_FREE1_ALLOWED_RUN_MODELS.has(unprefixedModel);
}

export const ACTIVE_RUN_MODELS: readonly SupportedRunModel[] =
  SUPPORTED_RUN_MODELS.filter(isActiveRunModel);

export type ModelImageInputSupport = "supported" | "unsupported" | "unknown";

const IMAGE_INPUT_SUPPORTED_MODELS = new Set([
  "gpt-6-astra",
  "openai/gpt-6-astra",
  "deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",
]);

const IMAGE_INPUT_UNSUPPORTED_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "minimax/minimax-m2.5",
]);

export function getModelImageInputSupport(
  model: string | null | undefined,
): ModelImageInputSupport {
  if (!model) {
    return "unknown";
  }
  const normalized = normalizeBuiltInModelId(model);
  if (
    IMAGE_INPUT_SUPPORTED_MODELS.has(normalized) ||
    IMAGE_INPUT_SUPPORTED_MODELS.has(model)
  ) {
    return "supported";
  }
  if (
    IMAGE_INPUT_UNSUPPORTED_MODELS.has(normalized) ||
    IMAGE_INPUT_UNSUPPORTED_MODELS.has(model)
  ) {
    return "unsupported";
  }
  return "unknown";
}

export function modelSupportsImageInput(
  model: string | null | undefined,
): boolean {
  return getModelImageInputSupport(model) === "supported";
}

/**
 * Return the built-in models visible to callers.
 */
export function getBuiltInVisibleModels(): string[] {
  return [...ACTIVE_RUN_MODELS];
}

/**
 * Model Provider type configuration
 * Maps type to framework, secret name, and display info
 *
 * For providers with `envBindings`, the secret is mapped to framework variables:
 * - `$secret` → the stored secret value (legacy single secret)
 * - `$secrets.X` → lookup secret X from the secrets map (multi-secret)
 * - `$model` → the selected model (or default)
 * - Other values are passed through as literals
 *
 * Provider types:
 * - Legacy providers: use `secretName` for single secret
 * - Multi-auth providers: use `authMethods` for multiple auth options with different secrets
 */
const BUILT_IN_MODEL_PROVIDER_CONFIG = {
  framework: "claude-code" as const,
  label: "Built-in model",
  models: [...ACTIVE_RUN_MODELS],
  defaultModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
};

export const MODEL_PROVIDER_TYPES = {
  "claude-code-oauth-token": {
    framework: "claude-code" as const,
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code (OAuth Token)",
    secretLabel: "OAuth token",
    helpText:
      "To get your OAuth token, run: claude setup-token\n(Requires Claude Pro or Max subscription)",
    envBindings: {
      CLAUDE_CODE_OAUTH_TOKEN: "$secret",
      ANTHROPIC_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ] as string[],
    defaultModel: "claude-sonnet-5",
  },
  "anthropic-api-key": {
    framework: "claude-code" as const,
    secretName: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    secretLabel: "API key",
    helpText:
      "Get your API key at: https://console.anthropic.com/settings/keys",
    envBindings: {
      ANTHROPIC_API_KEY: "$secret",
      ANTHROPIC_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ] as string[],
    defaultModel: "claude-sonnet-5",
  },
  "openrouter-api-key": {
    framework: "claude-code" as const,
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    secretLabel: "API key",
    helpText: "Get your API key at: https://openrouter.ai/settings/keys",
    envBindings: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-sonnet-4.5",
    ] as string[],
    defaultModel: "",
  },
  deepseek: {
    framework: "codex" as const,
    secretName: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    secretLabel: "API key",
    helpText: "Get your API key at: https://platform.deepseek.com/api_keys",
    envBindings: {
      OPENAI_API_KEY: "$secret",
      OPENAI_BASE_URL: "https://api.deepseek.com/",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"] as string[],
    defaultModel: "deepseek-v4-flash",
  },
  "vercel-ai-gateway": {
    framework: "claude-code" as const,
    secretName: "VERCEL_AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
    secretLabel: "API key",
    helpText: "Get your API key from the Vercel AI Gateway dashboard",
    envBindings: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-4.5",
      "minimax/minimax-m2.5",
    ] as string[],
    defaultModel: "anthropic/claude-sonnet-5",
  },
  // Codex-framework twin of openrouter-api-key. Same upstream gateway (OpenRouter)
  // and same API key (shared secretName), but routes through OpenRouter's
  // OpenAI-compatible endpoint surface for models that use the Codex framework.
  // Pairing rule: the claude-code entry serves Anthropic Messages API
  // (/v1/messages); this codex entry serves OpenAI Chat Completions / Responses
  // (/v1/chat/completions, /v1/responses) under the same /api/v1 prefix.
  "openrouter-codex": {
    framework: "codex" as const,
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter (Codex)",
    secretLabel: "API key",
    helpText: "Get your API key at: https://openrouter.ai/settings/keys",
    envBindings: {
      OPENAI_API_KEY: "$secret",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ] as string[],
    defaultModel: "openai/gpt-5.6-luna",
  },
  // Codex-framework twin of vercel-ai-gateway. Vercel exposes both
  // Anthropic Messages and OpenAI Chat Completions / Responses on the same
  // base URL, distinguished by path. The claude-code entry uses /v1/messages;
  // this codex entry uses /v1/chat/completions or /v1/responses (codex CLI
  // picks the path it needs).
  "vercel-ai-gateway-codex": {
    framework: "codex" as const,
    secretName: "VERCEL_AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway (Codex)",
    secretLabel: "API key",
    helpText: "Get your API key from the Vercel AI Gateway dashboard",
    envBindings: {
      OPENAI_API_KEY: "$secret",
      OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
    ] as string[],
    defaultModel: "openai/gpt-5.6-luna",
  },
  "openai-api-key": {
    framework: "codex" as const,
    secretName: "OPENAI_API_KEY",
    label: "OpenAI",
    secretLabel: "API key",
    helpText: "Get your API key at: https://platform.openai.com/api-keys",
    envBindings: {
      OPENAI_API_KEY: "$secret",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ] as string[],
    defaultModel: "gpt-5.6-sol",
  },
  "codex-oauth-token": {
    framework: "codex" as const,
    label: "ChatGPT (Codex)",
    helpText:
      "Run `codex login` on your machine, then paste the resulting " +
      "~/.codex/auth.json contents to authorize ChatGPT (Plus / Pro / " +
      "Business / Edu / Enterprise) for Codex.",
    authMethods: {
      // Paste-based auth: client posts CODEX_AUTH_JSON, server parses it via
      // codex-auth-json-parser.ts and persists the four derived CHATGPT_*
      // fields. The raw blob is NEVER stored. The wire-shape secret
      // (CODEX_AUTH_JSON) is declared optional+serverOnly so the contract
      // accepts it on POST without persisting; the four CHATGPT_* fields are
      // the canonical stored secrets and the firewall layer reads from those.
      auth_json: {
        label: "Codex auth.json",
        helpText:
          "Run `codex login` locally, then paste the contents of ~/.codex/auth.json below.",
        secrets: {
          CODEX_AUTH_JSON: {
            label: "auth.json contents",
            required: false,
            serverOnly: true,
            placeholder: '{"OPENAI_API_KEY":null,"tokens":{...}}',
            helpText: "Paste the entire contents of ~/.codex/auth.json",
          },
          // CHATGPT_ACCESS_TOKEN and CHATGPT_ACCOUNT_ID reach the sandbox env
          // as placeholder values (substituted by the firewall token-replacement
          // layer at egress) — keeping them non-serverOnly preserves the
          // placeholder injection path. CHATGPT_REFRESH_TOKEN and
          // CHATGPT_ID_TOKEN stay serverOnly per the #7365 invariant.
          //
          // All four are `derived: true` — the server-side parser populates
          // them from the user-pasted CODEX_AUTH_JSON. The UI MUST NOT render
          // them as input fields (per #12024).
          CHATGPT_ACCESS_TOKEN: {
            label: "CHATGPT_ACCESS_TOKEN",
            required: true,
            derived: true,
          },
          CHATGPT_REFRESH_TOKEN: {
            label: "CHATGPT_REFRESH_TOKEN",
            required: true,
            serverOnly: true,
            derived: true,
          },
          CHATGPT_ACCOUNT_ID: {
            label: "CHATGPT_ACCOUNT_ID",
            required: true,
            derived: true,
          },
          CHATGPT_ID_TOKEN: {
            label: "CHATGPT_ID_TOKEN",
            required: true,
            serverOnly: true,
            derived: true,
          },
        },
      },
    } satisfies Record<string, AuthMethodConfig>,
    defaultAuthMethod: "auth_json",
    envBindings: {
      CHATGPT_ACCESS_TOKEN: "$secrets.CHATGPT_ACCESS_TOKEN",
      CHATGPT_ACCOUNT_ID: "$secrets.CHATGPT_ACCOUNT_ID",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ] as string[],
    defaultModel: "gpt-5.6-sol",
  },
  "azure-foundry": {
    framework: "claude-code" as const,
    label: "Azure Foundry",
    helpText:
      "Run Claude on Microsoft Azure Foundry.\nSetup guide: https://code.claude.com/docs/en/microsoft-foundry",
    authMethods: {
      "api-key": {
        label: "API Key",
        helpText: "Use an Azure Foundry API key for authentication",
        secrets: {
          ANTHROPIC_FOUNDRY_API_KEY: {
            label: "ANTHROPIC_FOUNDRY_API_KEY",
            required: true,
            helpText: "API key from Azure Foundry portal (Endpoints and keys)",
          },
          ANTHROPIC_FOUNDRY_RESOURCE: {
            label: "ANTHROPIC_FOUNDRY_RESOURCE",
            required: true,
            placeholder: "my-resource",
            helpText: "Azure resource name (from portal URL)",
          },
        },
      },
    } satisfies Record<string, AuthMethodConfig>,
    defaultAuthMethod: "api-key",
    envBindings: {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "$secrets.ANTHROPIC_FOUNDRY_API_KEY",
      ANTHROPIC_FOUNDRY_RESOURCE: "$secrets.ANTHROPIC_FOUNDRY_RESOURCE",
      ANTHROPIC_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [] as string[],
    defaultModel: "",
    allowCustomModel: true,
    customModelPlaceholder: "claude-sonnet-4-5",
  },
  "aws-bedrock": {
    framework: "claude-code" as const,
    label: "AWS Bedrock",
    helpText:
      "Run Claude on AWS Bedrock.\nSetup guide: https://code.claude.com/docs/en/amazon-bedrock",
    authMethods: {
      "api-key": {
        label: "Bedrock API Key",
        helpText: "Use a Bedrock API key for authentication",
        secrets: {
          AWS_BEARER_TOKEN_BEDROCK: {
            label: "AWS_BEARER_TOKEN_BEDROCK",
            required: true,
            helpText: "Bedrock API key from AWS console",
          },
          AWS_REGION: {
            label: "AWS_REGION",
            required: true,
            placeholder: "us-east-1",
            helpText: "e.g., us-east-1, us-west-2",
          },
        },
      },
      "access-keys": {
        label: "IAM Access Keys",
        helpText: "Use IAM access key secrets",
        secrets: {
          AWS_ACCESS_KEY_ID: {
            label: "AWS_ACCESS_KEY_ID",
            required: true,
            helpText: "IAM access key ID",
          },
          AWS_SECRET_ACCESS_KEY: {
            label: "AWS_SECRET_ACCESS_KEY",
            required: true,
            helpText: "IAM secret access key",
          },
          AWS_SESSION_TOKEN: {
            label: "AWS_SESSION_TOKEN",
            required: false,
            helpText: "Optional, for temporary secrets",
          },
          AWS_REGION: {
            label: "AWS_REGION",
            required: true,
            placeholder: "us-east-1",
            helpText: "e.g., us-east-1, us-west-2",
          },
        },
      },
    } satisfies Record<string, AuthMethodConfig>,
    defaultAuthMethod: "api-key",
    envBindings: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "$secrets.AWS_REGION",
      AWS_BEARER_TOKEN_BEDROCK: "$secrets.AWS_BEARER_TOKEN_BEDROCK",
      AWS_ACCESS_KEY_ID: "$secrets.AWS_ACCESS_KEY_ID",
      AWS_SECRET_ACCESS_KEY: "$secrets.AWS_SECRET_ACCESS_KEY",
      AWS_SESSION_TOKEN: "$secrets.AWS_SESSION_TOKEN",
      ANTHROPIC_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
    models: [] as string[],
    defaultModel: "",
    allowCustomModel: true,
    customModelPlaceholder: "anthropic.claude-sonnet-4-20250514-v1:0",
  },
  // Org-configured custom gateways. These mirror the ModelProviderSurfaceProtocol
  // enum so a stored provider type never names an unrelated vendor. The runtime
  // (env vars, firewall, codex provider config) is compiled from the surface row
  // itself, so these entries carry no secret, binding, or model catalog.
  "custom-anthropic-messages": {
    framework: "claude-code" as const,
    label: "Custom Gateway (Anthropic Messages)",
  },
  "custom-openai-responses": {
    framework: "codex" as const,
    label: "Custom Gateway (OpenAI Responses)",
  },
  "built-in": BUILT_IN_MODEL_PROVIDER_CONFIG,
} as const satisfies Record<ModelProviderType, unknown>;

export function getModelProviderPresentationLabel(
  type: ModelProviderType,
): string {
  return MODEL_PROVIDER_TYPES[type].label;
}

const MODEL_FIRST_PROVIDER_COMPATIBILITY = {
  "claude-fable-5-1": [
    "built-in",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "azure-foundry",
    "aws-bedrock",
  ],
  "claude-opus-5": [
    "built-in",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "azure-foundry",
    "aws-bedrock",
  ],
  "claude-opus-4-8": [
    "built-in",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "azure-foundry",
    "aws-bedrock",
  ],
  "claude-sonnet-5": [
    "built-in",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "azure-foundry",
    "aws-bedrock",
  ],
  "claude-sonnet-4-6": [
    "built-in",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "azure-foundry",
    "aws-bedrock",
  ],
  "gpt-6-astra": [
    "built-in",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
  ],
  "gpt-5.6-sol": [
    "built-in",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "gpt-5.6-terra": [
    "built-in",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "gpt-5.6-luna": [
    "built-in",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "gpt-5.5": [
    "built-in",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "deepseek-v4.1-flash": ["built-in", "openrouter-codex"],
  "deepseek-v4-flash": ["built-in", "deepseek", "openrouter-codex"],
  "deepseek-v4-pro": ["built-in", "deepseek", "openrouter-codex"],
} as const satisfies Record<ActiveRunModel, readonly ModelProviderType[]>;

const PROVIDER_RUNTIME_MODEL_ALIASES: Partial<
  Record<ModelProviderType, Partial<Record<ActiveRunModel, string>>>
> = {
  "openrouter-api-key": {
    "claude-fable-5-1": "anthropic/claude-fable-5.1",
    "claude-opus-5": "anthropic/claude-opus-5",
    "claude-opus-4-8": "anthropic/claude-opus-4.8",
    "claude-sonnet-5": "anthropic/claude-sonnet-5",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  },
  "vercel-ai-gateway": {
    "claude-fable-5-1": "anthropic/claude-fable-5.1",
    "claude-opus-5": "anthropic/claude-opus-5",
    "claude-opus-4-8": "anthropic/claude-opus-4.8",
    "claude-sonnet-5": "anthropic/claude-sonnet-5",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  },
  "openrouter-codex": {
    "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    "gpt-6-astra": "openai/gpt-6-astra",
    "gpt-5.6-sol": "openai/gpt-5.6-sol",
    "gpt-5.6-terra": "openai/gpt-5.6-terra",
    "gpt-5.6-luna": "openai/gpt-5.6-luna",
    "gpt-5.5": "openai/gpt-5.5",
  },
  "vercel-ai-gateway-codex": {
    "gpt-5.6-sol": "openai/gpt-5.6-sol",
    "gpt-5.6-terra": "openai/gpt-5.6-terra",
    "gpt-5.6-luna": "openai/gpt-5.6-luna",
    "gpt-5.5": "openai/gpt-5.5",
  },
};

const CANONICAL_RUN_MODEL_ALIASES: Readonly<Record<string, SupportedRunModel>> =
  {
    "deepseek/deepseek-v4.1-flash": "deepseek-v4.1-flash",
    "deepseek/deepseek-v4-flash": "deepseek-v4-flash",
    "deepseek/deepseek-v4-pro": "deepseek-v4-pro",
    "anthropic/claude-fable-5.1": "claude-fable-5-1",
    "anthropic/claude-fable-5": "claude-fable-5",
    "anthropic/claude-opus-5": "claude-opus-5",
    "anthropic/claude-opus-4.8": "claude-opus-4-8",
    "anthropic/claude-sonnet-5": "claude-sonnet-5",
    "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
  };

export function normalizeRunModelId(model: string): string {
  return CANONICAL_RUN_MODEL_ALIASES[model] ?? model;
}

export function getProvidersForModel(model: string): ModelProviderType[] {
  const canonical = normalizeRunModelId(model);
  if (!isActiveRunModel(canonical)) {
    return [];
  }
  return [...MODEL_FIRST_PROVIDER_COMPATIBILITY[canonical]];
}

export function isModelSupportedByProvider(
  model: string,
  type: ModelProviderType,
): boolean {
  return getProvidersForModel(model).includes(
    isBuiltInModelProviderType(type) ? "built-in" : type,
  );
}

export function getProviderRuntimeModel(
  type: ModelProviderType,
  model: string,
): string {
  const canonical = normalizeRunModelId(model);
  if (!isActiveRunModel(canonical)) {
    return model;
  }
  if (isBuiltInModelProviderType(type)) {
    return builtInPrimaryCandidate(canonical).apiModel ?? canonical;
  }
  return PROVIDER_RUNTIME_MODEL_ALIASES[type]?.[canonical] ?? canonical;
}

/**
 * Provider types hidden from user-facing selection UI.
 * `aws-bedrock` and `azure-foundry` lack static firewall support (dynamic URLs
 * or SigV4), so token replacement cannot be used.  New selection is blocked
 * until a proper solution is implemented; existing configurations continue to
 * work.  The custom gateway types are never picked directly either: they are
 * derived from a model provider surface's protocol.
 */
const HIDDEN_PROVIDER_LIST = [
  "aws-bedrock",
  "azure-foundry",
  "custom-anthropic-messages",
  "custom-openai-responses",
] as const;

const HIDDEN_PROVIDER_TYPES: ReadonlySet<ModelProviderType> = new Set(
  HIDDEN_PROVIDER_LIST,
);

/**
 * Get provider types available for user selection.
 * Excludes providers that are hidden from the UI (e.g., those without token replacement support).
 */
export function getSelectableProviderTypes(): ModelProviderType[] {
  return (Object.keys(MODEL_PROVIDER_TYPES) as ModelProviderType[]).filter(
    (type) => {
      return !HIDDEN_PROVIDER_TYPES.has(type);
    },
  );
}

export const modelProviderTypeSchema = z.enum(MODEL_PROVIDER_TYPE_IDS);
export const modelProviderWriteTypeSchema = z.enum(MODEL_PROVIDER_TYPE_IDS);

export const modelProviderFrameworkSchema = z.enum(["claude-code", "codex"]);

/**
 * Get the concrete provider type for a built-in model.
 * Throws if the model is not in the built-in model mapping.
 */
export function getBuiltInConcreteProviderType(
  model: string,
): BuiltInModelRouteProviderType {
  return builtInPrimaryCandidate(model).concreteType;
}

/**
 * Get the vendor name for a built-in model.
 * Used for key pool lookup.
 */
export function getBuiltInVendor(model: string): string {
  const providerType = builtInPrimaryCandidate(model).concreteType;
  return BUILT_IN_MODEL_ROUTE_PROVIDERS[providerType].vendor;
}

/**
 * Get the upstream API model identifier for a built-in model.
 * Falls back to the display name when no override is configured.
 */
export function getBuiltInApiModel(model: string): string {
  return builtInPrimaryCandidate(model).apiModel ?? model;
}

/**
 * Get framework for a model provider type
 */
export function getFrameworkForType(
  type: ModelProviderType,
): ModelProviderFramework {
  return MODEL_PROVIDER_TYPES[type]?.framework ?? "claude-code";
}

/**
 * Get secret name for a model provider type (legacy single-secret providers)
 * Returns undefined for multi-auth providers
 */
export function getSecretNameForType(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return undefined;
  return "secretName" in config ? config.secretName : undefined;
}

/**
 * Check if a model provider type has multiple auth methods
 */
export function hasAuthMethods(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return false;
  return "authMethods" in config;
}

/**
 * Get auth methods for a model provider type
 * Returns undefined for legacy single-secret providers
 */
export function getAuthMethodsForType(
  type: ModelProviderType,
): Record<string, AuthMethodConfig> | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return undefined;
  return "authMethods" in config ? config.authMethods : undefined;
}

/**
 * Get default auth method for a model provider type
 * Returns undefined for legacy single-secret providers
 */
export function getDefaultAuthMethod(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "defaultAuthMethod" in config ? config.defaultAuthMethod : undefined;
}

/**
 * Get secrets config for a specific auth method
 * Returns undefined if provider doesn't have auth methods or auth method doesn't exist
 */
export function getSecretsForAuthMethod(
  type: ModelProviderType,
  authMethod: string,
): Record<string, SecretFieldConfig> | undefined {
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethod in authMethods)) {
    return undefined;
  }
  const method = authMethods[authMethod];
  return method?.secrets;
}

/**
 * Get secret names for a specific auth method
 * Returns array of secret names required for the auth method
 */
export function getSecretNamesForAuthMethod(
  type: ModelProviderType,
  authMethod: string,
): string[] | undefined {
  const secrets = getSecretsForAuthMethod(type, authMethod);
  if (!secrets) {
    return undefined;
  }
  return Object.keys(secrets);
}

/**
 * Get runtime environment bindings for a model provider type.
 * Returns undefined for providers without env bindings (use secret directly).
 */
export function getModelProviderEnvBindings(
  type: ModelProviderType,
): ModelProviderEnvBindings | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "envBindings" in config ? config.envBindings : undefined;
}

/**
 * Get built-in Codex provider metadata for a static model provider.
 */
export function getModelProviderCodexRuntimeConfig(
  type: ModelProviderType,
): ModelProviderCodexRuntimeConfig | undefined {
  return MODEL_PROVIDER_CODEX_RUNTIME_CONFIGS[type];
}

const CODEX_MODEL_CATALOG_OVERRIDES: Readonly<
  Partial<Record<ActiveRunModel, Record<string, unknown>>>
> = {
  "deepseek-v4.1-flash": DEEPSEEK_V4_1_FLASH_MODEL_CATALOG,
};

/**
 * Project a Codex catalog record onto the model ID and provider used at
 * runtime. Returns undefined when no authoritative metadata is available for
 * the logical model.
 */
export function getModelProviderCodexCatalogForModel(
  logicalModel: string,
  runtimeModel: string,
  runtimeProviderType: ModelProviderType,
): Record<string, unknown> | undefined {
  const disableApplyPatch =
    runtimeProviderType === "openrouter-codex" &&
    (logicalModel === "deepseek-v4.1-flash" ||
      logicalModel === "deepseek-v4-flash" ||
      logicalModel === "deepseek-v4-pro");
  const canonicalModel = normalizeRunModelId(logicalModel);
  const overrideCatalog = isActiveRunModel(canonicalModel)
    ? CODEX_MODEL_CATALOG_OVERRIDES[canonicalModel]
    : undefined;
  const sourceCatalogs = overrideCatalog
    ? [overrideCatalog]
    : getProvidersForModel(logicalModel).flatMap((type) => {
        const sourceCatalog =
          MODEL_PROVIDER_CODEX_RUNTIME_CONFIGS[type]?.modelCatalog;
        return sourceCatalog ? [sourceCatalog] : [];
      });
  for (const sourceCatalog of sourceCatalogs) {
    const sourceModels = sourceCatalog.models;
    const sourceModel = Array.isArray(sourceModels)
      ? sourceModels.find(
          (model: unknown): model is Record<string, unknown> => {
            return (
              typeof model === "object" &&
              model !== null &&
              !Array.isArray(model) &&
              "slug" in model &&
              model.slug === canonicalModel
            );
          },
        )
      : undefined;
    if (sourceCatalog && sourceModel) {
      return {
        ...sourceCatalog,
        models: [
          {
            ...sourceModel,
            ...(disableApplyPatch ? { apply_patch_tool_type: null } : {}),
            slug: runtimeModel,
          },
        ],
      };
    }
  }
  return undefined;
}

const CUSTOM_GATEWAY_PROVIDER_TYPES: ReadonlySet<ModelProviderType> = new Set([
  "custom-anthropic-messages",
  "custom-openai-responses",
]);

/**
 * Check whether a provider type routes through an org-configured gateway
 * surface. Its upstream is stored per surface in `model_provider_surfaces`.
 */
export function isCustomGatewayProviderType(type: ModelProviderType): boolean {
  return CUSTOM_GATEWAY_PROVIDER_TYPES.has(type);
}

/**
 * Get available models for a model provider type
 * Returns undefined for providers without model selection
 */
export function getModels(type: ModelProviderType): string[] | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "models" in config ? config.models : undefined;
}

/**
 * Get default model for a model provider type
 * Returns undefined for providers without model selection
 */
export function getDefaultModel(type: ModelProviderType): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "defaultModel" in config ? config.defaultModel : undefined;
}

/**
 * Check if a model provider type supports model selection
 */
export function hasModelSelection(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  // Has predefined models OR allows custom model input
  return (
    ("models" in config && config.models.length > 0) ||
    ("allowCustomModel" in config && config.allowCustomModel === true)
  );
}

/**
 * Check if a model provider allows custom model input
 */
export function allowsCustomModel(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  return "allowCustomModel" in config && config.allowCustomModel === true;
}

/**
 * Get custom model placeholder for a model provider type
 */
export function getCustomModelPlaceholder(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "customModelPlaceholder" in config
    ? config.customModelPlaceholder
    : undefined;
}

export const modelProviderSubscriptionUsageWindowSchema = z.object({
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  resetAt: z.string().nullable(),
  windowSeconds: z.number().nullable(),
});

export const modelProviderSubscriptionUsageSchema = z.object({
  fiveHour: modelProviderSubscriptionUsageWindowSchema.nullable(),
  weekly: modelProviderSubscriptionUsageWindowSchema.nullable(),
});

/**
 * Model provider response
 */
export const modelProviderResponseSchema = z.object({
  id: z.uuid(),
  // Present for concrete personal subscription accounts. `id` is the exact
  // credential identity pinned to a run, while `modelProviderId` is the
  // logical model route retained for compatibility with existing settings.
  modelProviderId: z.uuid().optional(),
  isActive: z.boolean().optional(),
  type: modelProviderTypeSchema,
  framework: modelProviderFrameworkSchema,
  secretName: z.string().nullable(), // Legacy single-secret (deprecated for multi-auth)
  authMethod: z.string().nullable(), // For multi-auth providers
  secretNames: z.array(z.string()).nullable(), // For multi-auth providers
  isDefault: z.boolean(),
  selectedModel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // OAuth account metadata populated by provider-specific connect flows. Other
  // provider types omit these.
  accountEmail: z.string().nullable().optional(),
  workspaceName: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  // Subscription quota metadata. Providers omit these until an upstream source
  // exposes the reset cadence or next reset timestamp.
  subscriptionResetPeriod: z.string().nullable().optional(),
  subscriptionNextResetAt: z.string().nullable().optional(),
  subscriptionUsage: modelProviderSubscriptionUsageSchema.nullable().optional(),
  subscriptionResetCredits: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional(),
  // Soonest expiry among the reset credits the account can still redeem. Null
  // when nothing expires, and also when the upstream detail read degraded to a
  // bare count, so the UI must treat it as decoration on top of the count.
  subscriptionResetCreditsNextExpiresAt: z.string().nullable().optional(),
  // OAuth refresh state. `needsReconnect` flips to true when the firewall's
  // refresh attempt fails (#11921 writes this on the model_providers row).
  // `lastRefreshErrorCode` carries the typed code from `ChatgptRefreshError`
  // (e.g. `refresh_token_expired`) so the UI can render an actionable
  // re-connect message. Both fields are always emitted for OAuth-typed
  // providers; non-OAuth types default to false / null.
  needsReconnect: z.boolean(),
  lastRefreshErrorCode: z.string().nullable(),
});

export type ModelProviderResponse = z.infer<typeof modelProviderResponseSchema>;

/**
 * List model providers response
 */
export const modelProviderListResponseSchema = z.object({
  modelProviders: z.array(modelProviderResponseSchema),
});

export type ModelProviderListResponse = z.infer<
  typeof modelProviderListResponseSchema
>;

/**
 * Create/update model provider request
 *
 * Legacy providers use `secret` (single string)
 * Multi-auth providers use `authMethod` + `secrets` (map)
 */
export const upsertModelProviderRequestSchema = z.object({
  type: modelProviderWriteTypeSchema,
  secret: z.string().min(1).optional(), // Legacy single secret
  authMethod: z.string().optional(), // For multi-auth providers
  secrets: z.record(z.string(), z.string()).optional(), // For multi-auth providers
  selectedModel: z
    .string()
    .refine(
      (model) => {
        return getRunModelAccess(model) !== "retired";
      },
      { message: RETIRED_RUN_MODEL_MESSAGE },
    )
    .optional(),
});

export type UpsertModelProviderRequest = z.infer<
  typeof upsertModelProviderRequestSchema
>;

/**
 * Upsert response includes created flag
 */
export const upsertModelProviderResponseSchema = z.object({
  provider: modelProviderResponseSchema,
  created: z.boolean(),
});

export type UpsertModelProviderResponse = z.infer<
  typeof upsertModelProviderResponseSchema
>;

export const orgModelPolicyRouteStatusSchema = z.enum([
  "valid",
  "missing_provider",
  "invalid",
]);

export type OrgModelPolicyRouteStatus = z.infer<
  typeof orgModelPolicyRouteStatusSchema
>;

export const orgModelPolicySchema = z.object({
  id: z.uuid(),
  model: supportedRunModelSchema,
  modelLabel: z.string(),
  isDefault: z.boolean(),
  defaultProviderType: modelProviderTypeSchema,
  // Concrete built-in provider; other policies use defaultProviderType.
  runtimeProviderType: modelProviderTypeSchema.nullable().optional(),
  credentialScope: modelProviderCredentialScopeSchema,
  modelProviderId: z.uuid().nullable(),
  modelProviderSurfaceId: z.uuid().nullable().optional(),
  routeStatus: orgModelPolicyRouteStatusSchema,
  routeStatusReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OrgModelPolicy = z.infer<typeof orgModelPolicySchema>;

export const updateOrgModelPolicySchema = z.object({
  model: supportedRunModelSchema,
  isDefault: z.boolean(),
  defaultProviderType: modelProviderWriteTypeSchema,
  credentialScope: modelProviderCredentialScopeSchema,
  modelProviderId: z.uuid().nullable(),
  modelProviderSurfaceId: z.uuid().nullable().optional(),
});

export type UpdateOrgModelPolicy = z.infer<typeof updateOrgModelPolicySchema>;

export const orgModelPoliciesResponseSchema = z.object({
  policies: z.array(orgModelPolicySchema),
  workspaceDefaultModel: supportedRunModelSchema.nullable(),
  workspaceDefaultPolicyId: z.uuid().nullable(),
});

export type OrgModelPoliciesResponse = z.infer<
  typeof orgModelPoliciesResponseSchema
>;

export const updateOrgModelPoliciesRequestSchema = z.object({
  policies: z.array(updateOrgModelPolicySchema),
});

export type UpdateOrgModelPoliciesRequest = z.infer<
  typeof updateOrgModelPoliciesRequestSchema
>;
