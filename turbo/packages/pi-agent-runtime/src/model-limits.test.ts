import { zstdDecompressSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  fauxAssistantMessage,
  normalizeContext,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

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

const API_MODELS = [
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

function openaiConfig(model: string) {
  return {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "synthetic-limit-test-key",
    model,
    dialect: "openai-responses",
    transport: "sse",
    thinkingLevel: "max",
  } as const satisfies PiAgentModelConfig;
}

function responsesModel(config: PiAgentModelConfig) {
  const model = resolvePiAgentModel(config);
  if (!model || model.api !== "openai-responses") {
    throw new Error("Expected a resolved Responses model");
  }
  return model;
}

/** Provider-observed retained usage without constructing a huge text fixture. */
function retainedContext(
  model: Model<"openai-responses">,
  inputTokens: number,
): TranscriptContext {
  return normalizeContext({
    messages: [
      {
        ...fauxAssistantMessage("Retained answer", { timestamp: 1 }),
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: inputTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      { role: "user", content: "Continue the task", timestamp: 2 },
    ],
  });
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
  it.each(
    API_MODELS.flatMap((model) => {
      return [undefined, "priority" as const].map((serviceTier) => {
        return { model, serviceTier };
      });
    }),
  )(
    "retains the normal output budget above 272K for $model/$serviceTier",
    async ({ model, serviceTier }) => {
      const config = { ...openaiConfig(model), serviceTier };
      const body = await captureRequest(
        config,
        retainedContext(responsesModel(config), 300_000),
      );
      expect(body).toMatchObject({
        model,
        max_output_tokens: 128_000,
        reasoning: { effort: "max" },
        ...(serviceTier ? { service_tier: serviceTier } : {}),
      });
      if (serviceTier === undefined) {
        expect(body).not.toHaveProperty("service_tier");
      }
    },
  );

  it("preserves an explicit caller output cap with retained long context", async () => {
    const config = openaiConfig("gpt-5.6-luna");
    const body = await captureRequest(
      config,
      retainedContext(responsesModel(config), 300_000),
      { maxTokens: 8_192 },
    );
    expect(body).toMatchObject({ max_output_tokens: 8_192 });
  });

  it("still clamps output to the remaining official total context", async () => {
    const config = openaiConfig("gpt-5.6-luna");
    const context = retainedContext(responsesModel(config), 920_000);
    const expected = 1_050_000 - estimateContextTokens(context).tokens - 4_096;
    expect(expected).toBeGreaterThan(16);
    expect(expected).toBeLessThan(128_000);
    const body = await captureRequest(config, context);
    expect(body).toMatchObject({ max_output_tokens: expected });
  });

  it("uses the corrected catalog limit without replacing an opaque deployment", async () => {
    const config = {
      ...openaiConfig("opaque-luna-deployment"),
      catalogModel: "gpt-5.6-luna",
      baseUrl: "https://deployment.example.test/v1",
    };
    const body = await captureRequest(
      config,
      retainedContext(responsesModel(config), 300_000),
    );
    expect(body).toMatchObject({
      model: "opaque-luna-deployment",
      max_output_tokens: 128_000,
    });
  });

  it.each([
    {
      provider: "deepseek",
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 393_216,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 393_216,
    },
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 943_718,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 384_000,
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

  it.each([...API_MODELS, "gpt-6.1-sol"])(
    "retains the official subscription default for %s rather than copying the API window",
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
