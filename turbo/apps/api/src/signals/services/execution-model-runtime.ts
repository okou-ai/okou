import {
  BUILT_IN_MODEL_ROUTE_PROVIDERS,
  getModelProviderEnvBindings,
  getModelProviderFirewall,
  getSecretNameForType,
  getSecretsForAuthMethod,
  hasAuthMethods,
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
export type ModelCredentialValues = Readonly<Record<string, string>>;
export type ModelRuntimeSelection =
  | {
      readonly kind: "built-in";
      readonly selectedModel: string;
      readonly providerType: string;
      readonly upstreamModel: string;
      readonly modelKeyId: string;
    }
  | {
      readonly kind: "configured";
      readonly selectedModel: string;
      readonly upstreamModel: string;
    };
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
  readonly credentialOwner: "builtin" | "member";
  readonly transport: ModelTransport;
  readonly authentication: ModelAuthentication;
  readonly environment: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

function compileMultiAuthRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  if (
    selection.kind !== "configured" ||
    source.configuration.kind !== "registered-provider"
  ) {
    throw new Error("Multi-auth runtime requires a selected registered source");
  }
  const type = modelProviderTypeSchema.parse(source.configuration.providerType);
  if (!hasAuthMethods(type)) {
    throw new Error("Selected provider is not multi-auth");
  }
  const authMethod = source.configuration.authMethod;
  const required = authMethod
    ? getSecretsForAuthMethod(type, authMethod)
    : undefined;
  if (!required) {
    throw new Error("Multi-auth authentication method is unavailable");
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
  const upstreamModel = selection.upstreamModel;
  const bindings = getModelProviderEnvBindings(type);
  if (!bindings) {
    throw new Error("Multi-auth runtime bindings are unavailable");
  }
  const environment = Object.fromEntries(
    Object.entries(bindings).flatMap(([name, value]) => {
      if (value === "$model") {
        return [[name, upstreamModel]];
      }
      if (value.startsWith("$secrets.")) {
        const secretName = value.slice("$secrets.".length);
        return forwardable[secretName]
          ? [
              [
                name,
                getModelProviderFirewall(type)
                  ? `\${{ secrets.${secretName} }}`
                  : forwardable[secretName],
              ],
            ]
          : [];
      }
      return [[name, value]];
    }),
  );
  let transport: ModelTransport;
  let authentication: ModelAuthentication;
  if (type === "codex-oauth-token") {
    const accountId = credentials.CHATGPT_ACCOUNT_ID;
    if (!accountId) {
      throw new Error("Codex account routing identity is missing");
    }
    environment.CODEX_OAUTH_ACCOUNT_ID = accountId;
    transport = {
      kind: "http",
      protocol: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    authentication = {
      kind: "header",
      headerName: "Authorization",
      valueTemplate: "Bearer {{secret}}",
      secretName: "CHATGPT_ACCESS_TOKEN",
    };
  } else {
    throw new Error("Unsupported multi-auth runtime protocol");
  }
  return {
    selectedModel: selection.selectedModel,
    upstreamModel,
    providerType: type,
    credentialOwner: source.credentialOwner,
    transport,
    authentication,
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
  if (!("secretName" in config) || !("envBindings" in config)) {
    throw new Error(
      "This registered protocol has not migrated to the pure runtime contract",
    );
  }
  const secretName = config.secretName;
  const key = credentials[secretName];
  if (!key?.trim()) {
    throw new Error(`Model credential ${secretName} is missing`);
  }
  const upstreamModel = selection.upstreamModel;
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
  const { source, selection } = input;
  if (!selection.selectedModel || !selection.upstreamModel) {
    throw new Error(
      "Model runtime requires its selected logical and upstream facts",
    );
  }
  const config = source.configuration;
  if (selection.kind === "built-in") {
    return compileManagedRuntime(input);
  }
  if (
    source.identity.kind !== "member" ||
    source.credentialOwner !== "member" ||
    (config.providerType !== "codex-oauth-token" &&
      config.providerType !== "claude-code-oauth-token")
  ) {
    throw new Error(
      "Configured runtime requires a personal subscription account",
    );
  }
  return hasAuthMethods(modelProviderTypeSchema.parse(config.providerType))
    ? compileMultiAuthRuntime(input)
    : compileRegisteredRuntime(input);
}
