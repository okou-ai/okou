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

/** Pure selected-route conversion. It neither reads nor decrypts a source. */
export function compileModelRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  const config = source.configuration;
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
