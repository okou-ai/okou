import { describe, expect, expectTypeOf, it } from "vitest";
import {
  piModelConfigSchema,
  type PiModelConfig,
} from "@okouai/api-contracts/contracts/runners";

import {
  materializePiAgentModelConfig,
  materializePiExecutionRoute,
} from "./credential";
import { normalizePiExecutionRoute } from "./execution-route";
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
    "owns the generation %s Auto route before credential resolution",
    async (generation) => {
      const config = {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "okou-1.0",
        ...(generation === 1
          ? {
              apiKeyEnv: "OPENAI_API_KEY",
              credentialSecretName: "OPENROUTER_API_KEY",
            }
          : {
              schemaVersion: generation,
              dialect: "openai-responses",
              transport: "sse",
              credentialBindings: [
                {
                  kind: "api-key",
                  environment: "OPENAI_API_KEY",
                  secretName: "OPENROUTER_API_KEY",
                },
              ],
            }),
      } satisfies PiModelConfig;
      const wire = piModelConfigSchema.parse(config);
      const before = JSON.stringify(wire);
      const route = normalizePiExecutionRoute(wire);
      expect(route).not.toHaveProperty("schemaVersion");
      const materializing = materializePiExecutionRoute({
        route,
        async resolveCredential() {
          await Promise.resolve();
          return "selected-secret";
        },
      });
      Object.defineProperty(route, "model", { value: "unselected-model" });
      expect(await materializing).toStrictEqual({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "okou-1.0",
        dialect: "openai-responses",
        transport: "sse",
        apiKey: "selected-secret",
      });
      expect(JSON.stringify(wire)).toBe(before);
      expect(JSON.stringify(route)).not.toContain("selected-secret");
      await expect(
        materializePiAgentModelConfig({
          config,
          resolveCredential() {
            return "selected-secret";
          },
        }),
      ).resolves.toMatchObject({ model: "okou-1.0" });
    },
  );
});
