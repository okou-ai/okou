import {
  getModelProviderPiEndpoint,
  getSecretNameForType,
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  piThinkingLevelForEffort,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { OPENROUTER_US_ORIGIN } from "@okouai/api-contracts/contracts/openrouter-routing";
import {
  PI_MODEL_CONFIG_CURRENT_GENERATION,
  PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
  type PiModelConfig,
} from "@okouai/api-contracts/contracts/runners";
import {
  isPiExecutionRoute,
  isPresetUpstreamModel,
  piCatalogModel,
  type PiCatalogModel,
  type PiRouteClass,
} from "@okouai/core/pi-execution";
import { isPiAgentModelSupported } from "@okouai/pi-agent-runtime";
import { PI_MEMORY_STAGE1_BUILT_IN_MODEL } from "@okouai/pi-agent-runtime/api";

import {
  AUTO_RUN_MODEL,
  AUTO_RUN_PROVIDER,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import { env } from "../../lib/env";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import type { ModelCatalog } from "./model-catalog.service";
import { PiModelConfigurationError } from "./pi-model-configuration-error";

/**
 * Resolve non-secret model metadata for the sandbox Pi runtime. Credentials
 * remain in the ordinary encrypted run context and are never embedded in this
 * launch metadata.
 */

function normalizedBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function piProvider(concreteType: ModelProviderType): "openrouter" | null {
  return concreteType === "openrouter-codex" ? "openrouter" : null;
}

/**
 * Route canonical chat threads by model and provider route. Trigger source is
 * intentionally absent so every thread-bound launch shares the same admission.
 */
export function shouldUsePiExecution(args: {
  readonly chatThreadId: string | undefined;
  readonly modelProviderType: string | null | undefined;
  /** The selected model's catalog projection (`piCatalogModel`). */
  readonly catalogModel: PiCatalogModel | null;
  readonly codexServiceTier: "fast" | "ultrafast" | undefined;
  readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
}): boolean {
  return (
    Boolean(args.chatThreadId) &&
    isPiExecutionRoute({
      catalogModel: args.catalogModel,
      modelProviderType: args.modelProviderType,
      runtimeProviderType:
        args.builtInModelRuntimeRoute?.providerType ?? args.modelProviderType,
      codexServiceTier: args.codexServiceTier,
    })
  );
}

interface PiModelProviderConfigInput {
  readonly upstreamModel?: string;
  readonly piModelConfig?: PiModelConfig;
  readonly type: string;
  readonly concreteType?: string;
  readonly environment: Record<string, string>;
  readonly selectedModel: string | null;
}

function resolveCodexSubscriptionPiModelConfig(
  provider: PiModelProviderConfigInput,
  routeClass: PiRouteClass | null,
  codexServiceTier: "fast" | "ultrafast" | undefined,
): PiModelConfig | null {
  if (
    provider.type !== "codex-oauth-token" ||
    codexServiceTier === "ultrafast" ||
    routeClass !== "gpt-codex" ||
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
    serviceTier: codexServiceTier === "fast" ? "fast" : undefined,
  })
    ? config
    : null;
}

function resolvePiRouteModelConfig(
  provider: PiModelProviderConfigInput | null,
  catalogModel: PiCatalogModel | null,
  codexServiceTier: "fast" | "ultrafast" | undefined,
): PiModelConfig | null {
  if (!provider || !provider.selectedModel) {
    return null;
  }
  if (provider.piModelConfig) {
    return provider.piModelConfig;
  }
  if (provider.type === "codex-oauth-token") {
    return resolveCodexSubscriptionPiModelConfig(
      provider,
      catalogModel?.model === provider.selectedModel
        ? catalogModel.piRouteClass
        : null,
      codexServiceTier,
    );
  }
  if (
    !isBuiltInModelProviderType(provider.type) ||
    provider.selectedModel !== AUTO_RUN_MODEL ||
    provider.concreteType !== AUTO_RUN_PROVIDER ||
    !isAutoRunPreset(provider.upstreamModel)
  ) {
    return null;
  }
  // An OpenRouter preset upstream configures reasoning and service tier
  // itself, so the client sends neither.
  return resolveResponsesPiModelConfig({
    ...provider,
    selectedModel: provider.selectedModel,
  });
}

function resolveResponsesPiModelConfig(
  provider: PiModelProviderConfigInput & { readonly selectedModel: string },
): PiModelConfig | null {
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
  // The provider environment was built from the catalog route; its upstream
  // model is the only model this Pi route may send.
  const expectedModel = provider.upstreamModel;
  if (model !== expectedModel) {
    return null;
  }
  if (!model) {
    return null;
  }
  const endpoint = getModelProviderPiEndpoint(
    concreteType.data,
    "openai-responses",
    // Captured global endpoints remain readable; only a captured US endpoint
    // selects the model-gated US route.
    provider.environment.OPENAI_BASE_URL === `${OPENROUTER_US_ORIGIN}/api/v1`
      ? { model }
      : undefined,
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
  const config = {
    provider: providerId,
    baseUrl: endpoint.baseUrl,
    model,
    apiKeyEnv,
    credentialSecretName,
    ...(isPresetUpstreamModel(provider.upstreamModel)
      ? { catalogModel: provider.selectedModel }
      : {}),
  } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    ...(config.catalogModel ? { catalogModel: config.catalogModel } : {}),
    apiKey: "sandbox-secret",
    dialect: "openai-responses",
    transport: "sse",
  })
    ? config
    : null;
}

/** Apply the run's effective effort to every Pi dialect before capturing its launch context. */
export function resolvePiSandboxModelConfig(
  provider: PiModelProviderConfigInput | null,
  catalogModel: PiCatalogModel | null,
  codexServiceTier: "fast" | "ultrafast" | undefined = undefined,
  reasoningEffort: ReasoningEffort | null | undefined = undefined,
): PiModelConfig | null {
  const config = resolvePiRouteModelConfig(
    provider,
    catalogModel,
    codexServiceTier,
  );
  if (
    !config ||
    isPresetUpstreamModel(provider?.upstreamModel) ||
    reasoningEffort === null ||
    reasoningEffort === undefined
  ) {
    return config;
  }
  return {
    ...config,
    thinkingLevel: piThinkingLevelForEffort(reasoningEffort),
  };
}

function assertCurrentPiCliArtifact(): void {
  // The writer and CLI reader are built from the same commit. A mutable or
  // differently pinned package cannot consume a newly captured model.
  const commit = env("GIT_COMMIT_SHA");
  const cliUrl = new URL(env("CLI_PKG_URL"));
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    cliUrl.origin !== "https://static.okou.io" ||
    cliUrl.username ||
    cliUrl.password ||
    cliUrl.search ||
    cliUrl.hash ||
    cliUrl.pathname !== `/okou-cli/${commit}/package.tgz`
  ) {
    throw new PiModelConfigurationError(
      "Pi requires the current commit-addressed CLI reader artifact",
    );
  }
}

/** The plain run facts Pi model preparation reads. */
export interface PiModelPreparationInput {
  readonly catalog: ModelCatalog;
  readonly piExecution: boolean;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly reasoningEffort?: ReasoningEffort | null;
}

export function materializePreparedPiProvider(
  input: PiModelPreparationInput,
  provider: ResolvedModelProviderEnvironment | null,
): ResolvedModelProviderEnvironment | null {
  if (!input.piExecution) {
    return provider;
  }
  const catalogModel = piCatalogModel(input.catalog, provider?.selectedModel);
  const config = resolvePiSandboxModelConfig(
    provider,
    catalogModel,
    input.codexServiceTier,
    input.reasoningEffort,
  );
  if (!config || !provider) {
    throw new Error(
      "Selected Pi execution requires a supported model provider configuration",
    );
  }
  return { ...provider, piModelConfig: config };
}

/** Maintenance has its own platform-funded extraction model, not a chat model choice. */
export function resolvePlatformMemoryPiModelConfig(
  provider: ResolvedModelProviderEnvironment,
): PiModelConfig {
  const route = provider.builtInModelRuntimeRoute;
  if (
    !isBuiltInModelProviderType(provider.type) ||
    provider.credentialOwner !== "builtin" ||
    provider.selectedModel !== PI_MEMORY_STAGE1_BUILT_IN_MODEL ||
    !route ||
    route.selectedModel !== provider.selectedModel ||
    route.upstreamModel !== provider.upstreamModel ||
    route.providerType !== provider.concreteType
  ) {
    throw new PiModelConfigurationError(
      "Invalid platform memory model binding",
    );
  }
  assertCurrentPiCliArtifact();
  const config = resolveResponsesPiModelConfig({
    ...provider,
    selectedModel: provider.selectedModel,
  });
  if (!config) {
    throw new PiModelConfigurationError(
      "Platform memory model configuration is unavailable",
    );
  }
  return config;
}

export function resolvePreparedPiModelConfig(args: {
  readonly input: PiModelPreparationInput;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
}): PiModelConfig | undefined {
  if (!args.input.piExecution) {
    return undefined;
  }
  const config = resolvePiSandboxModelConfig(
    args.modelProvider,
    piCatalogModel(args.input.catalog, args.modelProvider?.selectedModel),
    args.input.codexServiceTier,
    args.input.reasoningEffort,
  );
  if (!config) {
    throw new Error(
      "Selected Pi execution requires a supported Pi model provider configuration",
    );
  }
  return config;
}
