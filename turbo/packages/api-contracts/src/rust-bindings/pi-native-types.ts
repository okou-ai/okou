import { piModelConfigV4Schema } from "../contracts/pi-native";
import type { RustTypeBinding, RustTypeDeclarationDoc } from "./types";

const fields = {
  schemaVersion: ["Independent Pi model configuration generation."],
  baseUrl: ["Exact public inference base URL."],
  model: ["Configured upstream model, deployment or profile."],
  catalogModel: ["Trusted logical model for native catalog capabilities."],
  credentialOwner: ["Owner of the selected credential bundle."],
  billingOwner: ["Owner of model-token billing."],
  thinkingLevel: ["Captured model thinking policy."],
  requestPolicy: ["Fixed native request attempt and cache policy."],
  transport: ["Native framing protocol."],
  provider: ["Trusted catalog provider identity."],
  route: ["Selected concrete provider route."],
  region: ["Frozen AWS region."],
  authMode: ["Selected explicit Bedrock authentication mode."],
  credentialBindings: ["Non-secret references resolved at the execution edge."],
};

function variants(
  values: readonly string[],
): Record<string, readonly string[]> {
  return Object.fromEntries(
    values.map((value) => {
      return [value, [`Native wire value ${value}.`]];
    }),
  );
}

export const piNativeTypeBindings: readonly RustTypeBinding[] = [
  {
    schema: piModelConfigV4Schema,
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfigV4",
    direction: "response",
    fieldTypeOverrides: { environment: "String", secretName: "String" },
    declarations: [
      {
        rustTypeName: "PiModelConfigV4",
        rustDoc: [
          "Strict native reader contract; existing launch writers remain unchanged.",
        ],
        fields,
        variants: {
          "anthropic-messages": ["Native Messages over SSE."],
          "bedrock-converse-stream": ["Native Converse over AWS event-stream."],
        },
      },
      ...(["AnthropicMessages", "BedrockConverseStream"] as const).flatMap(
        (dialect): RustTypeDeclarationDoc[] => {
          const prefix = `PiModelConfigV4${dialect}`;
          return [
            {
              rustTypeName: `${prefix}Transport`,
              rustDoc: ["Native framing protocol."],
              variants: variants([
                dialect === "AnthropicMessages" ? "sse" : "aws-event-stream",
              ]),
            },
            {
              rustTypeName: `${prefix}Provider`,
              rustDoc: ["Trusted native catalog provider."],
              variants: variants([
                dialect === "AnthropicMessages"
                  ? "anthropic"
                  : "amazon-bedrock",
              ]),
            },
            {
              rustTypeName: `${prefix}RequestPolicyCacheRetention`,
              rustDoc: ["Native cache retention policy."],
              variants: variants(["short"]),
            },

            {
              rustTypeName: `${prefix}CatalogModel`,
              rustDoc: ["Frozen native catalog vocabulary."],
              variants: variants([
                "claude-fable-5-1",
                "claude-opus-5-5",
                "claude-opus-5",
                "claude-opus-4-8",
                "claude-sonnet-5",
                "claude-sonnet-4-6",
              ]),
            },
            {
              rustTypeName: `${prefix}CredentialOwner`,
              rustDoc: ["Selected credential owner."],
              variants: variants(["builtin", "organization", "member"]),
            },
            {
              rustTypeName: `${prefix}BillingOwner`,
              rustDoc: ["Model-token billing owner."],
              variants: variants(["builtin", "user"]),
            },
            {
              rustTypeName: `${prefix}ThinkingLevel`,
              rustDoc: ["Native thinking level."],
              variants: variants([
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ]),
            },
            {
              rustTypeName: `${prefix}RequestPolicy`,
              rustDoc: ["Fixed native request policy."],
              fields: {
                maxAttempts: ["Exactly one native HTTP attempt."],
                cacheRetention: ["Existing short cache retention."],
              },
            },
            {
              rustTypeName: `${prefix}CredentialBinding`,
              rustDoc: ["Non-secret native credential reference."],
              fields: {
                ...(dialect === "AnthropicMessages"
                  ? {
                      kind: ["Native API-key binding."],
                      credentialHeader: [
                        "Exact configured credential header policy.",
                      ],
                    }
                  : {}),
                environment: ["Sandbox marker environment name."],
                secretName: ["Trusted execution-edge secret reference."],
              },
              ...(dialect === "BedrockConverseStream"
                ? {
                    variants: variants([
                      "aws-bearer-token",
                      "aws-access-key-id",
                      "aws-secret-access-key",
                      "aws-session-token",
                    ]),
                  }
                : {}),
            },
            ...(dialect === "AnthropicMessages"
              ? [
                  {
                    rustTypeName: `${prefix}Route`,
                    rustDoc: ["Concrete native Messages route."],
                    variants: variants([
                      "anthropic-api-key",
                      "openrouter-api-key",
                      "vercel-ai-gateway",
                      "custom-anthropic-messages",
                      "azure-foundry",
                    ]),
                  },
                  {
                    rustTypeName: `${prefix}CredentialBindingCredentialHeader`,
                    rustDoc: ["Native header ownership."],
                    fields: {
                      name: ["Credential header name."],
                      valueTemplate: ["Exactly one secret placeholder."],
                    },
                  },
                ]
              : [
                  {
                    rustTypeName: `${prefix}Route`,
                    rustDoc: ["Native Bedrock route."],
                    variants: variants(["aws-bedrock"]),
                  },
                  {
                    rustTypeName: `${prefix}AuthMode`,
                    rustDoc: ["Explicit Bedrock authentication mode."],
                    variants: variants(["bearer", "sigv4"]),
                  },
                ]),
          ];
        },
      ),
    ],
  },
];
