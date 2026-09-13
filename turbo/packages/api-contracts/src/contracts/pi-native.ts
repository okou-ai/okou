import { z } from "zod";
import {
  canonicalizeFirewallBaseUrl,
  validateBaseUrlHostPolicy,
} from "@okouai/connectors/firewall-types";
import { piCredentialHeaderSchema } from "./pi-credential";
import { piNativeCatalogModelSchema } from "./pi-native-models";

export const PI_MODEL_CONFIG_NATIVE_GENERATION = 4;

export const PI_NATIVE_CREDENTIAL_PLACEHOLDER = "OKOUPINATIVEPLACEHOLDER";

const nativeApiKeyBinding = z
  .object({
    kind: z.literal("api-key"),
    environment: z.enum(["OKOU_PI_NATIVE_API_KEY"]),
    secretName: z.enum([
      "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY",
      "OKOU_MODEL_PROVIDER_API_KEY",
      "ANTHROPIC_FOUNDRY_API_KEY",
    ]),
    credentialHeader: piCredentialHeaderSchema,
  })
  .strict()
  .readonly();

const nativeAwsBindings = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("aws-bearer-token"),
      environment: z.enum(["OKOU_PI_BEDROCK_BEARER_TOKEN"]),
      secretName: z.enum(["AWS_BEARER_TOKEN_BEDROCK"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("aws-access-key-id"),
      environment: z.enum(["OKOU_PI_AWS_ACCESS_KEY_ID"]),
      secretName: z.enum(["AWS_ACCESS_KEY_ID"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("aws-secret-access-key"),
      environment: z.enum(["OKOU_PI_AWS_SECRET_ACCESS_KEY"]),
      secretName: z.enum(["AWS_SECRET_ACCESS_KEY"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("aws-session-token"),
      environment: z.enum(["OKOU_PI_AWS_SESSION_TOKEN"]),
      secretName: z.enum(["AWS_SESSION_TOKEN"]),
    })
    .strict()
    .readonly(),
]);

const common = {
  schemaVersion: z.literal(PI_MODEL_CONFIG_NATIVE_GENERATION),
  baseUrl: z.url().max(2048),
  model: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\s\p{Cc}]+$/u),
  catalogModel: piNativeCatalogModelSchema,
  credentialOwner: z.enum(["builtin", "organization", "member"]),
  billingOwner: z.enum(["builtin", "user"]),
  thinkingLevel: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional(),
  requestPolicy: z
    .object({ maxAttempts: z.literal(1), cacheRetention: z.enum(["short"]) })
    .strict()
    .readonly(),
};

/** Native consumers only. No production launch emits this generation in #32803. */
const nativeModelShape = z.discriminatedUnion("dialect", [
  z
    .object({
      ...common,
      dialect: z.literal("anthropic-messages"),
      transport: z.enum(["sse"]),
      provider: z.enum(["anthropic"]),
      route: z.enum([
        "anthropic-api-key",
        "openrouter-api-key",
        "vercel-ai-gateway",
        "custom-anthropic-messages",
        "azure-foundry",
      ]),
      credentialBindings: z.array(nativeApiKeyBinding).length(1),
    })
    .strict(),
  z
    .object({
      ...common,
      dialect: z.literal("bedrock-converse-stream"),
      transport: z.enum(["aws-event-stream"]),
      provider: z.enum(["amazon-bedrock"]),
      route: z.enum(["aws-bedrock"]),
      region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/u),
      authMode: z.enum(["bearer", "sigv4"]),
      credentialBindings: z.array(nativeAwsBindings).min(1).max(3),
    })
    .strict(),
]);
type NativeConfig = z.infer<typeof nativeModelShape>;
type NativeIssue = (message: string) => void;

function validateNativeBase(config: NativeConfig, invalid: NativeIssue): void {
  try {
    const canonical = canonicalizeFirewallBaseUrl(config.baseUrl, "pi-native");
    const url = new URL(config.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      canonical !== config.baseUrl ||
      /[{}]/u.test(config.baseUrl)
    ) {
      invalid("Native inference requires an exact public HTTPS base URL");
    }
    if (
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") ||
      (!url.hostname.includes(".") && !url.hostname.startsWith("["))
    ) {
      invalid("Native inference requires a public destination");
    }
    validateBaseUrlHostPolicy({
      base: config.baseUrl,
      serviceName: "pi-native",
      hostPolicy: { kind: "publicDestination" },
    });
  } catch {
    invalid("Native inference base URL is invalid");
  }
}

function validateBedrock(
  config: Extract<NativeConfig, { dialect: "bedrock-converse-stream" }>,
  invalid: NativeIssue,
): void {
  if (
    config.baseUrl !== `https://bedrock-runtime.${config.region}.amazonaws.com`
  )
    invalid("Bedrock endpoint must match its frozen region");
  const arn = /^arn:aws:bedrock:([^:]+):/u.exec(config.model);
  if (config.model.startsWith("arn:") && arn?.[1] !== config.region)
    invalid("Bedrock profile must match its frozen region");
  const kinds = config.credentialBindings.map((binding) => {
    return binding.kind;
  });
  const valid =
    config.authMode === "bearer"
      ? kinds.length === 1 && kinds[0] === "aws-bearer-token"
      : (kinds.length === 2 || kinds.length === 3) &&
        kinds.includes("aws-access-key-id") &&
        kinds.includes("aws-secret-access-key") &&
        !kinds.includes("aws-bearer-token");
  if (!valid || new Set(kinds).size !== kinds.length)
    invalid("Bedrock requires exactly its selected credential bundle");
  if (config.billingOwner === "builtin")
    invalid("Existing Bedrock routes are user owned");
}

function validateMessagesEndpoint(
  config: Extract<NativeConfig, { dialect: "anthropic-messages" }>,
  invalid: NativeIssue,
): void {
  const binding = config.credentialBindings[0];
  if (!binding) return;
  const expected = {
    "anthropic-api-key": [
      "https://api.anthropic.com",
      "ANTHROPIC_API_KEY",
      "x-api-key",
      "{{secret}}",
    ],
    "openrouter-api-key": [
      "https://openrouter.ai/api",
      "OPENROUTER_API_KEY",
      "authorization",
      "Bearer {{secret}}",
    ],
    "vercel-ai-gateway": [
      "https://ai-gateway.vercel.sh",
      "VERCEL_AI_GATEWAY_API_KEY",
      "authorization",
      "Bearer {{secret}}",
    ],
  } as const;
  if (config.route in expected) {
    const policy = expected[config.route as keyof typeof expected];
    if (
      config.baseUrl !== policy[0] ||
      binding.secretName !== policy[1] ||
      binding.credentialHeader.name.toLowerCase() !== policy[2] ||
      binding.credentialHeader.valueTemplate !== policy[3]
    )
      invalid("Native route endpoint and credential header must match");
  } else if (config.route === "azure-foundry") {
    if (
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.services\.ai\.azure\.com\/anthropic$/u.test(
        config.baseUrl,
      ) ||
      binding.secretName !== "ANTHROPIC_FOUNDRY_API_KEY" ||
      binding.credentialHeader.name.toLowerCase() !== "x-api-key" ||
      binding.credentialHeader.valueTemplate !== "{{secret}}"
    )
      invalid("Foundry requires its exact resource and API key");
  } else if (binding.secretName !== "OKOU_MODEL_PROVIDER_API_KEY") {
    invalid("Custom Messages requires its selected surface credential");
  }
}

function validateMessages(
  config: Extract<NativeConfig, { dialect: "anthropic-messages" }>,
  invalid: NativeIssue,
): void {
  const binding = config.credentialBindings[0];
  if (!binding) return;
  if (
    [
      "host",
      "content-length",
      "connection",
      "transfer-encoding",
      "proxy-authorization",
      "user-agent",
    ].includes(binding.credentialHeader.name.toLowerCase()) ||
    /sk-ant-(?:oat|ort)/iu.test(binding.credentialHeader.valueTemplate)
  )
    invalid("Native credential header is unsafe");
  if (
    config.billingOwner === "builtin" &&
    config.route !== "anthropic-api-key" &&
    config.route !== "openrouter-api-key"
  )
    invalid(
      "Built-in native routes must retain their selected managed provider",
    );
  validateMessagesEndpoint(config, invalid);
}

/** Native consumers only; no production launch emits this generation in #32803. */
export const piModelConfigV4Schema = nativeModelShape
  .superRefine((config, ctx) => {
    const invalid = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (
      (config.credentialOwner === "builtin") !==
      (config.billingOwner === "builtin")
    )
      invalid("Native credential and billing ownership must agree");
    validateNativeBase(config, invalid);
    if (config.dialect === "bedrock-converse-stream")
      validateBedrock(config, invalid);
    else validateMessages(config, invalid);
  })
  .readonly();

export type PiModelConfigV4 = z.infer<typeof piModelConfigV4Schema>;

export function piNativeInferenceUrl(config: PiModelConfigV4): string {
  return config.dialect === "anthropic-messages"
    ? `${config.baseUrl}/v1/messages`
    : `${config.baseUrl}/model/${encodeURIComponent(config.model)}/converse-stream`;
}
