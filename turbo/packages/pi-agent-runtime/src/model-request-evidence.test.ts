import { zstdDecompressSync } from "node:zlib";
import {
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { piAgentStreamForConfig } from "./model";
import { resolvePiAgentModel } from "./model-catalog";
import { piModelFailureReason } from "./model-request-diagnostics";

const codex = {
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-6-luna",
  apiKey: "private-credential-sentinel",
  accountId: "private-account-sentinel",
  dialect: "openai-codex-responses",
  transport: "sse",
} as const;
const completions = {
  provider: "openrouter",
  baseUrl: "https://evidence.test/v1",
  model: "@preset/okou-1-0",
  catalogModel: "okou-1.0",
  apiKey: "private-credential-sentinel",
  dialect: "openai-completions",
  transport: "sse",
} as const;
const requestId = "req_0123456789abcdef0123456789abcdef";
const cfRay = "0123456789abcdef-SJC";
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

function stream(
  config: typeof codex | typeof completions,
  options?: SimpleStreamOptions,
) {
  const model = resolvePiAgentModel(config);
  if (!model) throw new Error("Missing fixture model");
  return piAgentStreamForConfig(config)(
    model,
    normalizeContext({
      messages: [
        { role: "user", content: "private-prompt-sentinel", timestamp: 1 },
      ],
      tools: [],
    }),
    { ...options, apiKey: config.apiKey },
  );
}

it.each(["replacement", "mutation"] as const)(
  "reports the effective async payload and actual compressed wire bytes after %s",
  async (mode) => {
    let wireBytes: number | undefined;
    let payload: Record<string, unknown> | undefined;
    server.use(
      http.post(`${codex.baseUrl}/codex/responses`, async ({ request }) => {
        const bytes = Buffer.from(await request.arrayBuffer());
        wireBytes = bytes.byteLength;
        expect(request.headers.get("content-encoding")).toBe("zstd");
        payload = JSON.parse(zstdDecompressSync(bytes).toString());
        return HttpResponse.json(
          { detail: "Bad Request" },
          {
            status: 400,
            headers: {
              "x-request-id": requestId,
              "cf-ray": cfRay,
              "x-private": "private-header-sentinel",
            },
          },
        );
      }),
    );
    const instructions = "private-instructions-sentinel 中文";
    const result = await stream(codex, {
      onPayload: async (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("Expected generated SDK payload");
        const updated = {
          ...value,
          instructions,
          reasoning: { effort: "high" },
          tools: [
            {
              type: "function",
              name: "private-tool-sentinel",
              parameters: { type: "object", properties: {} },
            },
          ],
          input: [
            { role: "user", content: "private-prompt-sentinel" },
            { role: "user", content: "private-followup-sentinel" },
          ],
        };
        await Promise.resolve();
        if (mode === "replacement") return updated;
        Object.assign(value, updated);
        return undefined;
      },
    }).result();
    expect(payload).toMatchObject({
      instructions,
      reasoning: { effort: "high" },
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe('{"detail":"Bad Request"}');
    expect(piModelFailureReason(result)).toBe("provider_bad_request");
    expect(result.diagnostics).toMatchObject([
      {
        type: "okou_model_request",
        details: {
          httpStatus: 400,
          transportAttempts: 1,
          request: {
            api: "openai-codex-responses",
            inputItems: 2,
            tools: 1,
            instructionsBytes: Buffer.byteLength(instructions),
            reasoningEffort: "high",
            wireBodyBytes: wireBytes,
            contentEncoding: "zstd",
          },
          response: { requestId, cfRay },
        },
      },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-");
  },
);

it("correlates a generic HTTP200 stream error without inventing a cause or keeping prior-call IDs", async () => {
  let includeIds = true;
  const uuid = "11111111-2222-4333-8444-555555555555";
  server.use(
    http.post(`${completions.baseUrl}/chat/completions`, () => {
      return new HttpResponse(
        'data: {"id":"private-output-id","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\ndata: [DONE]',
        {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": includeIds ? uuid : "private-unknown-id",
            "cf-ray": includeIds ? cfRay : "private-header",
          },
        },
      );
    }),
  );
  const first = await stream(completions).result();
  expect(first.errorMessage).toBe("Provider finish_reason: error");
  expect(piModelFailureReason(first)).toBeUndefined();
  expect(first.diagnostics).toMatchObject([
    {
      details: {
        httpStatus: 200,
        request: {
          api: "openai-completions",
          inputItems: 1,
          tools: 0,
          contentEncoding: "identity",
        },
        response: { requestId: uuid, cfRay },
      },
    },
  ]);
  includeIds = false;
  const next = await stream(completions).result();
  expect(next.stopReason).toBe("error");
  expect(next.diagnostics?.[0]?.details?.response).toBeUndefined();
  expect(JSON.stringify(next.diagnostics)).not.toContain("private-");
});

it("clears an earlier response ID and status when the final transport attempt fails", async () => {
  let requests = 0;
  server.use(
    http.post(`${completions.baseUrl}/chat/completions`, () => {
      requests++;
      if (requests === 1)
        return HttpResponse.json(
          { error: { message: "temporarily unavailable" } },
          {
            status: 503,
            headers: { "x-request-id": requestId, "cf-ray": cfRay },
          },
        );
      return HttpResponse.error();
    }),
  );
  const result = await stream(completions, {
    maxRetries: 1,
    maxRetryDelayMs: 1,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(requests).toBe(2);
  const details = result.diagnostics?.[0]?.details;
  expect(details).toMatchObject({
    transportAttempts: 2,
    request: { api: "openai-completions" },
    transportFailure: { phase: "request" },
  });
  expect(details?.httpStatus).toBeUndefined();
  expect(details?.response).toBeUndefined();
});
