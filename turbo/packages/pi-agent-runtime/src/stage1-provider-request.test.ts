import { zstdDecompressSync } from "node:zlib";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PI_MEMORY_STAGE1_PERSONAL_MODEL } from "./memory-background-config";
import { PI_MEMORY_STAGE1_OUTPUT_TOKENS } from "./stage1-input";
import {
  preparePiMemoryStage1Extraction,
  runPiMemoryStage1PreparedExtraction,
} from "./stage1-memory";
import { PI_MEMORY_STAGE1_RESPONSE_SCHEMA } from "./stage1-provider";
import { PI_MEMORY_STAGE1_SYSTEM_PROMPT } from "./stage1-prompts";
import type { PiAgentModelConfig } from "./types";

const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});

const REQUEST_ID = "00000000-0000-4000-8000-000000000999";
const AFFINITY_ID = "MEMORY-user-1-org-1";
const RESPONSE_TEXT = JSON.stringify({
  raw_memory: "memory",
  rollout_summary: "summary",
  rollout_slug: null,
});
const USAGE = { input: 9, output: 7, cacheRead: 2, cacheWrite: 0 };

const routes: readonly {
  readonly name: string;
  readonly url: string;
  readonly responseId: string;
  readonly model: PiAgentModelConfig;
}[] = [
  {
    name: "public Responses",
    url: "https://stage1.test/v1/responses",
    responseId: "resp_stage1",
    model: {
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      baseUrl: "https://stage1.test/v1",
      apiKey: "test-key",
      dialect: "openai-responses",
      transport: "sse",
    },
  },
  {
    name: "OpenRouter Completions",
    url: "https://stage1.test/v1/chat/completions",
    responseId: "chatcmpl_stage1",
    model: {
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      baseUrl: "https://stage1.test/v1",
      apiKey: "test-key",
      dialect: "openai-completions",
      transport: "sse",
      sessionAffinityKey: AFFINITY_ID,
    },
  },
  {
    name: "OpenRouter memory preset",
    url: "https://stage1.test/v1/chat/completions",
    responseId: "chatcmpl_stage1",
    model: {
      provider: "openrouter",
      model: "@preset/memory",
      baseUrl: "https://stage1.test/v1",
      apiKey: "test-key",
      dialect: "openai-completions",
      transport: "sse",
      sessionAffinityKey: AFFINITY_ID,
    },
  },
  {
    name: "native Codex Responses",
    url: "https://chatgpt.com/backend-api/codex/responses",
    responseId: "resp_stage1",
    model: {
      provider: "openai-codex",
      model: PI_MEMORY_STAGE1_PERSONAL_MODEL,
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: "test-key",
      accountId: "test-codex-account",
      dialect: "openai-codex-responses",
      transport: "sse",
    },
  },
];

function providerResponse(
  model: PiAgentModelConfig,
  incomplete = false,
): Response {
  let events: readonly unknown[];
  if (model.dialect === "openai-completions") {
    const base = {
      id: "chatcmpl_stage1",
      object: "chat.completion.chunk",
      model: model.model,
    };
    events = [
      {
        ...base,
        choices: [
          { index: 0, delta: { content: RESPONSE_TEXT }, finish_reason: null },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: incomplete ? "length" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ];
  } else {
    events = [
      {
        type: "response.created",
        response: { id: "resp_stage1", output: [], usage: null },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_stage1",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: RESPONSE_TEXT,
      },
      {
        type: incomplete ? "response.incomplete" : "response.completed",
        response: {
          id: "resp_stage1",
          status: incomplete ? "incomplete" : "completed",
          ...(incomplete
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
          output: [],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 2 },
            total_tokens: 18,
          },
        },
      },
    ];
  }
  const body =
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join("") +
    (model.dialect === "openai-completions" ? "data: [DONE]\n\n" : "");
  return new HttpResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function captureRequests(
  url: string,
  response: () => Response,
): {
  readonly body: string;
  readonly headers: Headers;
}[] {
  const requests: { body: string; headers: Headers }[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      const bytes = Buffer.from(await request.arrayBuffer());
      requests.push({
        body: (request.headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(bytes)
          : bytes
        ).toString("utf8"),
        headers: request.headers,
      });
      return response();
    }),
  );
  return requests;
}

describe.each(routes)(
  "Pi Stage 1 prepared $name request",
  ({ model, url, responseId }) => {
    const prepare = () => {
      return preparePiMemoryStage1Extraction({
        model,
        evidence: [{ kind: "human", content: "Retain this human request." }],
        requestId: REQUEST_ID,
      });
    };

    it("prepares without HTTP and sends exactly the measured SDK body", async () => {
      const requests = captureRequests(url, () => {
        return providerResponse(model);
      });
      const prepared = prepare();
      expect(requests).toHaveLength(0);
      expect(prepared.payload).toMatchObject({
        model: model.model,
      });
      if (model.model !== "@preset/memory") {
        expect(prepared.payload).toMatchObject({
          reasoning: { effort: "low" },
        });
      }
      const format = {
        type: "json_schema",
        name: "pi_memory_stage1",
        strict: true,
        schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
      };
      if (model.model === "@preset/memory") {
        expect(Object.keys(prepared.payload as object).sort()).toStrictEqual([
          "messages",
          "model",
          "stream",
          "stream_options",
        ]);
        expect(prepared.payload).toMatchObject({
          messages: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: PI_MEMORY_STAGE1_SYSTEM_PROMPT,
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: expect.stringContaining("Retain this human request."),
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        });
      } else if (model.dialect === "openai-completions") {
        expect(prepared.payload).toMatchObject({
          max_tokens: PI_MEMORY_STAGE1_OUTPUT_TOKENS,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: format.name,
              strict: true,
              schema: format.schema,
            },
          },
          messages: [
            { role: "developer" },
            {
              role: "user",
              content: [
                expect.objectContaining({
                  type: "text",
                  text: expect.stringContaining("Retain this human request."),
                }),
              ],
            },
          ],
        });
      } else {
        expect(prepared.payload).toMatchObject({ text: { format } });
        if (model.dialect === "openai-codex-responses") {
          expect(prepared.payload).toMatchObject({
            instructions: PI_MEMORY_STAGE1_SYSTEM_PROMPT,
            prompt_cache_key: REQUEST_ID,
          });
          expect(prepared.payload).not.toHaveProperty("max_output_tokens");
        } else {
          expect(prepared.payload).toMatchObject({
            max_output_tokens: PI_MEMORY_STAGE1_OUTPUT_TOKENS,
          });
        }
      }
      expect(prepared.payload).not.toHaveProperty("tools");
      expect(prepared.payload).not.toHaveProperty("service_tier");

      await expect(
        runPiMemoryStage1PreparedExtraction(prepared),
      ).resolves.toEqual({
        responseText: RESPONSE_TEXT,
        responseId,
        usage: USAGE,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toBe(JSON.stringify(prepared.payload));
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
      if (model.dialect === "openai-completions") {
        expect(requests[0]?.headers.get("x-session-id")).toBe(AFFINITY_ID);
      }
      expect(requests[0]?.headers.get("user-agent")).toBe("okou-pi-agent/1.0");
      if (model.dialect === "openai-codex-responses") {
        expect(requests[0]?.headers.get("chatgpt-account-id")).toBe(
          model.accountId,
        );
      }
    });

    it("keeps the caller's abort reason and sends no HTTP request", async () => {
      const requests = captureRequests(url, () => {
        return providerResponse(model);
      });
      const controller = new AbortController();
      const reason = new Error("provider operation stopped");
      controller.abort(reason);
      await expect(
        runPiMemoryStage1PreparedExtraction(prepare(), controller.signal),
      ).rejects.toBe(reason);
      expect(requests).toHaveLength(0);
    });

    it("retains response status, identity and consumption on incomplete output", async () => {
      const requests = captureRequests(url, () => {
        return providerResponse(model, true);
      });
      await expect(
        runPiMemoryStage1PreparedExtraction(prepare()),
      ).rejects.toMatchObject({
        name: "PiMemoryStage1ProviderError",
        status: 200,
        result: { responseText: RESPONSE_TEXT, responseId, usage: USAGE },
      });
      expect(requests).toHaveLength(1);
    });

    it("retains a rejected HTTP status without fabricating consumption", async () => {
      const requests = captureRequests(url, () => {
        return HttpResponse.json(
          {
            error: {
              message: "invalid credential",
              type: "authentication_error",
            },
          },
          { status: 401 },
        );
      });
      await expect(
        runPiMemoryStage1PreparedExtraction(prepare()),
      ).rejects.toMatchObject({
        name: "PiMemoryStage1ProviderError",
        status: 401,
        result: undefined,
      });
      expect(requests).toHaveLength(1);
    });
  },
);

it("rejects an unbound native account during pure preparation", () => {
  const requests = captureRequests(
    "https://chatgpt.com/backend-api/codex/responses",
    () => {
      return HttpResponse.json({});
    },
  );
  expect(() => {
    return preparePiMemoryStage1Extraction({
      model: {
        provider: "openai-codex",
        model: PI_MEMORY_STAGE1_PERSONAL_MODEL,
        baseUrl: "https://chatgpt.com/backend-api",
        apiKey: "test-key",
        accountId: " ",
        dialect: "openai-codex-responses",
        transport: "sse",
      },
      evidence: [],
      requestId: REQUEST_ID,
    });
  }).toThrow("Pi Codex Responses requires an explicit account ID");
  expect(requests).toHaveLength(0);
});
