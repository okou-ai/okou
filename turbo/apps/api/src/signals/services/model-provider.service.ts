import {
  getDefaultModel,
  getFrameworkForType,
  getModelProviderCodexCatalogForModel,
  getModelProviderCodexRuntimeCapabilities,
  getModelProviderCodexRuntimeConfig,
  getModelProviderEnvBindings,
  getModelProviderFirewall,
  getSecretNameForType,
  getSecretsForAuthMethod,
  hasAuthMethods,
  MODEL_PROVIDER_TYPES,
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderEnvBindings,
  type ModelProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { command } from "ccstate";
import { notFound } from "../../lib/error";
import { decryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

import {
  type BuiltInModelRuntimeRoute,
  isBuiltInModelRuntimeRoutePermitted,
} from "./built-in-model-runtime-route.service";
import {
  disconnectPersonalModelProviderAccounts$,
  isPersonalSubscriptionProviderType,
} from "./model-provider-account.service";

import {
  getOpenRouterBaseUrl,
  OPENROUTER_US_ORIGIN,
} from "@okouai/api-contracts/contracts/openrouter-routing";
import type { SupportedFramework } from "@okouai/core/frameworks";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import {
  compileModelRuntime,
  type ModelCredentialValues,
} from "./execution-model-runtime";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
import {
  catalogProviderUpstreamModel,
  type ModelCatalog,
} from "./model-catalog.service";
export const deleteUserModelProvider$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderType;
    },
    signal: AbortSignal,
  ) => {
    if (!isPersonalSubscriptionProviderType(args.type)) {
      return notFound("Resource not found");
    }
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    return await set(
      disconnectPersonalModelProviderAccounts$,
      {
        ...args,
        selection: { kind: "provider", type: args.type },
        featureSwitchContext,
      },
      signal,
    );
  },
);

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

function builtInModelProviderEnvironmentFromSnapshot(args: {
  readonly route: BuiltInModelRuntimeRoute;
  readonly selectedModel: string;
  readonly apiKey: string;
}): ResolvedModelProviderEnvironment | null {
  const { route, selectedModel } = args;
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
  const routing = { model: route.upstreamModel };
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

/**
 * Firewall-resolved credentials: each stored secret's runtime reference. A
 * missing secret row yields no reference, so the usability check rejects the
 * source as unavailable (fail-closed, as on main).
 */
function deferredCredentialReferences(
  source: ModelSourceSnapshot,
): ModelCredentialValues {
  const values: Record<string, string> = {};
  for (const credential of source.credentials) {
    if (credential.kind === "encrypted") {
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
  source: ModelSourceSnapshot,
  piExecution: boolean | undefined,
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
  const account = await resolveModelCredentialValues({
    ...own,
    credentials: own.credentials.filter((credential) => {
      return credential.name === "CHATGPT_ACCOUNT_ID";
    }),
  });
  return account?.CHATGPT_ACCOUNT_ID
    ? { ...references, CHATGPT_ACCOUNT_ID: account.CHATGPT_ACCOUNT_ID }
    : null;
}

async function resolveModelCredentialValues(
  source: ModelSourceSnapshot,
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
      if (!credential.apiKey) {
        return null;
      }
      values[credential.name] = credential.apiKey;
    }
  }
  return values;
}

/** Exact registered/account source → resolved credentials → runtime. */
export async function prepareRegisteredModelEnvironment(
  source: ModelSourceSnapshot,
  selectedModel: string,
  options: {
    readonly catalog: ModelCatalog;
    readonly userId: string;
    readonly sourceId: string;
    readonly piExecution: boolean | undefined;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  const { catalog, userId, sourceId, piExecution } = options;
  const type = modelProviderTypeSchema.parse(source.configuration.providerType);
  const deferred = getModelProviderFirewall(type) !== undefined;
  if (
    source.identity.kind !== "member" ||
    source.credentialOwner !== "member" ||
    !isPersonalSubscriptionProviderType(type)
  ) {
    return null;
  }
  // As on main, a firewall-injected single-secret credential that Pi does not
  // capture stays encrypted: the runtime only sees its secret reference.
  const credentials =
    deferred && type === "codex-oauth-token"
      ? await codexAccountCredentials(source, piExecution)
      : deferred &&
          !hasAuthMethods(type) &&
          source.credentials.every((credential) => {
            return credential.kind === "encrypted";
          })
        ? deferredCredentialReferences(source)
        : await resolveModelCredentialValues(source);
  if (!credentials) {
    return null;
  }
  if (!modelCredentialsAreUsable(source, type, credentials)) {
    return null;
  }
  const upstreamModel = catalogProviderUpstreamModel(
    catalog,
    selectedModel,
    type,
    type,
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
  const sourceUserId = userId;
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
    secrets: deferred ? {} : { ...compiled.secrets },
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

/** The run facts a Built-in model environment is prepared from. */
interface ManagedModelEnvironmentRequest {
  readonly catalog: ModelCatalog;
  readonly framework: SupportedFramework;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
}

/** Exact managed-key source → explicit key resolution → managed runtime. */
export async function prepareManagedModelEnvironment(
  source: ModelSourceSnapshot,
  args: ManagedModelEnvironmentRequest,
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
  const credentials = await resolveModelCredentialValues(source);
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

function resolveModelProviderCodexRuntimeConfig(args: {
  readonly type: ModelProviderType;
  readonly logicalModel: string | null;
  readonly runtimeModel: string;
  readonly environment: Readonly<Record<string, string>>;
}): ModelProviderCodexRuntimeConfig | undefined {
  const providerConfig = getModelProviderCodexRuntimeConfig(args.type);
  if (providerConfig) {
    return providerConfig;
  }
  const providerCapabilities = getModelProviderCodexRuntimeCapabilities(
    args.type,
  );
  if (!providerCapabilities) {
    return undefined;
  }
  const modelCatalog = args.logicalModel
    ? getModelProviderCodexCatalogForModel(
        args.logicalModel,
        args.runtimeModel,
        args.type,
      )
    : undefined;
  const baseUrl = args.environment.OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error(`Missing OPENAI_BASE_URL for Codex provider ${args.type}`);
  }
  return {
    providerId: args.type,
    name: MODEL_PROVIDER_TYPES[args.type].label,
    baseUrl,
    envKey: "OPENAI_API_KEY",
    requiresOpenaiAuth: false,
    wireApi: "responses",
    supportsWebsockets: providerCapabilities.supportsWebsockets,
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}
