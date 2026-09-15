import { describe, expect, expectTypeOf, it } from "vitest";
import {
  piModelConfigSchema,
  type PiModelConfig,
} from "@okouai/api-contracts/contracts/runners";
import fixtures from "../../api-contracts/src/contracts/__tests__/fixtures/pi-native.json";

import {
  materializePiAgentModelConfig,
  materializePiExecutionRoute,
} from "./credential";
import { normalizePiExecutionRoute } from "./execution-route";
import type { PiAgentModelConfig, PiAgentStreamConfig } from "./types";
import { piAgentStreamForConfig } from "./model";
import { registeredModelConfig } from "./session-model";
import { streamPiNative } from "./native-stream";

describe("captured Pi execution intent", () => {
  it("preserves dialect requirements through execution and registration helpers", () => {
    type Codex = Extract<
      PiAgentModelConfig,
      { dialect: "openai-codex-responses" }
    >;
    type Public = Extract<PiAgentModelConfig, { dialect: "openai-responses" }>;
    type Messages = Extract<
      PiAgentModelConfig,
      { dialect: "anthropic-messages" }
    >;
    type Bedrock = Extract<
      PiAgentModelConfig,
      { dialect: "bedrock-converse-stream" }
    >;
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
    expectTypeOf<
      Omit<Messages, "catalogModel">
    >().not.toMatchTypeOf<PiAgentModelConfig>();
    expectTypeOf<
      Omit<Messages, "requestHeaders">
    >().not.toMatchTypeOf<PiAgentModelConfig>();
    expectTypeOf<
      Omit<Messages, "serviceTier"> & { serviceTier: "priority" }
    >().not.toMatchTypeOf<PiAgentModelConfig>();
    expectTypeOf<Omit<Bedrock, "region">>().not.toMatchTypeOf<
      Parameters<typeof streamPiNative>[0]
    >();
    expectTypeOf<
      Omit<Bedrock, "bedrockAuth">
    >().not.toMatchTypeOf<PiAgentStreamConfig>();
    expectTypeOf<
      Omit<Bedrock, "transport"> & { transport: "sse" }
    >().not.toMatchTypeOf<PiAgentModelConfig>();
    expectTypeOf<{ kind: "sigv4"; accessKeyId: string }>().not.toMatchTypeOf<
      Bedrock["bedrockAuth"]
    >();
    expectTypeOf<{ kind: "bearer" }>().not.toMatchTypeOf<
      Bedrock["bedrockAuth"]
    >();
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
        catalogModel: "gpt-5.6-terra",
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
        catalogModel: "gpt-5.6-terra",
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

  it.each(fixtures)(
    "owns $name native references without rewriting the wire",
    async ({ config }) => {
      // JSON fixtures model the untrusted wire; normalization performs the same
      // strict contract validation used by the actual launch reader.
      const wire = piModelConfigSchema.parse(config);
      const before = JSON.stringify(wire);
      const route = normalizePiExecutionRoute(wire);
      expect(route).not.toHaveProperty("schemaVersion");
      expect(route).toMatchObject({
        dialect: config.dialect,
        model: config.model,
        catalogModel: config.catalogModel,
        billingOwner: config.billingOwner,
        credentialOwner: config.credentialOwner,
        requestPolicy: { maxAttempts: 1, cacheRetention: "short" },
      });
      const materializing = materializePiExecutionRoute({
        route,
        target: "direct",
        async resolveCredential() {
          await Promise.resolve();
          return "selected-native-secret";
        },
      });
      Object.defineProperty(route, "catalogModel", {
        value: "unselected-catalog",
      });
      Object.defineProperty(route, "model", { value: "unselected-model" });
      const materialized = await materializing;
      expect(materialized.model).toBe(config.model);
      expect(materialized.catalogModel).toBe(config.catalogModel);
      expect(JSON.stringify(wire)).toBe(before);
      expect(JSON.stringify(route)).not.toContain("selected-native-secret");
    },
  );
});
