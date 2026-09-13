import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import { isPiNativeRoute } from "@okouai/core/pi-execution";
import {
  getProviderRuntimeModel,
  isBuiltInModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  piModelConfigV4Schema,
  type PiModelConfigV4,
} from "@okouai/api-contracts/contracts/pi-native";

/** A selected external route or credential cannot satisfy the native contract. */
export class PiNativeConfigurationError extends Error {}

function parseNativeConfig(value: unknown): PiModelConfigV4 {
  const parsed = piModelConfigV4Schema.safeParse(value);
  if (!parsed.success) {
    throw new PiNativeConfigurationError(
      "Selected native route configuration is invalid",
    );
  }
  return parsed.data;
}

export interface PiNativeModelProviderInput {
  readonly type: string;
  readonly concreteType?: string;
  readonly selectedModel: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly credentialOwner?: PiModelConfigV4["credentialOwner"];
  readonly authMethod?: string | null;
  readonly credentialHeader?: {
    readonly name: string;
    readonly valueTemplate: string;
  };
}

function nativeConfigIdentity(provider: PiNativeModelProviderInput) {
  const catalogModel = piNativeCatalogModelSchema.parse(provider.selectedModel);
  if (
    !isPiNativeRoute(provider.type, catalogModel) ||
    !provider.credentialOwner
  ) {
    throw new PiNativeConfigurationError(
      "Selected native Pi route or credential owner is invalid",
    );
  }
  const environment = provider.environment;
  return {
    schemaVersion: 4,
    catalogModel,
    model: environment.ANTHROPIC_MODEL,
    credentialOwner: provider.credentialOwner,
    billingOwner: isBuiltInModelProviderType(provider.type)
      ? "builtin"
      : "user",
    thinkingLevel: "max",
    requestPolicy: { maxAttempts: 1, cacheRetention: "short" },
  } as const;
}

function resolveNativeBedrockConfig(
  provider: PiNativeModelProviderInput,
  common: ReturnType<typeof nativeConfigIdentity>,
): PiModelConfigV4 {
  const environment = provider.environment;
  const route = "aws-bedrock";
  const region = environment.AWS_REGION;
  if (
    provider.authMethod !== "api-key" &&
    provider.authMethod !== "access-keys"
  ) {
    throw new PiNativeConfigurationError(
      "Native Bedrock requires an existing explicit auth mode",
    );
  }
  return parseNativeConfig({
    ...common,
    route,
    dialect: "bedrock-converse-stream",
    transport: "aws-event-stream",
    provider: "amazon-bedrock",
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    region,
    authMode: provider.authMethod === "api-key" ? "bearer" : "sigv4",
    credentialBindings:
      provider.authMethod === "api-key"
        ? [
            {
              kind: "aws-bearer-token",
              environment: "OKOU_PI_BEDROCK_BEARER_TOKEN",
              secretName: "AWS_BEARER_TOKEN_BEDROCK",
            },
          ]
        : [
            {
              kind: "aws-access-key-id",
              environment: "OKOU_PI_AWS_ACCESS_KEY_ID",
              secretName: "AWS_ACCESS_KEY_ID",
            },
            {
              kind: "aws-secret-access-key",
              environment: "OKOU_PI_AWS_SECRET_ACCESS_KEY",
              secretName: "AWS_SECRET_ACCESS_KEY",
            },
            ...(environment.AWS_SESSION_TOKEN
              ? [
                  {
                    kind: "aws-session-token",
                    environment: "OKOU_PI_AWS_SESSION_TOKEN",
                    secretName: "AWS_SESSION_TOKEN",
                  },
                ]
              : []),
          ],
  });
}

/** Build native launch metadata from the selected provider, never ambient auth. */
export function resolvePiNativeModelConfig(
  provider: PiNativeModelProviderInput,
): PiModelConfigV4 {
  const common = nativeConfigIdentity(provider);
  const catalogModel = common.catalogModel;
  const route = provider.concreteType ?? provider.type;
  const environment = provider.environment;
  if (route === "aws-bedrock") {
    return resolveNativeBedrockConfig(provider, common);
  }
  const standard = {
    "anthropic-api-key": {
      baseUrl: "https://api.anthropic.com",
      secretName: "ANTHROPIC_API_KEY",
      header: { name: "x-api-key", valueTemplate: "{{secret}}" },
    },
    "openrouter-api-key": {
      baseUrl: "https://openrouter.ai/api",
      secretName: "OPENROUTER_API_KEY",
      header: { name: "Authorization", valueTemplate: "Bearer {{secret}}" },
    },
    "vercel-ai-gateway": {
      baseUrl: "https://ai-gateway.vercel.sh",
      secretName: "VERCEL_AI_GATEWAY_API_KEY",
      header: { name: "Authorization", valueTemplate: "Bearer {{secret}}" },
    },
  } as const;
  const fixed = Object.hasOwn(standard, route)
    ? standard[route as keyof typeof standard]
    : undefined;
  if (fixed) {
    if (
      common.model !==
        getProviderRuntimeModel(route as keyof typeof standard, catalogModel) ||
      (environment.ANTHROPIC_BASE_URL !== undefined &&
        environment.ANTHROPIC_BASE_URL !== fixed.baseUrl)
    ) {
      throw new PiNativeConfigurationError(
        "Native Pi model or endpoint does not match the selected provider",
      );
    }
  }
  if (route === "azure-foundry" && provider.authMethod !== "api-key") {
    throw new PiNativeConfigurationError(
      "Native Foundry requires API-key authentication",
    );
  }
  return parseNativeConfig({
    ...common,
    route,
    dialect: "anthropic-messages",
    transport: "sse",
    provider: "anthropic",
    baseUrl:
      fixed?.baseUrl ??
      (route === "azure-foundry"
        ? `https://${environment.ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com/anthropic`
        : environment.ANTHROPIC_BASE_URL),
    credentialBindings: [
      {
        kind: "api-key",
        environment: "OKOU_PI_NATIVE_API_KEY",
        secretName:
          fixed?.secretName ??
          (route === "azure-foundry"
            ? "ANTHROPIC_FOUNDRY_API_KEY"
            : "OKOU_MODEL_PROVIDER_API_KEY"),
        credentialHeader:
          fixed?.header ??
          (route === "azure-foundry"
            ? { name: "x-api-key", valueTemplate: "{{secret}}" }
            : provider.credentialHeader),
      },
    ],
  });
}
