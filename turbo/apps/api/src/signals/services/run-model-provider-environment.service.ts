/**
 * Run model provider environment shared by execution owners: framework
 * selection, Pi provider materialization/config, built-in route environment
 * and model usage pricing context. Moved verbatim out of the legacy execution
 * graph; exact source reads and pure conversion stay in execution-model-*.
 */
import { resolveModelProviderCodexRuntimeConfig } from "./model-provider-codex-runtime";
import { safeSync } from "../utils";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import type { ReadonlyDb } from "../external/db";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { SupportedFramework } from "@okouai/core/frameworks";
import { env } from "../../lib/env";
import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import { runCreateBodySchema } from "@okouai/api-contracts/contracts/run-routes";
import {
  type ModelProviderType,
  type ModelProviderCredentialScope,
  isBuiltInModelProviderType,
  getFrameworkForType,
  MODEL_PROVIDER_TYPES,
  getSecretNameForType,
  getModelProviderFirewall,
  getModelProviderEnvBindings,
  getDefaultModel,
  type ModelProviderEnvBindings,
  normalizeRunModelId,
} from "@okouai/api-contracts/contracts/model-providers";
import type { AgentExecutionConfig as agentRunCreateAgentExecutionConfig } from "./agent-execution-config";
import { z } from "zod";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { PI_NATIVE_CREDENTIAL_PLACEHOLDER } from "@okouai/api-contracts/contracts/pi-native";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  catalogBuiltInCandidates,
  catalogBuiltInRoute,
  type ModelCatalog,
  type CatalogRoute,
} from "./model-catalog.service";
import {
  type BuiltInRoutePricing,
  builtInRoutePricingRejectionMessage,
  loadBuiltInRoutePricing,
  unpricedBuiltInRouteCategories,
} from "./built-in-route-pricing";
import type { UsagePricingResolution } from "../context/usage-pricing-resolution";
import {
  type CapturedPersonalSubscriptionAccount,
  isPersonalSubscriptionProviderType,
  type MemberModelAccountSnapshot,
} from "./model-provider-account.service";
import type {
  DispatchFailedRunCallbacks,
  PersistProducerRunBinding,
  AgentRunModelPin,
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
} from "./agent-run-contracts";
import type { ChatThreadSessionRoute } from "./chat-session-continuity.service";
import type { QueueFirstRunAssociation } from "./chat-queued-event.service";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import {
  type PiExecutionRoute,
  normalizePiExecutionRoute,
  assertPiNativeCredential,
  materializePiExecutionRoute,
} from "@okouai/pi-agent-runtime";
import {
  OPENROUTER_US_ORIGIN,
  getOpenRouterBaseUrl,
} from "@okouai/api-contracts/contracts/openrouter-routing";
import { piCatalogModel } from "@okouai/core/pi-execution";
import { resolvePiSandboxModelConfig } from "./pi-sandbox-config";
import { piNativeFirewall } from "@okouai/api-contracts/contracts/pi-native-firewall";
import type { AuthContext } from "../../types/auth";
import type { WebChatSessionPromptContext } from "./web-chat-session-prompt.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  CreateAgentRunArgs,
  CreateRunErrorResult,
  PermissionManifest,
  ResolvedModelProviderEnvironment,
  firstAgent,
} from "./execution-launch-persistence.service";
import { AgentRunRecord } from "./execution-storage-manifest.service";

interface ModelUsageContext {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
}

export function modelProviderFramework(
  modelProvider: ResolvedModelProviderEnvironment,
): SupportedFramework {
  return getFrameworkForType(modelProvider.concreteType ?? modelProvider.type);
}

export function frameworkForProviderSelection(
  catalog: ModelCatalog,
  providerType: ModelProviderType,
  selectedModel: string | null | undefined,
): SupportedFramework | null {
  if (!isBuiltInModelProviderType(providerType)) {
    return getFrameworkForType(providerType);
  }
  // The Built-in framework follows the primary catalog candidate's concrete
  // provider protocol.
  const [primary] = catalogBuiltInCandidates(
    catalog,
    selectedModel ?? catalog.systemDefaultModel,
  );
  const concrete = primary?.concreteProviderType;
  return concrete !== undefined && isModelProviderType(concrete)
    ? getFrameworkForType(concrete)
    : null;
}

export function frameworkApiKeyEnv(framework: SupportedFramework): string {
  return framework === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

export function hasExplicitFrameworkApiKey(
  content: agentRunCreateAgentExecutionConfig,
  framework: SupportedFramework,
): boolean {
  return (
    firstAgent(content)?.environment?.[frameworkApiKeyEnv(framework)] !==
    undefined
  );
}

export function isModelProviderType(type: string): type is ModelProviderType {
  return Object.hasOwn(MODEL_PROVIDER_TYPES, type);
}

function envBindingsRequireModel(
  envBindings: ModelProviderEnvBindings,
): boolean {
  return Object.values(envBindings).some((value) => {
    return value.includes("$model");
  });
}

export function resolveModelProviderModel(args: {
  readonly type: ModelProviderType;
  readonly selectedModel: string | null;
  readonly defaultModel: string | undefined;
  readonly envBindings: ModelProviderEnvBindings | undefined;
}): string | null {
  let model = args.selectedModel;
  if (model === null && args.defaultModel !== undefined) {
    model = args.defaultModel;
  }
  if (
    args.envBindings &&
    envBindingsRequireModel(args.envBindings) &&
    !model &&
    args.defaultModel !== ""
  ) {
    throw new Error(`Missing model for model provider ${args.type}`);
  }
  return model === "" ? null : model;
}

export function modelProviderEnvironmentSecretValue(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
): string {
  return getModelProviderFirewall(type)
    ? `\${{ secrets.${secretName} }}`
    : secretValue;
}

function providerEnvironmentFromSecretRefs(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
  selectedModel: string | null,
): Record<string, string> {
  const envBindings = getModelProviderEnvBindings(type);
  if (!envBindings) {
    return {
      [secretName]: modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      ),
    };
  }

  const model = resolveModelProviderModel({
    type,
    selectedModel,
    defaultModel: getDefaultModel(type),
    envBindings,
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    if (value === "$secret") {
      environment[key] = modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      );
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const referencedSecret = value.slice("$secrets.".length);
      if (referencedSecret === secretName) {
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          referencedSecret,
          secretValue,
        );
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

/**
 * A new run's Built-in route selection skips candidates whose billable
 * categories for the requested service tier lack usage_pricing.
 */
export interface NewRunRoutePricingRequest {
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resolution: UsagePricingResolution;
}

export interface ResolveModelProviderEnvironmentArgs {
  /** Loaded once per run and shared by every candidate route. */
  readonly catalog: ModelCatalog;
  readonly newRunPricing?: NewRunRoutePricingRequest;
  readonly orgId: string;
  readonly userId: string;
  readonly framework: SupportedFramework;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly retainedRunId?: string;
  readonly piExecution: boolean;
  readonly featureSwitchContext: FeatureSwitchContext;
}

export function nativeCredentialEnvironment(
  route: PiExecutionRoute | undefined,
): Record<string, string> {
  return route &&
    (route.dialect === "anthropic-messages" ||
      route.dialect === "bedrock-converse-stream")
    ? Object.fromEntries(
        route.credentialBindings.map((binding) => {
          return [binding.environment, PI_NATIVE_CREDENTIAL_PLACEHOLDER];
        }),
      )
    : {};
}

function billableFirewallsForPermissions(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissions: PermissionManifest | undefined;
}): string[] {
  const firewalls = args.permissions?.firewalls ?? [];
  const firewallNames = firewalls.map((firewall) => {
    return firewall.kind === "builtin" ? firewall.name : firewall.firewall.name;
  });
  const modelFirewalls = isBuiltInModelProviderType(args.modelProvider?.type)
    ? firewallNames.filter(isModelProviderFirewallName)
    : [];
  const connectorFirewalls = args.permissions?.billableFirewalls ?? [];

  return [...modelFirewalls, ...connectorFirewalls];
}

function isModelProviderFirewallName(name: string): boolean {
  return name.startsWith("model-provider:");
}

function validateModelUsageProviderInvariant(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
}): CreateRunErrorResult | null {
  if (!isBuiltInModelProviderType(args.modelProvider?.type)) {
    return null;
  }
  if (!args.billableFirewalls.some(isModelProviderFirewallName)) {
    return null;
  }
  if (args.modelUsageProvider) {
    return null;
  }
  return providerUnavailable(
    "Built-in model provider did not resolve a supported model for usage reporting",
  );
}

export function prepareModelUsageContext(args: {
  readonly catalog: ModelCatalog;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionManifest: PermissionManifest | undefined;
  /**
   * The run's Built-in route pricing, read from the same catalog snapshot;
   * required for a Built-in run (null for every other run).
   */
  readonly routePricing: BuiltInRoutePricing | null;
}): ModelUsageContext | CreateRunErrorResult {
  const billableFirewalls = billableFirewallsForPermissions({
    modelProvider: args.modelProvider,
    permissions: args.permissionManifest,
  });
  const route = builtInRouteForContext(args.catalog, args.modelProvider);
  const modelUsageProvider = isBuiltInModelProviderType(
    args.modelProvider?.type,
  )
    ? (route?.pricingProvider ?? undefined)
    : catalogModelUsageProvider(args.catalog, args.modelProvider);
  const validation =
    validateModelUsageProviderInvariant({
      modelProvider: args.modelProvider,
      billableFirewalls,
      modelUsageProvider,
    }) ??
    validateBuiltInRoutePricing({
      billableFirewalls,
      route,
      routePricing: args.routePricing,
    });

  return (
    validation ?? {
      billableFirewalls,
      modelUsageProvider,
      // The assigned route's own pricing trigger; a pricing alias never
      // changes it. Non-Built-in runs are not platform-billed.
      modelUsageLongContextMinTotalInputTokens:
        route?.longContextMinTotalInputTokens ?? 0,
    }
  );
}

/**
 * The pricing snapshot of a Built-in run's model candidates (one read), or
 * null for every other run.
 */
export async function loadRunRoutePricing(
  db: ReadonlyDb,
  args: {
    readonly catalog: ModelCatalog;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly serviceTier: CodexServiceTier | undefined;
    readonly resolution: UsagePricingResolution;
  },
): Promise<BuiltInRoutePricing | null> {
  const selectedModel = args.modelProvider?.selectedModel;
  if (!selectedModel || !isBuiltInModelProviderType(args.modelProvider?.type)) {
    return null;
  }
  return await loadBuiltInRoutePricing(db, {
    catalog: args.catalog,
    model: normalizeRunModelId(selectedModel),
    serviceTier: args.serviceTier,
    resolution: args.resolution,
  });
}

/**
 * Final new-run admission: every usage category the assigned Built-in route
 * can report for this run's service tier must resolve to a `usage_pricing`
 * row (or the provider's `__fallback__` row) with settlement's lookup, so a
 * run never executes into `missing_pricing`. Route selection already skips
 * unpriced candidates; this also covers a route captured earlier.
 */
function validateBuiltInRoutePricing(args: {
  readonly billableFirewalls: readonly string[];
  readonly route: CatalogRoute | null;
  readonly routePricing: BuiltInRoutePricing | null;
}): CreateRunErrorResult | null {
  if (
    !args.route ||
    !args.billableFirewalls.some(isModelProviderFirewallName)
  ) {
    return null;
  }
  if (!args.routePricing) {
    throw new Error("A Built-in run requires its route pricing snapshot");
  }
  const unpriced = unpricedBuiltInRouteCategories(
    args.routePricing,
    args.route,
  );
  if (unpriced.length === 0) {
    return null;
  }
  return providerUnavailable(
    builtInRoutePricingRejectionMessage(args.route.model, [
      {
        concreteProviderType: args.route.concreteProviderType,
        categories: unpriced,
      },
    ]),
  );
}

/**
 * The catalog Built-in route a Built-in run was assigned. Its pricing link is
 * the provider the Runner addon reports model usage events under, which
 * settlement uses as the `usage_pricing` provider; it is read from the same
 * catalog snapshot as the route itself, and the selected model stays the
 * run's model.
 */
function builtInRouteForContext(
  catalog: ModelCatalog,
  modelProvider: ResolvedModelProviderEnvironment | null,
): CatalogRoute | null {
  if (
    !modelProvider?.selectedModel ||
    !isBuiltInModelProviderType(modelProvider.type)
  ) {
    return null;
  }
  const concreteProviderType =
    modelProvider.builtInModelRuntimeRoute?.providerType ??
    modelProvider.concreteType;
  if (!concreteProviderType) {
    return null;
  }
  return catalogBuiltInRoute(
    catalog,
    normalizeRunModelId(modelProvider.selectedModel),
    concreteProviderType,
  );
}

/**
 * Runs other than Built-in are not platform-billed (only Built-in runs have
 * billable model firewalls) and keep reporting under the catalog model ID.
 */
function catalogModelUsageProvider(
  catalog: ModelCatalog,
  modelProvider: ResolvedModelProviderEnvironment | null,
): string | undefined {
  // A provider-only model ID (for example a BYOK provider default) has no
  // catalog pricing identity.
  if (!modelProvider?.selectedModel) {
    return undefined;
  }
  const model = normalizeRunModelId(modelProvider.selectedModel);
  return catalog.byModel.has(model) ? model : undefined;
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
    throw new PiNativeConfigurationError(
      "Pi requires the current commit-addressed CLI reader artifact",
    );
  }
}

export async function materializePreparedPiProvider(
  createArgs: RunModelProviderArgs,
  provider: ResolvedModelProviderEnvironment | null,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!createArgs.piExecution) {
    return provider;
  }
  const catalogModel = piCatalogModel(
    createArgs.catalog,
    provider?.selectedModel,
  );
  const config = resolvePiSandboxModelConfig(
    provider,
    catalogModel,
    createArgs.codexServiceTier,
    createArgs.agentRunMetadata?.reasoningEffort,
  );
  if (!config || !provider) {
    throw new Error(
      "Selected Pi execution requires a supported model provider configuration",
    );
  }
  if (provider.selectedModel === "deepseek-v4.1-flash") {
    assertCurrentPiCliArtifact();
  }
  if (!("schemaVersion" in config) || config.schemaVersion !== 4) {
    if (
      !("schemaVersion" in config) &&
      (provider.type === "deepseek" || provider.type === "openrouter-codex") &&
      catalogModel?.piRouteClass === "deepseek"
    ) {
      const credential = safeSync(() => {
        return assertPiNativeCredential(
          provider.secrets[config.credentialSecretName] ?? "",
        );
      });
      if ("error" in credential) {
        throw new PiNativeConfigurationError(
          "Selected Pi credential is invalid",
        );
      }
      return {
        ...provider,
        piModelConfig: config,
        secretConnectorMap: undefined,
        secretConnectorMetadataMap: undefined,
      };
    }
    return { ...provider, piModelConfig: config };
  }
  assertCurrentPiCliArtifact();
  const secrets: Record<string, string> = {};
  const route = normalizePiExecutionRoute(config);
  await materializePiExecutionRoute({
    route,
    target: "direct",
    resolveCredential(binding) {
      const value = provider.secrets[binding.secretName];
      if (!value) {
        throw new PiNativeConfigurationError(
          "Selected native Pi credential is unavailable",
        );
      }
      const credential = safeSync(() => {
        return assertPiNativeCredential(value);
      });
      if ("error" in credential) {
        throw new PiNativeConfigurationError(
          "Selected Pi credential is invalid",
        );
      }
      secrets[binding.secretName] = value;
      return value;
    },
  });
  return {
    ...provider,
    piModelConfig: config,
    environment: nativeCredentialEnvironment(route),
    secrets,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    firewall: piNativeFirewall(config),
    inlineFirewall: true,
  };
}

export function resolvePreparedPiModelConfig(args: {
  readonly createArgs: Pick<
    CreateAgentRunArgs,
    "catalog" | "piExecution" | "codexServiceTier" | "agentRunMetadata"
  >;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
}): PiModelConfig | undefined {
  if (!args.createArgs.piExecution) {
    return undefined;
  }
  const config = resolvePiSandboxModelConfig(
    args.modelProvider,
    piCatalogModel(args.createArgs.catalog, args.modelProvider?.selectedModel),
    args.createArgs.codexServiceTier,
    args.createArgs.agentRunMetadata?.reasoningEffort,
  );
  if (!config) {
    throw new Error(
      "Selected Pi execution requires a supported Pi model provider configuration",
    );
  }
  return config;
}

export function piConfigurationRouteError(
  error: unknown,
): ReturnType<typeof badRequestMessage> {
  if (error instanceof PiNativeConfigurationError) {
    return badRequestMessage(error.message);
  }
  throw error;
}

export function builtInModelProviderEnvironmentFromSnapshot(args: {
  readonly route: BuiltInModelRuntimeRoute;
  readonly selectedModel: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly apiKey: string;
}): ResolvedModelProviderEnvironment | null {
  const { route, selectedModel, featureSwitchContext } = args;
  const key = { apiKey: args.apiKey };
  const secretName = getSecretNameForType(route.providerType);
  if (!secretName) {
    return null;
  }
  const environment = providerEnvironmentFromSecretRefs(
    route.providerType,
    secretName,
    key.apiKey,
    route.upstreamModel,
  );
  const routing = {
    credentialOwner: "builtin" as const,
    model: route.upstreamModel,
    usRoutingEnabled: isFeatureEnabled(
      FeatureSwitchKey.OpenRouterUsRouting,
      featureSwitchContext,
    ),
  };
  const firewall = getModelProviderFirewall(route.providerType, routing);
  const usesUsEndpoint = firewall?.apis.some((api) => {
    return api.base.startsWith(`${OPENROUTER_US_ORIGIN}/`);
  });
  if (route.providerType === "openrouter-api-key") {
    environment.ANTHROPIC_BASE_URL = getOpenRouterBaseUrl("messages", routing);
  } else if (route.providerType === "openrouter-codex") {
    environment.OPENAI_BASE_URL = getOpenRouterBaseUrl("responses", routing);
  }
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type: route.providerType,
    logicalModel: selectedModel,
    runtimeModel: route.upstreamModel,
    environment,
  });

  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    environment,
    secrets: { [secretName]: key.apiKey },
    selectedModel,
    builtInModelRuntimeRoute: route,
    upstreamModel: route.upstreamModel,
    ...(usesUsEndpoint ? { firewall } : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
  };
}

export type RunModelProviderArgs = Pick<
  CreateAgentRunArgs,
  | "catalog"
  | "orgId"
  | "userId"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "modelProviderType"
  | "capturedPersonalSubscriptionAccount"
  | "selectedModelOverride"
  | "builtInModelRuntimeRoute"
  | "piExecution"
  | "retainedRunId"
  | "codexServiceTier"
  | "agentRunMetadata"
  | "queueFirstAssociation"
>;

export interface RunModelProviderReadInput {
  readonly db: ReadonlyDb;
  readonly timing: ApiDispatchTimingCollector;
  readonly args: RunModelProviderArgs;
}

/** Post-reservation materializer. This never inserts a Run or invokes the API
 * first turn. Publication owns a fresh admission. */

// Selected-agent authorization, bootstrap and canonical session preparation.

export type AgentRunCreateBody = z.infer<typeof runCreateBodySchema>;

/**
 * Request-scoped preparation facts from an entry point that already authorized
 * this exact user, organization, and Agent. These observations can remove
 * equivalent preflight reads, but they never authorize the later launch
 * transaction: compute admission still resolves the Agent and its ownership
 * again before it claims input or inserts a Run.
 *
 * When this object is present, nullable Agent metadata and feature overrides
 * are authoritative observations. The bootstrap materializer may enrich an
 * omitted email from the same request's user-info row. Absence of the object
 * means those facts were not loaded and every existing database fallback
 * remains.
 */
export interface AuthorizedAgentRunRequestObservation {
  readonly userId: string;
  readonly orgId: string;
  readonly agent: AgentRunRequestAgent;
  readonly featureSwitchContext: FeatureSwitchContext;
}

function optionalAgentSetting(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

export interface AgentRunsCreateHttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

export interface AgentRunsCreateInternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

type AgentRunsCreateRunCallback =
  | AgentRunsCreateHttpRunCallback
  | AgentRunsCreateInternalRunCallback;

export interface AgentRunsCreateAgentRunMetadata {
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export interface CreateAgentRunCommandArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: AgentRunCreateBody;
  readonly apiStartTime: number;
  readonly triggerSource?: TriggerSource;
  readonly appendSystemPrompt?: string;
  readonly userInfoExtras?: Pick<
    UserInfo,
    | "slackDisplayName"
    | "slackUserId"
    | "feishuDisplayName"
    | "feishuOpenId"
    | "teamsUserDisplayName"
    | "teamsUserPrincipalName"
    | "teamsUserId"
    | "telegramDisplayName"
    | "telegramUsername"
    | "telegramUserId"
    | "telegramLanguage"
    | "agentphoneHandle"
  >;
  readonly callbacks?: readonly AgentRunsCreateRunCallback[];
  readonly chatThreadId?: string;
  readonly connectorSourceId?: string;
  readonly threadSessionRoute?: ChatThreadSessionRoute;
  /** A producer may atomically move an integration thread to this run's agent. */
  readonly expectedThreadAgentId?: string;
  readonly webChatSessionPromptContext?: WebChatSessionPromptContext;
  readonly computerUseHostId?: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly agentRunMetadata?: AgentRunsCreateAgentRunMetadata;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly dispatchFailedCallbacks?: DispatchFailedRunCallbacks;
  readonly persistProducerRunBinding?: PersistProducerRunBinding;
  readonly agentRunModelPin?: AgentRunModelPin;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly timing?: ApiDispatchTimingCollector;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
}

export interface QueuedRunCommandArgs extends Omit<
  CreateAgentRunCommandArgs,
  "chatThreadId" | "agentRunModelPin"
> {
  readonly chatThreadId: string;
  readonly queueFirstAssociation: QueueFirstRunAssociation;
  readonly agentRunModelPin: AgentRunModelPin;
}

export type AnyCreateAgentRunCommandArgs =
  | CreateAgentRunCommandArgs
  | QueuedRunCommandArgs;

export interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly slackDisplayName?: string;
  readonly slackUserId?: string;
  readonly feishuDisplayName?: string;
  readonly feishuOpenId?: string;
  readonly teamsUserDisplayName?: string;
  readonly teamsUserPrincipalName?: string;
  readonly teamsUserId?: string;
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
  readonly agentphoneHandle?: string;
}

export type AgentRunSelectionInput = Omit<
  AnyCreateAgentRunCommandArgs,
  "body" | "appendSystemPrompt" | "callbacks"
> & {
  readonly body: Omit<AgentRunCreateBody, "prompt">;
  readonly queueFirstAssociation?: QueuedRunCommandArgs["queueFirstAssociation"];
};
export type AgentRunIdentityCommand = Omit<
  AgentRunSelectionInput,
  "piExecution"
> & {
  readonly piExecution?: boolean;
};

export function personalSubscriptionAccountCandidates(args: {
  readonly command: AgentRunIdentityCommand;
  readonly providerType: string;
  readonly modelProviderId: string | null;
  readonly snapshot?: MemberModelAccountSnapshot | null;
}) {
  const snapshot = args.snapshot;
  if (
    !snapshot ||
    snapshot.orgId !== args.command.auth.orgId ||
    snapshot.userId !== args.command.auth.userId ||
    !isPersonalSubscriptionProviderType(args.providerType)
  ) {
    return undefined;
  }
  return snapshot.accounts.filter((account) => {
    if (
      account.disconnectedAt !== null ||
      account.orgId !== snapshot.orgId ||
      account.userId !== snapshot.userId
    ) {
      return false;
    }
    const activeType = account.type === args.providerType && account.isActive;
    return args.modelProviderId === null
      ? activeType
      : account.id === args.modelProviderId ||
          (account.modelProviderId === args.modelProviderId && activeType);
  });
}

export function selectedRunPiExecution(
  command: AgentRunIdentityCommand,
): boolean {
  if (command.piExecution === undefined) {
    throw new Error("Selected model execution eligibility is unavailable");
  }
  return command.piExecution;
}

export function selectedRunModelProviderArgs(
  command: AgentRunIdentityCommand,
  agent: AgentRunRecord,
  capturedPersonalSubscriptionAccount:
    | CapturedPersonalSubscriptionAccount
    | undefined,
): Omit<RunModelProviderArgs, "catalog"> {
  return {
    orgId: command.auth.orgId,
    userId: command.auth.userId,
    modelProviderId:
      command.modelProviderId ?? optionalAgentSetting(agent.modelProviderId),
    modelProviderCredentialScope: command.modelProviderCredentialScope,
    modelProviderType: command.body.modelProvider,
    capturedPersonalSubscriptionAccount,
    selectedModelOverride:
      command.selectedModelOverride ??
      optionalAgentSetting(agent.selectedModel),
    builtInModelRuntimeRoute: command.builtInModelRuntimeRoute,
    piExecution: selectedRunPiExecution(command),
    codexServiceTier: command.codexServiceTier,
    agentRunMetadata: { reasoningEffort: command.reasoningEffort },
    ...("queueFirstAssociation" in command
      ? { queueFirstAssociation: command.queueFirstAssociation }
      : {}),
  };
}
