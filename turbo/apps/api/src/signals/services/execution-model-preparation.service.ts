/**
 * Effect-owned model source preparation shared by execution owners: resolve
 * an exact source's credentials (decrypt or explicit managed key), compile the
 * pure runtime and project it into the Runner model-provider environment.
 * Lifted from Thread's private commands so the Pi maintenance entrypoint can
 * reuse the same boundary; owners keep their own commands and selection.
 */
import { compileModelProviderGatewayRuntime } from "./model-provider-gateway-runtime";
import { providerTypeForSurfaceProtocol } from "./effective-model-route.service";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import { resolveModelProviderCodexRuntimeConfig } from "./model-provider-codex-runtime";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
import {
  compileModelRuntime,
  type ModelCredentialValues,
} from "./execution-model-runtime";
import { decryptStoredSecretValue } from "./crypto.utils";
import {
  builtInModelProviderEnvironmentFromSnapshot,
  type ResolveModelProviderEnvironmentArgs,
} from "./run-model-provider-environment.service";
import type { ResolvedModelProviderEnvironment } from "./execution-launch-persistence.service";
import type { ReadonlyDb } from "../external/db";
import { isBuiltInModelRuntimeRoutePermitted } from "./built-in-model-runtime-route.service";
import {
  catalogProviderUpstreamModel,
  catalogHasProviderRoute,
  type ModelCatalog,
} from "./model-catalog.service";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import { piCatalogModel } from "@okouai/core/pi-execution";
import {
  getFrameworkForType,
  getSecretNameForType,
  getSecretsForAuthMethod,
  getModelProviderFirewall,
  hasAuthMethods,
  type ModelProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { eq } from "drizzle-orm";

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

export async function resolveModelCredentialValues(
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
    deferred &&
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
  if (!credentials) {
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
