import { describe, expect, expectTypeOf, it } from "vitest";
import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";

import { materializePiAgentModelConfig } from "./credential";
import type { PiAgentModelConfig, PiAgentStreamConfig } from "./types";
import { piAgentStreamForConfig } from "./model";
import { registeredModelConfig } from "./session-model";

describe("captured Pi execution intent", () => {
  it("preserves dialect requirements through execution and registration helpers", () => {
    type Codex = Extract<
      PiAgentModelConfig,
      { dialect: "openai-codex-responses" }
    >;
    type Public = Extract<PiAgentModelConfig, { dialect: "openai-responses" }>;
    expectTypeOf<
      Omit<Codex, "accountId">
    >().not.toMatchTypeOf<PiAgentModelConfig>();
    expectTypeOf<
      Omit<Codex, "accountId">
    >().not.toMatchTypeOf<PiAgentStreamConfig>();
    expectTypeOf<Omit<Codex, "accountId">>().not.toMatchTypeOf<
      Parameters<typeof registeredModelConfig>[2]
    >();
    expectTypeOf<Omit<Codex, "transport">>().not.toMatchTypeOf<
      Parameters<typeof piAgentStreamForConfig>[0]
    >();
    expectTypeOf<
      Omit<Public, "serviceTier"> & { serviceTier: "fast" }
    >().not.toMatchTypeOf<PiAgentModelConfig>();
    expectTypeOf<
      Omit<Codex, "serviceTier"> & { serviceTier: "priority" }
    >().not.toMatchTypeOf<PiAgentModelConfig>();
  });

  it.each([1, 2, 3] as const)(
    "owns generation %s header policy before credential resolution",
    async (generation) => {
      const header = {
        name: "X-Selected-Key",
        valueTemplate: "Key {{secret}}",
      };
      const config = {
        provider: "openai",
        baseUrl: "https://gateway.example.com/v1",
        model: "company-production",
        catalogModel: "gpt-6-luna",
        ...(generation === 1
          ? {
              apiKeyEnv: "OPENAI_API_KEY",
              credentialSecretName: "OPENAI_API_KEY",
              credentialHeader: header,
            }
          : {
              schemaVersion: generation,
              dialect: "openai-responses",
              transport: "sse",
              credentialBindings: [
                {
                  kind: "api-key",
                  environment: "OPENAI_API_KEY",
                  secretName: "OPENAI_API_KEY",
                  credentialHeader: header,
                },
              ],
            }),
      } satisfies PiModelConfig;
      const materializing = materializePiAgentModelConfig({
        config,
        target: "direct",
        async resolveCredential() {
          await Promise.resolve();
          return "selected-secret";
        },
      });
      header.name = "Authorization";
      header.valueTemplate = "Changed {{secret}}";
      expect(await materializing).toStrictEqual({
        provider: "openai",
        baseUrl: "https://gateway.example.com/v1",
        model: "company-production",
        catalogModel: "gpt-6-luna",
        dialect: "openai-responses",
        transport: "sse",
        apiKey: "unused",
        requestHeaders: {
          authorization: null,
          "X-Selected-Key": "Key selected-secret",
        },
      });
    },
  );
});
