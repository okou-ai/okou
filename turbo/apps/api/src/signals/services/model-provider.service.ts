import {
  getFrameworkForType,
  getModelProviderCodexCatalogForModel,
  getModelProviderCodexRuntimeCapabilities,
  getModelProviderFirewall,
  getSecretNameForType,
  getSecretsForAuthMethod,
  hasAuthMethods,
  MODEL_PROVIDER_TYPES,
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderType,
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
  const type = source.configuration.providerType;
  if (
    source.identity.kind !== "member" ||
    source.credentialOwner !== "member" ||
    !isPersonalSubscriptionProviderType(type)
  ) {
    return null;
  }
  const accountId = source.identity.accountId;
  // Subscription credentials are firewall-injected and stay encrypted: the
  // runtime only sees their secret references.
  const credentials =
    type === "codex-oauth-token"
      ? await codexAccountCredentials(source, piExecution)
      : deferredCredentialReferences(source);
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
    secrets: {},
    selectedModel: compiled.selectedModel,
    upstreamModel: compiled.upstreamModel,
    ...(source.configuration.kind === "registered-provider" &&
    source.configuration.authMethod
      ? { authMethod: source.configuration.authMethod }
      : {}),
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
            sourceId: accountId,
            metadataKey: type,
          },
        ];
      }),
    ),
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
  // Preserve private US routing for the managed OpenRouter endpoint.
  const routing = {
    credentialOwner: "builtin" as const,
    model: route.upstreamModel,
  };
  const firewall = getModelProviderFirewall(route.providerType, routing);
  const usesUsEndpoint = firewall?.apis.some((api) => {
    return api.base.startsWith(`${OPENROUTER_US_ORIGIN}/`);
  });
  const environment = {
    ...compiled.environment,
    OPENAI_BASE_URL: getOpenRouterBaseUrl("responses", routing),
  };
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type: route.providerType,
    logicalModel: route.selectedModel,
    runtimeModel: route.upstreamModel,
    environment,
  });
  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    environment,
    secrets: { ...compiled.secrets },
    selectedModel: compiled.selectedModel,
    builtInModelRuntimeRoute: route,
    upstreamModel: compiled.upstreamModel,
    ...(usesUsEndpoint ? { firewall } : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
  };
}

function resolveModelProviderCodexRuntimeConfig(args: {
  readonly type: ModelProviderType;
  readonly logicalModel: string | null;
  readonly runtimeModel: string;
  readonly environment: Readonly<Record<string, string>>;
}): ModelProviderCodexRuntimeConfig | undefined {
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
