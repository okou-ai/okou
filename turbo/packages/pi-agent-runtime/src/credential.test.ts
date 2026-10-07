import { describe, expect, it } from "vitest";
import { piModelConfigSchema } from "@okouai/api-contracts/contracts/runners";

import { materializePiAgentModelConfig } from "./credential";

describe("Pi agent credential resolution", () => {
  it("materializes generation 3 Auto priority in the API-key slot", async () => {
    const config = piModelConfigSchema.parse({
      schemaVersion: 3,
      dialect: "openai-responses",
      transport: "sse",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "okou-1.0",
      serviceTier: "priority",
      credentialBindings: [
        {
          kind: "api-key",
          environment: "OPENAI_API_KEY",
          secretName: "OPENROUTER_API_KEY",
        },
      ],
    });
    const materialized = await materializePiAgentModelConfig({
      config,
      resolveCredential(binding) {
        expect(binding.secretName).toBe("OPENROUTER_API_KEY");
        return "opaque-key-placeholder";
      },
    });
    expect(materialized).toStrictEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "okou-1.0",
      serviceTier: "priority",
      dialect: "openai-responses",
      transport: "sse",
      apiKey: "opaque-key-placeholder",
    });
  });

  it("fails closed when the Auto credential is blank", async () => {
    const config = piModelConfigSchema.parse({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "okou-1.0",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENROUTER_API_KEY",
    });
    await expect(
      materializePiAgentModelConfig({
        config,
        resolveCredential() {
          return " ";
        },
      }),
    ).rejects.toThrow("Pi api-key credential is unavailable");
  });

  it("materializes canonical Gen1 as public Responses", async () => {
    const config = piModelConfigSchema.parse({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "okou-1.0",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENROUTER_API_KEY",
    });

    await expect(
      materializePiAgentModelConfig({
        config,
        resolveCredential(binding) {
          expect(binding).toMatchObject({
            kind: "api-key",
            environment: "OPENAI_API_KEY",
            secretName: "OPENROUTER_API_KEY",
          });
          return "selected-key";
        },
      }),
    ).resolves.toStrictEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "okou-1.0",
      dialect: "openai-responses",
      apiKey: "selected-key",
      transport: "sse",
    });
  });

  it.each([2, 3] as const)(
    "materializes exact subscription bindings from generation %s",
    async (schemaVersion) => {
      const config = piModelConfigSchema.parse({
        schemaVersion,
        ...(schemaVersion === 3 ? { serviceTier: "fast" } : {}),
        dialect: "openai-codex-responses",
        transport: "sse",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-6-luna",
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "account-id",
            environment: "CHATGPT_ACCOUNT_ID",
            secretName: "CHATGPT_ACCOUNT_ID",
          },
          {
            kind: "access-token",
            environment: "CHATGPT_ACCESS_TOKEN",
            secretName: "CHATGPT_ACCESS_TOKEN",
          },
        ],
      });
      const resolutionOrder: string[] = [];
      await expect(
        materializePiAgentModelConfig({
          config,
          resolveCredential(binding) {
            resolutionOrder.push(binding.kind);
            switch (binding.environment) {
              case "CHATGPT_ACCESS_TOKEN":
                return "opaque-access-token";
              case "CHATGPT_ACCOUNT_ID":
                return "account-id";
              default:
                throw new Error("Unexpected subscription binding");
            }
          },
        }),
      ).resolves.toStrictEqual({
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-6-luna",
        thinkingLevel: "low",
        ...(schemaVersion === 3 ? { serviceTier: "fast" } : {}),
        dialect: "openai-codex-responses",
        transport: "sse",
        apiKey: "opaque-access-token",
        accountId: "account-id",
      });
      expect(resolutionOrder).toStrictEqual(["access-token", "account-id"]);
    },
  );
});
