import {
  isPiExecutionRoute,
  isPiNativeModel,
  isPiGptModel,
} from "@okouai/core/pi-execution";
import {
  piThinkingLevelForEffort,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  PI_MODEL_CONFIG_CURRENT_GENERATION,
  PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
  type PiModelConfig,
  type PiModelConfigLegacy,
} from "@okouai/api-contracts/contracts/runners";
import {
  getModelProviderPiEndpoint,
  getProviderRuntimeModel,
  getSecretNameForType,
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isCodexFastModeEnabled } from "@okouai/core/model-feature-switch";
import { isPiAgentModelSupported } from "@okouai/pi-agent-runtime";

import {
  resolvePiNativeModelConfig,
  type PiNativeModelProviderInput,
} from "./pi-native-model-config";

import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { GATEWAY_RUNTIME_SECRET_NAME } from "./model-provider-gateway-runtime";

/**
 * Resolve non-secret model metadata shared by the sandbox Pi runtime and the
 * required API first-turn slot. Credentials remain in the ordinary encrypted
 * run context and are never embedded in this launch metadata.
 */

function normalizedBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

interface PiRuntimeContract {
  readonly thinkingLevel?: PiModelConfigLegacy["thinkingLevel"];
  readonly serviceTier?: PiModelConfigLegacy["serviceTier"];
}

type PiCatalogProvider = "deepseek" | "openai";

const GPT_API_KEY_PI_ROUTES = {
  "openai-api-key": {
    productProviderType: "openai-api-key",
    provider: "openai",
    modelPrefix: "",
    endpoint: getModelProviderPiEndpoint("openai-api-key", "openai-responses"),
    credentialSecretName: "OPENAI_API_KEY",
  },
  "openrouter-codex": {
    productProviderType: "openrouter-codex",
    provider: "openrouter",
    modelPrefix: "openai/",
    endpoint: getModelProviderPiEndpoint(
      "openrouter-codex",
      "openai-responses",
    ),
    credentialSecretName: "OPENROUTER_API_KEY",
  },
  "vercel-ai-gateway-codex": {
    productProviderType: "vercel-ai-gateway-codex",
    provider: "openai",
    modelPrefix: "openai/",
    endpoint: getModelProviderPiEndpoint(
      "vercel-ai-gateway-codex",
      "openai-responses",
    ),
    credentialSecretName: "VERCEL_AI_GATEWAY_API_KEY",
  },
} as const;

type GptApiKeyPiProviderType = keyof typeof GPT_API_KEY_PI_ROUTES;

export function isGptApiKeyPiProviderType(
  value: string | null | undefined,
): value is GptApiKeyPiProviderType {
  return (
    value !== null &&
    value !== undefined &&
    Object.hasOwn(GPT_API_KEY_PI_ROUTES, value)
  );
}

function gptApiKeyPiRoute(
  value: string | null | undefined,
): (typeof GPT_API_KEY_PI_ROUTES)[GptApiKeyPiProviderType] | null {
  return isGptApiKeyPiProviderType(value) ? GPT_API_KEY_PI_ROUTES[value] : null;
}

function piCatalogProvider(
  selectedModel: string | null | undefined,
): PiCatalogProvider | null {
  if (isPiGptModel(selectedModel)) {
    return "openai";
  }
  switch (selectedModel) {
    case "deepseek-v4-flash":
    case "deepseek-v4-pro": {
      return "deepseek";
    }
    default: {
      return null;
    }
  }
}

function piRuntimeContract(args: {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly codexServiceTier: "fast" | undefined;
}): PiRuntimeContract {
  if (isPiGptModel(args.selectedModel)) {
    return {
      thinkingLevel: "max",
      ...((isBuiltInModelProviderType(args.providerType) ||
        args.providerType === "custom-openai-responses") &&
      args.codexServiceTier === "fast"
        ? { serviceTier: "priority" as const }
        : {}),
    };
  }
  return {};
}

function piProvider(
  concreteType: ModelProviderType,
): "deepseek" | "openai" | "openrouter" | null {
  switch (concreteType) {
    case "deepseek": {
      return "deepseek";
    }
    case "openai-api-key": {
      return "openai";
    }
    case "openrouter-codex": {
      return "openrouter";
    }
    default: {
      return null;
    }
  }
}

/**
 * Route canonical chat threads by model and provider policy. Trigger source is
 * intentionally absent so every thread-bound launch shares the same admission.
 */
export function shouldUsePiExecution(args: {
  readonly chatThreadId: string | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
  readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}): boolean {
  return (
    Boolean(args.chatThreadId) &&
    isPiExecutionRoute({
      selectedModel: args.selectedModel,
      modelProviderType: args.modelProviderType,
      runtimeProviderType:
        args.builtInModelRuntimeRoute?.providerType ?? args.modelProviderType,
      codexServiceTier: args.codexServiceTier,
      piEnabled: isFeatureEnabled(
        FeatureSwitchKey.PiLoop,
        args.featureSwitchContext,
      ),
      codexFastModeEnabled: isCodexFastModeEnabled(args.featureSwitchContext),
    })
  );
}

interface PiModelProviderConfigInput extends PiNativeModelProviderInput {
  readonly piModelConfig?: PiModelConfig;
  readonly type: string;
  readonly concreteType?: string;
  readonly environment: Record<string, string>;
  readonly selectedModel: string | null;
  readonly inlineFirewall?: boolean;
  readonly credentialHeader?: PiModelConfigLegacy["credentialHeader"];
}

function resolveCodexSubscriptionPiModelConfig(
  provider: PiModelProviderConfigInput,
  codexServiceTier: "fast" | undefined,
): PiModelConfig | null {
  if (
    provider.type !== "codex-oauth-token" ||
    !isPiGptModel(provider.selectedModel) ||
    provider.inlineFirewall === true ||
    provider.credentialHeader !== undefined ||
    (provider.concreteType !== undefined &&
      provider.concreteType !== "codex-oauth-token") ||
    provider.environment.OPENAI_MODEL !== provider.selectedModel ||
    !provider.environment.CHATGPT_ACCESS_TOKEN?.trim() ||
    !provider.environment.CHATGPT_ACCOUNT_ID?.trim()
  ) {
    return null;
  }
  const endpoint = getModelProviderPiEndpoint(
    "codex-oauth-token",
    "openai-codex-responses",
  );
  if (!endpoint) {
    return null;
  }
  const configuredBaseUrl = provider.environment.OPENAI_BASE_URL;
  if (
    configuredBaseUrl &&
    normalizedBaseUrl(configuredBaseUrl) !== normalizedBaseUrl(endpoint.baseUrl)
  ) {
    return null;
  }
  const config = {
    ...(codexServiceTier === "fast"
      ? {
          schemaVersion: PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
          serviceTier: codexServiceTier,
        }
      : { schemaVersion: PI_MODEL_CONFIG_CURRENT_GENERATION }),
    dialect: "openai-codex-responses",
    transport: "sse",
    provider: "openai-codex",
    baseUrl: endpoint.baseUrl,
    model: provider.selectedModel,
    thinkingLevel: "max",
    credentialBindings: [
      {
        kind: "access-token",
        environment: "CHATGPT_ACCESS_TOKEN",
        secretName: "CHATGPT_ACCESS_TOKEN",
      },
      {
        kind: "account-id",
        environment: "CHATGPT_ACCOUNT_ID",
        secretName: "CHATGPT_ACCOUNT_ID",
      },
    ],
  } satisfies PiModelConfig;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: "sandbox-access-token-placeholder",
    accountId: "sandbox-account-id-placeholder",
    dialect: config.dialect,
    transport: config.transport,
    thinkingLevel: config.thinkingLevel,
    serviceTier: codexServiceTier,
  })
    ? config
    : null;
}

function resolveCustomGatewayPiModelConfig(
  provider: PiModelProviderConfigInput,
  codexServiceTier: "fast" | undefined,
): PiModelConfig | null {
  if (
    provider.type !== "custom-openai-responses" ||
    provider.inlineFirewall !== true ||
    !provider.selectedModel ||
    !provider.credentialHeader
  ) {
    return null;
  }
  const catalogProvider = piCatalogProvider(provider.selectedModel);
  const baseUrl = provider.environment.OPENAI_BASE_URL;
  const model = provider.environment.OPENAI_MODEL;
  if (!catalogProvider || !baseUrl || !model) {
    return null;
  }
  const runtimeContract = piRuntimeContract({
    providerType: provider.type,
    selectedModel: provider.selectedModel,
    codexServiceTier,
  });
  const config = {
    provider: catalogProvider,
    baseUrl,
    model,
    catalogModel: provider.selectedModel,
    apiKeyEnv: "OPENAI_API_KEY",
    credentialSecretName: GATEWAY_RUNTIME_SECRET_NAME,
    credentialHeader: provider.credentialHeader,
    ...runtimeContract,
  } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    catalogModel: config.catalogModel,
    apiKey: "sandbox-secret",
    dialect: "openai-responses",
    transport: "sse",
    ...runtimeContract,
  })
    ? config
    : null;
}

function resolveGptApiKeyPiModelConfig(
  provider: PiModelProviderConfigInput,
  codexServiceTier: "fast" | undefined,
): PiModelConfig | null {
  const route = gptApiKeyPiRoute(provider.type);
  if (
    !route ||
    !isPiGptModel(provider.selectedModel) ||
    provider.inlineFirewall === true ||
    provider.credentialHeader !== undefined ||
    (provider.concreteType !== undefined &&
      provider.concreteType !== route.productProviderType) ||
    !route.endpoint ||
    getSecretNameForType(route.productProviderType) !==
      route.credentialSecretName ||
    provider.environment.OPENAI_MODEL !==
      `${route.modelPrefix}${provider.selectedModel}` ||
    !provider.environment.OPENAI_API_KEY?.trim()
  ) {
    return null;
  }
  const configuredBaseUrl = provider.environment.OPENAI_BASE_URL;
  if (
    configuredBaseUrl &&
    normalizedBaseUrl(configuredBaseUrl) !==
      normalizedBaseUrl(route.endpoint.baseUrl)
  ) {
    return null;
  }
  const serviceTier = codexServiceTier === "fast" ? "priority" : undefined;
  const config = {
    ...(serviceTier === undefined
      ? { schemaVersion: PI_MODEL_CONFIG_CURRENT_GENERATION }
      : {
          schemaVersion: PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
          serviceTier,
        }),
    dialect: "openai-responses",
    transport: "sse",
    provider: route.provider,
    baseUrl: route.endpoint.baseUrl,
    model: `${route.modelPrefix}${provider.selectedModel}`,
    ...(route.productProviderType === "vercel-ai-gateway-codex"
      ? { catalogModel: provider.selectedModel }
      : {}),
    thinkingLevel: "max",
    credentialBindings: [
      {
        kind: "api-key",
        environment: "OPENAI_API_KEY",
        secretName: route.credentialSecretName,
      },
    ],
  } satisfies PiModelConfig;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    ...(config.catalogModel ? { catalogModel: config.catalogModel } : {}),
    apiKey: "sandbox-secret",
    dialect: config.dialect,
    transport: config.transport,
    thinkingLevel: config.thinkingLevel,
    serviceTier,
  })
    ? config
    : null;
}

function resolvePiRouteModelConfig(
  provider: PiModelProviderConfigInput | null,
  codexServiceTier: "fast" | undefined = undefined,
): PiModelConfig | null {
  if (!provider || !provider.selectedModel) {
    return null;
  }
  if (provider.piModelConfig) {
    return provider.piModelConfig;
  }
  if (isPiNativeModel(provider.selectedModel)) {
    return resolvePiNativeModelConfig(provider);
  }
  if (provider.type === "codex-oauth-token") {
    return resolveCodexSubscriptionPiModelConfig(provider, codexServiceTier);
  }
  if (provider.type === "custom-openai-responses") {
    return resolveCustomGatewayPiModelConfig(provider, codexServiceTier);
  }
  if (
    isGptApiKeyPiProviderType(provider.type) &&
    isPiGptModel(provider.selectedModel)
  ) {
    return resolveGptApiKeyPiModelConfig(provider, codexServiceTier);
  }
  return resolveResponsesPiModelConfig(
    { ...provider, selectedModel: provider.selectedModel },
    codexServiceTier,
  );
}

function resolveResponsesPiModelConfig(
  provider: PiModelProviderConfigInput & { readonly selectedModel: string },
  codexServiceTier: "fast" | undefined,
): PiModelConfig | null {
  if (provider.inlineFirewall) {
    return null;
  }
  const concreteType = modelProviderTypeSchema.safeParse(
    provider.concreteType ?? provider.type,
  );
  if (!concreteType.success) {
    return null;
  }
  const providerId = piProvider(concreteType.data);
  const credentialSecretName = getSecretNameForType(concreteType.data);
  if (!providerId || !credentialSecretName) {
    return null;
  }
  const model = provider.environment.OPENAI_MODEL ?? provider.selectedModel;
  if (
    model !== getProviderRuntimeModel(concreteType.data, provider.selectedModel)
  ) {
    return null;
  }
  if (!model) {
    return null;
  }
  const endpoint = getModelProviderPiEndpoint(
    concreteType.data,
    "openai-responses",
  );
  if (!endpoint) {
    return null;
  }
  const configuredBaseUrl = provider.environment.OPENAI_BASE_URL;
  if (
    configuredBaseUrl &&
    normalizedBaseUrl(configuredBaseUrl) !== normalizedBaseUrl(endpoint.baseUrl)
  ) {
    return null;
  }

  const apiKeyEnv = "OPENAI_API_KEY";
  const runtimeContract = piRuntimeContract({
    providerType: provider.type,
    selectedModel: provider.selectedModel,
    codexServiceTier,
  });
  const config = {
    provider: providerId,
    baseUrl: endpoint.baseUrl,
    model,
    apiKeyEnv,
    credentialSecretName,
    ...runtimeContract,
  } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: "sandbox-secret",
    dialect: "openai-responses",
    transport: "sse",
    ...runtimeContract,
  })
    ? config
    : null;
}

/** Apply the run's effective effort to every Pi dialect before capturing its launch context. */
export function resolvePiSandboxModelConfig(
  provider: PiModelProviderConfigInput | null,
  codexServiceTier: "fast" | undefined = undefined,
  reasoningEffort: ReasoningEffort | null | undefined = undefined,
): PiModelConfig | null {
  const config = resolvePiRouteModelConfig(provider, codexServiceTier);
  if (!config || reasoningEffort === null || reasoningEffort === undefined) {
    return config;
  }
  return {
    ...config,
    thinkingLevel: piThinkingLevelForEffort(reasoningEffort),
  };
}
