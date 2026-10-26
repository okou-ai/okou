import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { piAgentStreamForConfig } from "./model";
import { resolvePiAgentModel } from "./model-catalog";
import { piModelFailureReason } from "./model-request-diagnostics";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import contentFilter from "./test/fixtures/pi-content-filter.json";

const route = {
  provider: "openrouter",
  baseUrl: "https://content-filter.test/v1",
  model: "@preset/okou-1-0",
  catalogModel: "okou-1.0",
  apiKey: "synthetic-token",
  dialect: "openai-completions",
  transport: "sse",
} as const;
const endpoint = `${route.baseUrl}/chat/completions`;
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

function completionResponse(finishReason: string, text?: string) {
  const base = {
    id: "chatcmpl_synthetic",
    object: "chat.completion.chunk",
    model: route.model,
  };
  const chunks = [
    ...(text === undefined
      ? []
      : [
          {
            ...base,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          },
        ]),
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    },
  ];
  return new HttpResponse(
    chunks
      .map((chunk) => {
        return `data: ${JSON.stringify(chunk)}\n\n`;
      })
      // End the final SSE frame at EOF so the response body is fully drained.
      .join("") + "data: [DONE]",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function stream() {
  const model = resolvePiAgentModel(route);
  if (!model) throw new Error("Completions model is required");
  return piAgentStreamForConfig(route)(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    }),
    { apiKey: route.apiKey },
  );
}

describe("Pi provider content-filter terminal results", () => {
  it.each(["events", "result"])(
    "preserves the shared failed-result fixture via %s",
    async (consumer) => {
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return completionResponse("content_filter");
        }),
      );
      const response = stream();
      if (consumer === "result") {
        await expect(response.result()).resolves.toMatchObject(contentFilter);
      }
      const terminal = [];
      for await (const event of response) {
        if (event.type === "error") terminal.push(event.error);
      }
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject(contentFilter);
      const result = await response.result();
      expect(piModelFailureReason(result)).toBe("safety_policy_refusal");
      expect(result.diagnostics).toHaveLength(1);
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        contentFilter.errorMessage,
      );
      expect(requests).toBe(1);
    },
  );

  it.each([
    { finishReason: "stop", stopReason: "stop", reason: undefined },
    {
      finishReason: "length",
      stopReason: "length",
      reason: "output_token_limit",
    },
  ])(
    "keeps successful $finishReason output containing the refusal text",
    async ({ finishReason, stopReason, reason }) => {
      server.use(
        http.post(endpoint, () => {
          return completionResponse(finishReason, contentFilter.errorMessage);
        }),
      );
      const result = await stream().result();
      expect(result.stopReason).toBe(stopReason);
      expect(result.content).toMatchObject([
        { type: "text", text: contentFilter.errorMessage },
      ]);
      expect(result.diagnostics).toBeUndefined();
      expect(piModelFailureReason(result)).toBe(reason);
    },
  );

  it.each([
    { outcome: "content_filter", reason: "safety_policy_refusal", retries: 0 },
    { outcome: "network_error", reason: undefined, retries: 2 },
    { outcome: "http_503", reason: "provider_server_error", retries: 2 },
  ])(
    "preserves the native session retry policy for $outcome",
    async ({ outcome, reason, retries }) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-content-filter-"));
      onTestFinished(() => {
        return rm(directory, { recursive: true, force: true });
      });
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
          compaction: { enabled: false },
        }),
      );
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return outcome === "http_503"
            ? HttpResponse.json(
                { error: { message: "Service unavailable" } },
                { status: 503 },
              )
            : completionResponse(outcome);
        }),
      );
      const created = await createPiAgentSessionForRuntime({
        cwd: directory,
        agentDir: directory,
        sessionManager: SessionManager.inMemory(directory),
        model: route,
        appendSystemPrompt: null,
      });
      onTestFinished(() => {
        return created.session.dispose();
      });
      const attempts: number[] = [];
      created.session.subscribe((event) => {
        if (event.type === "auto_retry_start") attempts.push(event.attempt);
      });
      await created.session.prompt("hello");
      const final = created.session.messages.at(-1);
      if (!final || final.role !== "assistant") {
        throw new Error("Missing terminal assistant result");
      }
      expect(final.stopReason).toBe("error");
      expect(piModelFailureReason(final)).toBe(reason);
      expect(requests).toBe(1 + retries);
      expect(attempts).toStrictEqual(retries === 0 ? [] : [1, 2]);
      expect(final.diagnostics).toMatchObject([
        {
          type: "okou_model_request",
          details: {
            httpStatus: outcome === "http_503" ? 503 : 200,
            transportAttempts: 1,
          },
        },
      ]);
    },
  );
});
