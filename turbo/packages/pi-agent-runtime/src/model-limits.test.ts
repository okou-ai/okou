import { zstdDecompressSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  normalizeContext,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import type { PiAgentModelConfig } from "./types";
import type { PiAgentStreamOptions } from "./stream-options";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const CODEX_MODELS = [
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

function responsesModel(config: PiAgentModelConfig) {
  const model = resolvePiAgentModel(config);
  if (!model || model.api !== "openai-responses") {
    throw new Error("Expected a resolved Responses model");
  }
  return model;
}

async function captureRequest(
  config: PiAgentModelConfig,
  context: TranscriptContext,
  options: PiAgentStreamOptions = {},
) {
  const requests: unknown[] = [];
  server.use(
    http.post(`${config.baseUrl}/responses`, async ({ request }) => {
      const bytes = Buffer.from(await request.arrayBuffer());
      const body =
        request.headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(bytes)
          : bytes;
      requests.push(JSON.parse(body.toString("utf8")) as unknown);
      // The real adapter builds and sends a request; no live inference or retry.
      return HttpResponse.json(
        {
          error: {
            message: "Synthetic request capture",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    }),
  );
  const result = await piAgentStreamForConfig(config)(
    responsesModel(config),
    context,
    {
      ...options,
      apiKey: config.apiKey,
      reasoning: "max",
      maxRetries: 0,
    },
  ).result();
  expect(result.stopReason).toBe("error");
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe("official Pi model limits at the provider boundary", () => {
  it.each([
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 943_718,
    },
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 384_000,
    },
  ])(
    "sends the exact $provider/$model ceiling without conflating versions or providers",
    async ({ provider, model, baseUrl, maxTokens }) => {
      const config = {
        provider,
        model,
        baseUrl,
        apiKey: "synthetic-limit-test-key",
        dialect: "openai-responses",
        transport: "sse",
      } as const;
      const body = await captureRequest(
        config,
        normalizeContext({
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        }),
      );
      expect(body).toMatchObject({ model, max_output_tokens: maxTokens });
    },
  );

  it.each([...CODEX_MODELS, "gpt-6.1-sol"])(
    "retains the official subscription default for %s",
    (model) => {
      const resolved = resolvePiAgentModel({
        provider: "openai-codex",
        model,
        baseUrl: "https://chatgpt.com/backend-api",
        apiKey: "synthetic-subscription-key",
        accountId: "synthetic-subscription-account",
        dialect: "openai-codex-responses",
        transport: "sse",
      });
      expect(resolved).toMatchObject({
        provider: "openai-codex",
        id: model,
        contextWindow: 272_000,
        maxTokens: 128_000,
      });
    },
  );
});
