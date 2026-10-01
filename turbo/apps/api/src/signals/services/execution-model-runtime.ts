import {
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
  getModelProviderEnvBindings,
  getModelProviderFirewall,
  getProviderRuntimeModel,
  BUILT_IN_MODEL_ROUTE_PROVIDERS,
  getSecretNameForType,
  getSecretsForAuthMethod,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
import {
  compileModelProviderGatewayRuntime,
  GATEWAY_RUNTIME_SECRET_NAME,
} from "./model-provider-gateway-runtime";

export type ModelCredentialValues = Readonly<Record<string, string>>;
export type ModelRuntimeSelection =
  | {
      readonly kind: "built-in";
      readonly selectedModel: string;
      readonly providerType: string;
      readonly upstreamModel: string;
      readonly modelKeyId: string;
    }
  | { readonly kind: "configured"; readonly selectedModel: string };
export interface ModelRuntimeInput {
  readonly selection: ModelRuntimeSelection;
  readonly source: ModelSourceSnapshot;
  readonly credentials: ModelCredentialValues;
}
export type ModelTransport =
  | {
      readonly kind: "http";
      readonly protocol: "anthropic-messages" | "openai-responses";
      readonly baseUrl: string;
    }
  | { readonly kind: "bedrock"; readonly region: string };
export interface HeaderModelAuthentication {
  readonly kind: "header";
  readonly headerName: string;
  readonly valueTemplate: string;
  readonly secretName: string;
}
export interface AwsBearerModelAuthentication {
  readonly kind: "aws-bearer";
  readonly secretName: string;
}
export interface AwsSigV4ModelAuthentication {
  readonly kind: "aws-sigv4";
  readonly accessKeyIdSecretName: string;
  readonly secretAccessKeySecretName: string;
  readonly sessionTokenSecretName: string | null;
}
export type ModelAuthentication =
  | HeaderModelAuthentication
  | AwsBearerModelAuthentication
  | AwsSigV4ModelAuthentication;
export interface CompiledModelRuntime {
  readonly selectedModel: string;
  readonly upstreamModel: string;
  readonly providerType: string;
  readonly credentialOwner: "builtin" | "organization" | "member";
  readonly transport: ModelTransport;
  readonly authentication: ModelAuthentication;
  readonly environment: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

function compileAccountRuntime(input: ModelRuntimeInput): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  if (
    selection.kind !== "configured" ||
    source.configuration.kind !== "registered-provider" ||
    source.configuration.providerType !== "codex-oauth-token"
  ) {
    throw new Error("Account runtime requires its selected Codex source");
  }
  const authMethod = source.configuration.authMethod;
  const required = authMethod
    ? getSecretsForAuthMethod("codex-oauth-token", authMethod)
    : undefined;
  if (!required) {
    throw new Error("Codex account authentication method is unavailable");
  }
  const forwardable: Record<string, string> = {};
  for (const [name, rule] of Object.entries(required)) {
    const value = credentials[name];
    if (!value) {
      if (rule.required) {
        throw new Error(`Account credential ${name} is missing`);
      }
      continue;
    }
    if (!rule.serverOnly) {
      forwardable[name] = value;
    }
  }
  const upstreamModel = getProviderRuntimeModel(
    "codex-oauth-token",
    selection.selectedModel,
  );
  const bindings = getModelProviderEnvBindings("codex-oauth-token");
  if (!bindings) {
    throw new Error("Codex account runtime bindings are unavailable");
  }
  const environment = Object.fromEntries(
    Object.entries(bindings).flatMap(([name, value]) => {
      if (value === "$model") {
        return [[name, upstreamModel]];
      }
      if (value.startsWith("$secrets.")) {
        const secretName = value.slice("$secrets.".length);
        return forwardable[secretName]
          ? [[name, `\${{ secrets.${secretName} }}`]]
          : [];
      }
      return [[name, value]];
    }),
  );
  // This identifier is routing evidence, not a bearer/refresh credential.
  const accountId = credentials.CHATGPT_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("Codex account routing identity is missing");
  }
  environment.CODEX_OAUTH_ACCOUNT_ID = accountId;
  return {
    selectedModel: selection.selectedModel,
    upstreamModel,
    providerType: "codex-oauth-token",
    credentialOwner: source.credentialOwner,
    transport: {
      kind: "http",
      protocol: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
    authentication: {
      kind: "header",
      headerName: "Authorization",
      valueTemplate: "Bearer {{secret}}",
      secretName: "CHATGPT_ACCESS_TOKEN",
    },
    environment,
    secrets: forwardable,
  };
}

function compileRegisteredRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  if (
    selection.kind !== "configured" ||
    source.configuration.kind !== "registered-provider"
  ) {
    throw new Error("Registered source requires configured selection");
  }
  const type = modelProviderTypeSchema.parse(source.configuration.providerType);
  const config = MODEL_PROVIDER_TYPES[type];
  if (
    !("secretName" in config) ||
    !("envBindings" in config) ||
    type === "deepseek" ||
    type === "claude-code-oauth-token"
  ) {
    throw new Error(
      "This registered protocol has not migrated to the pure runtime contract",
    );
  }
  const secretName = config.secretName;
  const key = credentials[secretName];
  if (!key?.trim()) {
    throw new Error(`Model credential ${secretName} is missing`);
  }
  const upstreamModel = getProviderRuntimeModel(type, selection.selectedModel);
  const reference = getModelProviderFirewall(type)
    ? `\${{ secrets.${secretName} }}`
    : key;
  const bindings = getModelProviderEnvBindings(type) ?? config.envBindings;
  const environment = Object.fromEntries(
    Object.entries(bindings).map(([name, value]) => {
      return [
        name,
        value
          .replaceAll("$secret", reference)
          .replaceAll("$model", upstreamModel),
      ];
    }),
  );
  const protocol =
    config.framework === "claude-code"
      ? "anthropic-messages"
      : "openai-responses";
  const baseUrl =
    environment.ANTHROPIC_BASE_URL ??
    environment.OPENAI_BASE_URL ??
    (protocol === "anthropic-messages"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1");
  return {
    selectedModel: selection.selectedModel,
    upstreamModel,
    providerType: type,
    credentialOwner: source.credentialOwner,
    transport: { kind: "http", protocol, baseUrl },
    authentication: {
      kind: "header",
      headerName: type === "anthropic-api-key" ? "x-api-key" : "Authorization",
      valueTemplate:
        type === "anthropic-api-key" ? "{{secret}}" : "Bearer {{secret}}",
      secretName,
    },
    environment,
    secrets: { [secretName]: key },
  };
}

function compileManagedRuntime(input: ModelRuntimeInput): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  if (
    selection.kind !== "built-in" ||
    source.identity.kind !== "built-in" ||
    source.identity.modelKeyId !== selection.modelKeyId ||
    source.credentialOwner !== "builtin" ||
    source.configuration.kind !== "registered-provider"
  ) {
    throw new Error("Managed model source and route identity mismatch");
  }
  const managedVendor = source.configuration.managedVendor;
  const type = modelProviderTypeSchema.parse(selection.providerType);
  const permitted = Object.entries(BUILT_IN_MODEL_ROUTE_PROVIDERS).some(
    ([provider, facts]) => {
      return provider === type && facts.vendor === managedVendor;
    },
  );
  if (!permitted) {
    throw new Error(
      "Managed model vendor does not match its selected provider",
    );
  }
  const secretName = getSecretNameForType(type);
  if (
    !secretName ||
    !source.credentials.some((credential) => {
      return (
        credential.kind === "managed-key" &&
        credential.modelKeyId === selection.modelKeyId &&
        credential.name === secretName
      );
    })
  ) {
    throw new Error(
      "Managed model credential reference does not match its selected route",
    );
  }
  const key = credentials[secretName];
  if (!key?.trim()) {
    throw new Error("Managed model credential is missing");
  }
  const reference = getModelProviderFirewall(type)
    ? `\${{ secrets.${secretName} }}`
    : key;
  const bindings = getModelProviderEnvBindings(type);
  const environment = bindings
    ? Object.fromEntries(
        Object.entries(bindings).flatMap(([name, value]) => {
          if (value === "$secret") {
            return [[name, reference]];
          }
          if (value === "$model") {
            return [[name, selection.upstreamModel]];
          }
          if (value.startsWith("$secrets.")) {
            return value.slice("$secrets.".length) === secretName
              ? [[name, reference]]
              : [];
          }
          return [[name, value]];
        }),
      )
    : { [secretName]: reference };
  const protocol =
    MODEL_PROVIDER_TYPES[type].framework === "claude-code"
      ? "anthropic-messages"
      : "openai-responses";
  const baseUrl =
    environment.ANTHROPIC_BASE_URL ??
    environment.OPENAI_BASE_URL ??
    (protocol === "anthropic-messages"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1");
  return {
    selectedModel: selection.selectedModel,
    upstreamModel: selection.upstreamModel,
    providerType: type,
    credentialOwner: "builtin",
    transport: { kind: "http", protocol, baseUrl },
    authentication: {
      kind: "header",
      headerName: type === "anthropic-api-key" ? "x-api-key" : "Authorization",
      valueTemplate:
        type === "anthropic-api-key" ? "{{secret}}" : "Bearer {{secret}}",
      secretName,
    },
    environment,
    secrets: { [secretName]: key },
  };
}

/** Pure selected-route conversion. It neither reads nor decrypts a source. */
export function compileModelRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  const config = source.configuration;
  if (selection.kind === "built-in") {
    return compileManagedRuntime(input);
  }
  if (config.kind === "registered-provider") {
    return config.providerType === "codex-oauth-token"
      ? compileAccountRuntime(input)
      : compileRegisteredRuntime(input);
  }
  if (
    selection.kind !== "configured" ||
    source.identity.kind !== "gateway" ||
    config.kind !== "gateway"
  ) {
    throw new Error(
      "This source has not migrated to the pure model runtime contract",
    );
  }
  const upstreamModel = config.modelMappings[selection.selectedModel];
  if (!upstreamModel) {
    throw new Error("Selected model has no gateway mapping");
  }
  const apiKey = credentials[GATEWAY_RUNTIME_SECRET_NAME];
  if (!apiKey?.trim()) {
    throw new Error("Gateway credential is missing");
  }
  const runtime = compileModelProviderGatewayRuntime({
    surfaceId: source.identity.surfaceId,
    protocol: config.protocol,
    apiBaseUrl: config.apiBaseUrl,
    displayName: config.displayName,
    authHeaderName: config.authHeaderName,
    authHeaderTemplate: config.authHeaderTemplate,
    logicalModel: selection.selectedModel,
    upstreamModel,
  });
  if (runtime.type !== config.providerType) {
    throw new Error("Gateway provider identity mismatch");
  }
  return {
    selectedModel: selection.selectedModel,
    upstreamModel,
    providerType: runtime.type,
    credentialOwner: source.credentialOwner,
    transport: {
      kind: "http",
      protocol: config.protocol,
      baseUrl: config.apiBaseUrl,
    },
    authentication: {
      kind: "header",
      headerName: config.authHeaderName,
      valueTemplate: config.authHeaderTemplate,
      secretName: GATEWAY_RUNTIME_SECRET_NAME,
    },
    environment: runtime.environment,
    secrets: { [GATEWAY_RUNTIME_SECRET_NAME]: apiKey },
  };
}
