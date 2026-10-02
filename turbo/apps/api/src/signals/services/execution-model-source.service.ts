import { computed, type Computed } from "ccstate";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { secrets } from "@okouai/db/schema/secret";
import {
  hasAuthMethods,
  modelProviderTypeSchema,
  BUILT_IN_MODEL_ROUTE_PROVIDERS,
  getSecretNameForType,
  type ModelProviderType,
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderCredentialScope,
  isBuiltInModelProviderType,
  getFrameworkForType,
  MODEL_PROVIDER_TYPES,
  getModelProviderFirewall,
  getModelProviderEnvBindings,
  getDefaultModel,
  type ModelProviderEnvBindings,
  normalizeRunModelId,
  getSecretsForAuthMethod,
} from "@okouai/api-contracts/contracts/model-providers";
import { db$, type ReadonlyDb } from "../external/db";
import {
  modelProviderSurfaceProtocolSchema,
  getModelProviderTypeForSurfaceProtocol,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import {
  GATEWAY_RUNTIME_SECRET_NAME,
  compileModelProviderGatewayRuntime,
} from "./model-provider-gateway-runtime";
import type {
  PiModelConfig,
  SecretConnectorMetadata,
  PiModelConfigLegacy,
  StoredConnectorPermissionBaseline,
  ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import type { CreateRunResponse } from "@okouai/api-contracts/contracts/runs";
import {
  type PiModelConfigV4,
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
} from "@okouai/api-contracts/contracts/pi-native";
import type {
  ExpandedFirewallConfig,
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import {
  type BuiltInModelRuntimeRoute,
  isBuiltInModelRuntimeRoutePermitted,
} from "./built-in-model-runtime-route.service";
import type {
  QueueFirstRunClaimResult,
  QueueFirstRunAssociation,
} from "./chat-queued-event.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { resolveModelProviderCodexRuntimeConfig } from "./model-provider-codex-runtime";
import { safeSync } from "../utils";
import { providerUnavailable } from "../../lib/error";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { SupportedFramework } from "@okouai/core/frameworks";
import { env } from "../../lib/env";
import {
  catalogBuiltInCandidates,
  catalogBuiltInRoute,
  type ModelCatalog,
  type CatalogRoute,
  catalogProviderUpstreamModel,
  catalogHasProviderRoute,
} from "./model-catalog.service";
import {
  type BuiltInRoutePricing,
  builtInRoutePricingRejectionMessage,
  loadBuiltInRoutePricing,
  unpricedBuiltInRouteCategories,
} from "./built-in-route-pricing";
import type { UsagePricingResolution } from "../context/usage-pricing-resolution";
import type { CapturedPersonalSubscriptionAccount } from "./model-provider-account.service";
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
import { providerTypeForSurfaceProtocol } from "./effective-model-route.service";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import {
  compileModelRuntime,
  type ModelCredentialValues,
} from "./execution-model-runtime";
import { decryptStoredSecretValue } from "./crypto.utils";

export type ModelSourceIdentity =
  | { readonly kind: "built-in"; readonly modelKeyId: string }
  | { readonly kind: "organization"; readonly modelProviderId: string }
  | { readonly kind: "member"; readonly accountId: string }
  | { readonly kind: "member-provider"; readonly modelProviderId: string }
  /**
   * An exact provider row whose pin carries no credential scope. The reader
   * resolves the member/workspace owner in the same statement; the snapshot
   * identity is the resolved organization or member-provider identity.
   */
  | { readonly kind: "unscoped-provider"; readonly modelProviderId: string }
  | { readonly kind: "gateway"; readonly surfaceId: string };

export interface ModelSourceRequest {
  readonly orgId: string;
  readonly userId: string;
  readonly source: ModelSourceIdentity;
}
export type ModelSourceCredential =
  | EncryptedModelCredential
  | ManagedModelKeyReference;
export interface ManagedModelKeyReference {
  readonly kind: "managed-key";
  readonly name: string;
  readonly modelKeyId: string;
}
export interface EncryptedModelCredential {
  readonly kind: "encrypted";
  readonly name: string;
  readonly encryptedValue: string;
}
export interface RegisteredProviderConfiguration {
  readonly kind: "registered-provider";
  readonly providerType: string;
  readonly authMethod: string | null;
  readonly managedVendor?: string;
  readonly configuredModel: string | null;
}
export interface GatewayProviderConfiguration {
  readonly kind: "gateway";
  readonly providerType: string;
  readonly protocol: "anthropic-messages" | "openai-responses";
  readonly displayName: string;
  readonly apiBaseUrl: string;
  readonly authHeaderName: string;
  readonly authHeaderTemplate: string;
  readonly modelMappings: Readonly<Record<string, string>>;
}
export type ModelSourceConfiguration =
  | RegisteredProviderConfiguration
  | GatewayProviderConfiguration;
export interface ModelSourceSnapshot {
  readonly identity: ModelSourceIdentity;
  readonly credentialOwner: "builtin" | "organization" | "member";
  readonly configuration: ModelSourceConfiguration;
  readonly credentials: readonly ModelSourceCredential[];
  readonly accountIdentity: string | null;
}

async function loadGatewaySource(
  db: Pick<ReadonlyDb, "select">,
  request: ModelSourceRequest,
  source: Extract<ModelSourceIdentity, { kind: "gateway" }>,
): Promise<ModelSourceSnapshot | null> {
  const [row] = await db
    .select({
      protocol: modelProviderSurfaces.protocol,
      apiBaseUrl: modelProviderSurfaces.apiBaseUrl,
      authHeaderName: modelProviderSurfaces.authHeaderName,
      authHeaderTemplate: modelProviderSurfaces.authHeaderTemplate,
      modelMappings: modelProviderSurfaces.modelMappings,
      displayName: modelProviderConnections.displayName,
      encryptedValue: secrets.encryptedValue,
      secretOrgId: secrets.orgId,
    })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
    )
    .innerJoin(secrets, eq(modelProviderConnections.secretId, secrets.id))
    .where(
      and(
        eq(modelProviderSurfaces.id, source.surfaceId),
        eq(modelProviderConnections.orgId, request.orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  if (row.secretOrgId !== request.orgId) {
    throw new Error("Gateway credential owner mismatch");
  }
  const protocol = modelProviderSurfaceProtocolSchema.parse(row.protocol);
  return {
    identity: source,
    credentialOwner: "organization",
    configuration: {
      kind: "gateway",
      providerType: getModelProviderTypeForSurfaceProtocol(protocol),
      protocol,
      apiBaseUrl: row.apiBaseUrl,
      authHeaderName: row.authHeaderName,
      authHeaderTemplate: row.authHeaderTemplate,
      modelMappings: row.modelMappings,
      displayName: row.displayName,
    },
    credentials: [
      {
        kind: "encrypted",
        name: GATEWAY_RUNTIME_SECRET_NAME,
        encryptedValue: row.encryptedValue,
      },
    ],
    accountIdentity: null,
  };
}

async function loadManagedSource(
  db: Pick<ReadonlyDb, "select">,
  source: Extract<ModelSourceIdentity, { kind: "built-in" }>,
): Promise<ModelSourceSnapshot | null> {
  const [key] = await db
    .select({ id: builtInModelKeys.id, vendor: builtInModelKeys.vendor })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, source.modelKeyId))
    .limit(1);
  if (!key) {
    return null;
  }
  const provider = Object.entries(BUILT_IN_MODEL_ROUTE_PROVIDERS).find(
    ([, config]) => {
      return config.vendor === key.vendor;
    },
  );
  if (!provider) {
    throw new Error("Managed model key vendor is unsupported");
  }
  const name = getSecretNameForType(modelProviderTypeSchema.parse(provider[0]));
  if (!name) {
    throw new Error("Managed model key has no credential binding");
  }
  return {
    identity: source,
    credentialOwner: "builtin",
    configuration: {
      kind: "registered-provider",
      providerType: "built-in",
      authMethod: null,
      managedVendor: key.vendor,
      configuredModel: null,
    },
    credentials: [{ kind: "managed-key", name, modelKeyId: key.id }],
    accountIdentity: null,
  };
}

const MULTI_AUTH_PROVIDER_TYPES = modelProviderTypeSchema.options.filter(
  (type) => {
    return hasAuthMethods(type);
  },
);

/**
 * One statement reads the exact provider row, its owner and its encrypted
 * credentials, so ownership and credentials come from the same snapshot.
 */
async function loadRegisteredProviderSource(
  db: ReadonlyDb,
  request: ModelSourceRequest,
  source: Extract<
    ModelSourceIdentity,
    { kind: "organization" | "member-provider" | "unscoped-provider" }
  >,
): Promise<ModelSourceSnapshot | null> {
  const owners =
    source.kind === "organization"
      ? [ORG_SENTINEL_USER_ID]
      : source.kind === "member-provider"
        ? [request.userId]
        : [request.userId, ORG_SENTINEL_USER_ID];
  const rows = await db
    .select({
      type: modelProviders.type,
      authMethod: modelProviders.authMethod,
      configuredModel: modelProviders.selectedModel,
      ownerUserId: modelProviders.userId,
      secret: { name: secrets.name, encryptedValue: secrets.encryptedValue },
    })
    .from(modelProviders)
    .leftJoin(
      secrets,
      and(
        eq(secrets.orgId, modelProviders.orgId),
        eq(secrets.userId, modelProviders.userId),
        or(
          and(
            inArray(modelProviders.type, MULTI_AUTH_PROVIDER_TYPES),
            eq(secrets.type, "model-provider"),
          ),
          and(
            notInArray(modelProviders.type, MULTI_AUTH_PROVIDER_TYPES),
            eq(secrets.id, modelProviders.secretId),
          ),
        ),
      ),
    )
    .where(
      and(
        eq(modelProviders.id, source.modelProviderId),
        eq(modelProviders.orgId, request.orgId),
        inArray(modelProviders.userId, owners),
      ),
    );
  const [first] = rows;
  if (!first) {
    return null;
  }
  modelProviderTypeSchema.parse(first.type);
  const organization = first.ownerUserId === ORG_SENTINEL_USER_ID;
  return {
    identity: organization
      ? { kind: "organization", modelProviderId: source.modelProviderId }
      : { kind: "member-provider", modelProviderId: source.modelProviderId },
    credentialOwner: organization ? "organization" : "member",
    configuration: {
      kind: "registered-provider",
      providerType: first.type,
      authMethod: first.authMethod,
      configuredModel: first.configuredModel,
    },
    credentials: rows.flatMap((row) => {
      return row.secret ? [{ kind: "encrypted" as const, ...row.secret }] : [];
    }),
    accountIdentity: null,
  };
}

/** Read only an already-selected source; never select defaults or decrypt. */
export function createModelSourceSnapshot(
  request: ModelSourceRequest,
): Computed<Promise<ModelSourceSnapshot | null>> {
  return computed(async (get): Promise<ModelSourceSnapshot | null> => {
    const db = get(db$);
    const source = request.source;
    if (source.kind === "gateway") {
      return await loadGatewaySource(db, request, source);
    }
    if (source.kind === "member") {
      const rows = await db
        .select({
          account: modelProviderAccounts,
          configuredModel: modelProviders.selectedModel,
          secret: {
            name: modelProviderAccountSecrets.name,
            encryptedValue: modelProviderAccountSecrets.encryptedValue,
          },
        })
        .from(modelProviderAccounts)
        .innerJoin(
          modelProviders,
          eq(modelProviderAccounts.modelProviderId, modelProviders.id),
        )
        .leftJoin(
          modelProviderAccountSecrets,
          eq(
            modelProviderAccountSecrets.modelProviderAccountId,
            modelProviderAccounts.id,
          ),
        )
        .where(
          and(
            eq(modelProviderAccounts.id, source.accountId),
            eq(modelProviderAccounts.orgId, request.orgId),
            eq(modelProviderAccounts.userId, request.userId),
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        );
      const first = rows[0];
      if (!first) {
        return null;
      }
      return {
        identity: source,
        credentialOwner: "member",
        configuration: {
          kind: "registered-provider",
          providerType: first.account.type,
          authMethod: first.account.authMethod,
          configuredModel: first.configuredModel,
        },
        credentials: rows.flatMap((row) => {
          return row.secret
            ? [{ kind: "encrypted" as const, ...row.secret }]
            : [];
        }),
        accountIdentity: first.account.externalAccountId,
      };
    }
    if (
      source.kind === "organization" ||
      source.kind === "member-provider" ||
      source.kind === "unscoped-provider"
    ) {
      return await loadRegisteredProviderSource(db, request, source);
    }
    return await loadManagedSource(db, source);
  });
}

// --- Private implementation: launch persistence ---

export interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export type QueueFirstRunClaimed = Extract<
  QueueFirstRunClaimResult,
  { readonly kind: "claimed" }
>;

type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
};

export interface ResolvedModelProviderEnvironment {
  readonly credentialOwner: PiModelConfigV4["credentialOwner"];
  readonly authMethod?: string | null;
  readonly piModelConfig?: PiModelConfig;
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly concreteType?: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly selectedModel: string | null;
  readonly firewall?: ExpandedFirewallConfig;
  readonly inlineFirewall?: boolean;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly codexRuntimeConfig?: ModelProviderCodexRuntimeConfig;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Catalog route `upstream_model` placed into the provider environment. */
  readonly upstreamModel?: string;
  readonly credentialHeader?: NonNullable<
    PiModelConfigLegacy["credentialHeader"]
  >;
}

export type BuiltinRuntimeTargetRegistration = Extract<
  ConnectorRuntimeTargetRegistration,
  { readonly kind: "builtin" }
>;

export interface PermissionManifest {
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly builtinRuntimeTargets?: readonly BuiltinRuntimeTargetRegistration[];
  readonly connectorPermissionBaseline?: StoredConnectorPermissionBaseline;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly billableFirewalls: readonly string[];
}

export type ApiErrorResponse<Status extends number, Code extends string> = {
  readonly status: Status;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: Code;
    };
  };
};

export type CreateRunRouteResult =
  | CreateRunSuccessResult
  | ApiErrorResponse<400, "BAD_REQUEST">
  | ApiErrorResponse<403, "FORBIDDEN">
  | ApiErrorResponse<404, "NOT_FOUND">
  | (ApiErrorResponse<409, "CONFLICT"> & {
      /** Producer-facing classification; the HTTP response body is unchanged. */
      readonly admissionFailure?: "subscription_account_disconnected";
    })
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<402, "PRO_REQUIRED">
  | ApiErrorResponse<503, "PROVIDER_UNAVAILABLE">;

export type CreateRunErrorResult = Exclude<
  CreateRunRouteResult,
  { readonly status: 201 }
>;
// --- Private implementation: model provider environment ---

interface ModelUsageContext {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
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

function isModelProviderType(type: string): type is ModelProviderType {
  return Object.hasOwn(MODEL_PROVIDER_TYPES, type);
}

function envBindingsRequireModel(
  envBindings: ModelProviderEnvBindings,
): boolean {
  return Object.values(envBindings).some((value) => {
    return value.includes("$model");
  });
}

function resolveModelProviderModel(args: {
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

function modelProviderEnvironmentSecretValue(
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
interface NewRunRoutePricingRequest {
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
    RunModelProviderArgs,
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

function builtInModelProviderEnvironmentFromSnapshot(args: {
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

/** The model-selection facts of one run that its model environment reads. */
export interface RunModelProviderArgs {
  /** The run's single catalog snapshot; every model decision reads it. */
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  /** Captured by the product entry point for this request only. This skips
   * an identity lookup, never the fresh environment or admission checks. */
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly retainedRunId?: string;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
}
// --- Private implementation: model preparation ---

function modelCredentialsAreUsable(
  source: ModelSourceSnapshot,
  type: ModelProviderType,
  credentials: ModelCredentialValues,
): boolean {
  if (hasAuthMethods(type)) {
    const method =
      source.configuration.kind === "registered-provider"
        ? source.configuration.authMethod
        : null;
    const rules = method ? getSecretsForAuthMethod(type, method) : undefined;
    return (
      rules !== undefined &&
      Object.entries(rules).every(([name, rule]) => {
        return !rule.required || !!credentials[name];
      })
    );
  }
  const name = getSecretNameForType(type);
  return name !== undefined && name !== null && !!credentials[name]?.trim();
}

function selectedSourceUpstream(
  catalog: ModelCatalog,
  source: ModelSourceSnapshot,
  type: ModelProviderType,
  logicalModel: string,
  piExecution: boolean | undefined,
): string | null {
  const cloud = type === "aws-bedrock" || type === "azure-foundry";
  const upstream =
    cloud && source.configuration.kind === "registered-provider"
      ? source.configuration.configuredModel
      : catalogProviderUpstreamModel(catalog, logicalModel, type);
  if (
    cloud &&
    piExecution &&
    !isCloudModelMappingValid(
      type,
      logicalModel,
      upstream,
      catalogHasProviderRoute(catalog, logicalModel, type),
      catalog.byModel,
    )
  ) {
    throw new PiNativeConfigurationError(
      "Cloud provider requires its explicitly configured deployment or profile",
    );
  }
  return upstream;
}

function capturesPiProviderSecret(
  catalog: ModelCatalog,
  model: string,
  piExecution: boolean | undefined,
): boolean {
  const routeClass = piCatalogModel(catalog, model)?.piRouteClass;
  return (
    piExecution === true &&
    (routeClass === "claude-native" || routeClass === "deepseek")
  );
}

/**
 * Firewall-resolved credentials: each stored secret's runtime reference. A
 * missing or empty stored value yields no reference, so the usability check
 * rejects the source as unavailable (fail-closed, as on main).
 */
function deferredCredentialReferences(
  source: ModelSourceSnapshot,
): ModelCredentialValues {
  const values: Record<string, string> = {};
  for (const credential of source.credentials) {
    if (credential.kind === "encrypted" && credential.encryptedValue) {
      values[credential.name] = `\${{ secrets.${credential.name} }}`;
    }
  }
  return values;
}

/**
 * A ChatGPT account's credentials stay server-side, as on main: firewall auth
 * resolves its stored token rows by name, so only rows of its own auth method
 * become references. A non-Pi run decrypts just CHATGPT_ACCOUNT_ID, which
 * workspace routing compares with the account check; it is not a credential.
 */
async function codexAccountCredentials(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  piExecution: boolean | undefined,
  signal: AbortSignal,
): Promise<ModelCredentialValues | null> {
  const method =
    source.configuration.kind === "registered-provider"
      ? source.configuration.authMethod
      : null;
  const rules = method
    ? getSecretsForAuthMethod("codex-oauth-token", method)
    : undefined;
  if (!rules) {
    return null;
  }
  const own = {
    ...source,
    credentials: source.credentials.filter((credential) => {
      return credential.name in rules;
    }),
  };
  const references = deferredCredentialReferences(own);
  if (piExecution) {
    return references;
  }
  const account = await resolveModelCredentialValues(
    db,
    {
      ...own,
      credentials: own.credentials.filter((credential) => {
        return credential.name === "CHATGPT_ACCOUNT_ID";
      }),
    },
    signal,
  );
  return account?.CHATGPT_ACCOUNT_ID
    ? { ...references, CHATGPT_ACCOUNT_ID: account.CHATGPT_ACCOUNT_ID }
    : null;
}

async function resolveModelCredentialValues(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  signal: AbortSignal,
): Promise<ModelCredentialValues | null> {
  const values: Record<string, string> = {};
  for (const credential of source.credentials) {
    if (credential.kind === "encrypted") {
      values[credential.name] = await decryptStoredSecretValue(
        credential.encryptedValue,
      );
    } else {
      if (
        source.identity.kind !== "built-in" ||
        credential.modelKeyId !== source.identity.modelKeyId ||
        source.configuration.kind !== "registered-provider"
      ) {
        throw new Error("Managed key identity mismatch");
      }
      const [key] = await db
        .select({
          vendor: builtInModelKeys.vendor,
          apiKey: builtInModelKeys.apiKey,
        })
        .from(builtInModelKeys)
        .where(eq(builtInModelKeys.id, credential.modelKeyId))
        .limit(1);
      signal.throwIfAborted();
      if (!key?.apiKey) {
        return null;
      }
      if (key.vendor !== source.configuration.managedVendor) {
        throw new Error("Managed key vendor changed");
      }
      values[credential.name] = key.apiKey;
    }
    signal.throwIfAborted();
  }
  return values;
}

/** Exact registered/account source → effect-resolved credentials → runtime. */
export async function prepareRegisteredModelEnvironment(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  selectedModel: string,
  options: {
    readonly catalog: ModelCatalog;
    readonly userId: string;
    readonly sourceId: string;
    readonly piExecution: boolean | undefined;
  },
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null> {
  const { catalog, userId, sourceId, piExecution } = options;
  const type = modelProviderTypeSchema.parse(source.configuration.providerType);
  const deferred = getModelProviderFirewall(type) !== undefined;
  const capture = capturesPiProviderSecret(catalog, selectedModel, piExecution);
  // As on main, a firewall-injected single-secret credential that Pi does not
  // capture stays encrypted: the runtime only sees its secret reference.
  const credentials =
    deferred && type === "codex-oauth-token"
      ? await codexAccountCredentials(db, source, piExecution, signal)
      : deferred &&
          !capture &&
          !hasAuthMethods(type) &&
          source.credentials.every((credential) => {
            return credential.kind === "encrypted";
          })
        ? deferredCredentialReferences(source)
        : await resolveModelCredentialValues(db, source, signal);
  if (!credentials) {
    return null;
  }
  if (!modelCredentialsAreUsable(source, type, credentials)) {
    return null;
  }
  const upstreamModel = selectedSourceUpstream(
    catalog,
    source,
    type,
    selectedModel,
    piExecution,
  );
  if (!upstreamModel) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: { kind: "configured", selectedModel, upstreamModel },
    credentials,
  });
  const names = Object.keys(compiled.secrets);
  const sourceUserId =
    source.credentialOwner === "organization" ? ORG_SENTINEL_USER_ID : userId;
  const environment = { ...compiled.environment };
  // Pi owns account routing through its explicit source binding rather
  // than the native Codex CLI-only routing environment variable.
  if (piExecution && type === "codex-oauth-token") {
    delete environment.CODEX_OAUTH_ACCOUNT_ID;
  }
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type,
    logicalModel: compiled.selectedModel,
    runtimeModel: compiled.upstreamModel,
    environment,
  });
  return {
    id: sourceId,
    type,
    credentialOwner: compiled.credentialOwner,
    environment,
    secrets: deferred && !capture ? {} : { ...compiled.secrets },
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    ...(source.configuration.kind === "registered-provider" &&
    source.configuration.authMethod
      ? { authMethod: source.configuration.authMethod }
      : {}),
    ...(deferred
      ? {
          secretConnectorMap: Object.fromEntries(
            names.map((name) => {
              return [name, type];
            }),
          ),
          secretConnectorMetadataMap: Object.fromEntries(
            names.map((name) => {
              return [
                name,
                {
                  sourceType: "model-provider" as const,
                  sourceUserId,
                  ...(source.identity.kind === "member"
                    ? { sourceId: source.identity.accountId }
                    : {}),
                  metadataKey: type,
                },
              ];
            }),
          ),
        }
      : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
  };
}

/** Exact managed-key source → explicit key resolution → managed runtime. */
export async function prepareManagedModelEnvironment(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  args: Pick<
    ResolveModelProviderEnvironmentArgs,
    | "builtInModelRuntimeRoute"
    | "selectedModelOverride"
    | "catalog"
    | "framework"
    | "featureSwitchContext"
  >,
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (source.identity.kind !== "built-in") {
    throw new Error("Managed preparation requires a managed source");
  }
  const route = args.builtInModelRuntimeRoute;
  if (
    !route ||
    route.selectedModel !== args.selectedModelOverride ||
    !isBuiltInModelRuntimeRoutePermitted(args.catalog, route) ||
    getFrameworkForType(route.providerType) !== args.framework ||
    route.modelKeyId !== source.identity.modelKeyId
  ) {
    return null;
  }
  const credentials = await resolveModelCredentialValues(db, source, signal);
  if (!credentials) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: {
      kind: "built-in",
      selectedModel: route.selectedModel,
      providerType: route.providerType,
      upstreamModel: route.upstreamModel,
      modelKeyId: route.modelKeyId,
    },
    credentials,
  });
  const secretName = getSecretNameForType(route.providerType);
  if (!secretName || !credentials[secretName]) {
    return null;
  }
  // Preserve private US-routing/firewall/Codex protocol without a query.
  const protocol = builtInModelProviderEnvironmentFromSnapshot({
    route,
    selectedModel: route.selectedModel,
    featureSwitchContext: args.featureSwitchContext,
    apiKey: credentials[secretName],
  });
  if (!protocol) {
    return null;
  }
  const environment = { ...compiled.environment };
  if (route.providerType === "openrouter-api-key") {
    const endpoint = protocol.environment.ANTHROPIC_BASE_URL;
    if (!endpoint) {
      throw new Error("Managed messages endpoint is missing");
    }
    environment.ANTHROPIC_BASE_URL = endpoint;
  }
  if (route.providerType === "openrouter-codex") {
    const endpoint = protocol.environment.OPENAI_BASE_URL;
    if (!endpoint) {
      throw new Error("Managed responses endpoint is missing");
    }
    environment.OPENAI_BASE_URL = endpoint;
  }
  return {
    ...protocol,
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    environment,
    secrets: { ...compiled.secrets },
  };
}

/** Exact selected gateway surface → effect-resolved key → gateway runtime. */
export async function prepareGatewayModelEnvironment(
  db: ReadonlyDb,
  source: ModelSourceSnapshot,
  selection: {
    readonly selectedModel: string | undefined;
    readonly framework: string;
    readonly modelProviderType: string | undefined;
  },
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null> {
  const config = source.configuration;
  if (source.identity.kind !== "gateway" || config.kind !== "gateway") {
    throw new Error("Selected gateway has an invalid source kind");
  }
  const { selectedModel } = selection;
  const type = providerTypeForSurfaceProtocol(config.protocol);
  if (!type) {
    throw new Error("Gateway protocol has no provider type");
  }
  if (
    !selectedModel ||
    !config.modelMappings[selectedModel] ||
    getFrameworkForType(type) !== selection.framework ||
    (selection.modelProviderType !== undefined &&
      selection.modelProviderType !== type)
  ) {
    return null;
  }
  const credentials = await resolveModelCredentialValues(db, source, signal);
  // A blank stored gateway key is an unavailable source, as on main.
  if (!credentials?.[GATEWAY_RUNTIME_SECRET_NAME]?.trim()) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: {
      kind: "configured",
      selectedModel,
      upstreamModel: config.modelMappings[selectedModel],
    },
    credentials,
  });
  // Supplementary Runner firewall/Codex protocol is pure assembly from the
  // same complete snapshot, not another query.
  const protocol = compileModelProviderGatewayRuntime({
    surfaceId: source.identity.surfaceId,
    protocol: config.protocol,
    apiBaseUrl: config.apiBaseUrl,
    displayName: config.displayName,
    authHeaderName: config.authHeaderName,
    authHeaderTemplate: config.authHeaderTemplate,
    logicalModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
  });
  return {
    id: source.identity.surfaceId,
    type,
    credentialOwner: compiled.credentialOwner,
    environment: { ...compiled.environment },
    secrets: { ...compiled.secrets },
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    firewall: protocol.firewall,
    inlineFirewall: true,
    credentialHeader: {
      name: config.authHeaderName,
      valueTemplate: config.authHeaderTemplate,
    },
    ...(protocol.codexRuntimeConfig
      ? { codexRuntimeConfig: protocol.codexRuntimeConfig }
      : {}),
  };
}
