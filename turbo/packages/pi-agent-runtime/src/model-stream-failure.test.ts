import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { piModelFailureReason } from "./model-request-diagnostics";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import upstreamStreamError from "./test/fixtures/pi-upstream-stream-error.json";
import upstreamUnicodeStreamError from "./test/fixtures/pi-upstream-unicode-stream-error.json";

const route = {
  provider: "openrouter",
  baseUrl: "https://stream-error.test/v1",
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

function chunk(choice: Record<string, unknown>) {
  return {
    id: "synthetic-completion",
    object: "chat.completion.chunk",
    model: route.model,
    choices: [{ index: 0, delta: {}, ...choice }],
  };
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function response(args: {
  error?: Record<string, unknown>;
  nativeFinishReason?: string;
  finishReason?: string;
  text?: string;
  topLevel?: boolean;
}) {
  const finishReason = args.finishReason ?? "error";
  const terminal = {
    finish_reason: finishReason,
    native_finish_reason: args.nativeFinishReason,
  };
  return new HttpResponse(
    (args.text === undefined
      ? ""
      : sse(chunk({ delta: { content: args.text }, finish_reason: null }))) +
      sse(
        args.topLevel
          ? { ...chunk(terminal), error: args.error }
          : chunk({ ...terminal, error: args.error }),
      ) +
      // OpenRouter repeats the terminal reason in its accounting-only chunk.
      sse({
        ...chunk(terminal),
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }) +
      "data: [DONE]",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function stream(options?: SimpleStreamOptions) {
  const model = resolvePiAgentModel(route);
  if (!model) throw new Error("Completions model is required");
  return piAgentStreamForConfig(route)(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    }),
    { ...options, apiKey: route.apiKey },
  );
}

async function session() {
  const directory = await mkdtemp(join(tmpdir(), "pi-stream-error-"));
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
  return created.session;
}

describe("Chat Completions upstream stream failures", () => {
  it.each(["events", "result"])(
    "preserves the upstream error through %s without publishing payload metadata",
    async (consumer) => {
      server.use(
        http.post(endpoint, () => {
          return response({
            error: {
              code: 502,
              message: "Specific upstream generation failure",
              metadata: { raw: "private-payload-sentinel" },
              output: "private-answer-sentinel",
            },
            nativeFinishReason: "upstream_failed",
          });
        }),
      );
      const source = stream();
      if (consumer === "result") await source.result();
      const errors = [];
      for await (const event of source) {
        if (event.type === "error") errors.push(event.error);
      }
      expect(errors).toHaveLength(1);
      const result = await source.result();
      expect(result).toMatchObject(upstreamStreamError);
      expect(result.stopReason).toBe("error");
      expect(JSON.parse(result.errorMessage ?? "")).toEqual({
        error: { code: 502, message: "Specific upstream generation failure" },
        native_finish_reason: "upstream_failed",
      });
      expect(errors[0]).toMatchObject(upstreamStreamError);
      expect(piModelFailureReason(result)).toBe("provider_server_error");
      expect(result.diagnostics).toMatchObject([
        {
          type: "okou_model_request",
          details: { httpStatus: 200, transportAttempts: 1 },
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("private-payload-sentinel");
      expect(JSON.stringify(result)).not.toContain("private-answer-sentinel");
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        "Specific upstream generation failure",
      );
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        "upstream_failed",
      );
    },
  );

  it("keeps top-level SDK error messages and classifies their numeric provider code", async () => {
    server.use(
      http.post(endpoint, () => {
        return response({
          topLevel: true,
          error: {
            code: 429,
            message: "Specific upstream rate failure",
            metadata: { raw: "private-top-level-sentinel" },
          },
        });
      }),
    );
    const result = await stream().result();
    expect(result.errorMessage).toContain("Specific upstream rate failure");
    expect(result.errorMessage).not.toContain("private-top-level-sentinel");
    expect(piModelFailureReason(result)).toBe("provider_rate_limited");
    expect(result.diagnostics).toMatchObject([
      { details: { httpStatus: 200, transportAttempts: 1 } },
    ]);
  });

  it("bounds unknown provider detail while keeping it out of diagnostics", async () => {
    const message = "Specific unknown provider detail ".repeat(200);
    server.use(
      http.post(endpoint, () => {
        return response({ error: { code: "private-provider-code", message } });
      }),
    );
    const result = await stream().result();
    expect(JSON.parse(result.errorMessage ?? "")).toMatchObject({
      error: {
        code: "private-provider-code",
        message: expect.stringMatching(/^Specific unknown provider detail /u),
      },
    });
    expect(result.errorMessage?.length).toBeLessThan(2_500);
    expect(piModelFailureReason(result)).toBeUndefined();
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "private-provider-code",
    );
  });

  it("keeps bounded upstream error text valid for the Guest JSON parser", async () => {
    const message =
      "Specific upstream generation failure ".padEnd(1999, "x") +
      "😀 trailing detail";
    server.use(
      http.post(endpoint, () => {
        return response({
          error: { code: 502, message },
          nativeFinishReason: "upstream_failed",
        });
      }),
    );
    const result = await stream().result();
    expect(result).toMatchObject(upstreamUnicodeStreamError);
    expect(JSON.parse(result.errorMessage ?? "")).toMatchObject({
      error: { message: expect.stringMatching(/^[^\p{Surrogate}]*$/u) },
    });
    expect(piModelFailureReason(result)).toBe("provider_server_error");
  });

  it("retains a native-only failure without inventing a semantic classification", async () => {
    server.use(
      http.post(endpoint, () => {
        return response({ nativeFinishReason: "UNSPECIFIED_ERROR" });
      }),
    );
    const result = await stream().result();
    expect(JSON.parse(result.errorMessage ?? "")).toMatchObject({
      native_finish_reason: "UNSPECIFIED_ERROR",
    });
    expect(piModelFailureReason(result)).toBeUndefined();
  });

  it("keeps native finish detail out of the existing retry prose matcher", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return response({ nativeFinishReason: "network_error" });
      }),
    );
    const current = await session();
    await current.prompt("hello");
    const final = current.messages.at(-1);
    if (!final || final.role !== "assistant")
      throw new Error("Missing assistant result");
    expect(final.errorMessage).toContain(
      '"native_finish_reason":"network_error"',
    );
    expect(piModelFailureReason(final)).toBeUndefined();
    expect(requests).toBe(1);
  });

  it("keeps existing recovery for actual upstream transport error prose", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return requests === 1
          ? response({ error: { message: "Network error" } })
          : response({ finishReason: "stop", text: "Recovered answer" });
      }),
    );
    const current = await session();
    await current.prompt("hello");
    const final = current.messages.at(-1);
    if (!final || final.role !== "assistant")
      throw new Error("Missing assistant result");
    expect(final.stopReason).toBe("stop");
    expect(final.content).toMatchObject([
      { type: "text", text: "Recovered answer" },
    ]);
    expect(requests).toBe(2);
  });

  it.each([
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "subscription_sharing_usage_limit_exceeded",
  ])("keeps the existing terminal veto for %s", async (type) => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return response({ error: { type, message: "Rate limit exceeded" } });
      }),
    );
    const current = await session();
    await current.prompt("hello");
    const final = current.messages.at(-1);
    if (!final || final.role !== "assistant")
      throw new Error("Missing assistant result");
    expect(final.stopReason).toBe("error");
    expect(JSON.parse(final.errorMessage ?? "")).toMatchObject({
      error: { type, message: "Rate limit exceeded" },
    });
    expect(requests).toBe(1);
  });

  it("keeps a specific rate-limit code ahead of queue-like prose", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return requests === 1
          ? response({
              error: {
                code: "rate_limit_exceeded",
                message:
                  "We were unable to start processing your request within the 900-second timeout limit. Please try again later.",
              },
            })
          : response({ finishReason: "stop", text: "Recovered answer" });
      }),
    );
    const current = await session();
    await current.prompt("hello");
    const final = current.messages.at(-1);
    if (!final || final.role !== "assistant")
      throw new Error("Missing assistant result");
    expect(final.stopReason).toBe("stop");
    expect(final.content).toMatchObject([
      { type: "text", text: "Recovered answer" },
    ]);
    expect(requests).toBe(2);
  });

  it("keeps successful output containing provider error text", async () => {
    const text = "Provider finish_reason: error is an example.";
    server.use(
      http.post(endpoint, () => {
        return response({
          finishReason: "stop",
          text,
          error: { code: "content_policy_violation", message: "Example only" },
        });
      }),
    );
    const result = await stream().result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text }]);
    expect(result.diagnostics).toBeUndefined();
  });

  it("keeps cancellation authoritative after a provider failure event", async () => {
    const controller = new AbortController();
    server.use(
      http.post(endpoint, () => {
        return response({ error: { code: 503, message: "Provider failure" } });
      }),
    );
    const result = await stream({
      signal: controller.signal,
      onProviderStreamEvent: () => {
        controller.abort();
      },
    }).result();
    expect(result.stopReason).toBe("aborted");
    expect(piModelFailureReason(result)).toBeUndefined();
  });

  it("preserves a later body failure instead of an earlier provider reason", async () => {
    let observedTerminal = false;
    let observeTerminal!: () => void;
    const terminalObserved = new Promise<void>((resolve) => {
      observeTerminal = resolve;
    });
    server.use(
      http.post(endpoint, () => {
        let emitted = false;
        return new HttpResponse(
          new ReadableStream({
            async pull(controller) {
              if (emitted) {
                await terminalObserved;
                controller.error(new Error("Later response body failure"));
                return;
              }
              emitted = true;
              controller.enqueue(
                new TextEncoder().encode(
                  sse(
                    chunk({
                      finish_reason: "error",
                      error: { code: 503, message: "Earlier provider failure" },
                    }),
                  ),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const result = await stream({
      onProviderStreamEvent: () => {
        observedTerminal = true;
        observeTerminal();
      },
    }).result();
    expect(observedTerminal).toBe(true);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Later response body failure");
    expect(piModelFailureReason(result)).toBeUndefined();
  });

  it.each([
    {
      code: 502,
      type: undefined,
      next: "success",
      requests: 2,
      reason: undefined,
    },
    {
      code: 503,
      type: undefined,
      next: "same",
      requests: 3,
      reason: "provider_server_error",
    },
    {
      code: "invalid_api_key",
      type: undefined,
      next: "same",
      requests: 1,
      reason: "invalid_api_key",
    },
    {
      code: 503,
      type: "content_policy_violation",
      next: "same",
      requests: 1,
      reason: "safety_policy_refusal",
    },
    {
      code: "unknown",
      type: undefined,
      next: "same",
      requests: 1,
      reason: undefined,
    },
    {
      code: "rate_limit_private",
      type: undefined,
      next: "same",
      requests: 1,
      reason: undefined,
    },
    {
      code: 502,
      type: undefined,
      next: "generic",
      requests: 2,
      reason: undefined,
    },
  ])(
    "uses existing recovery for $code/$type then $next",
    async ({ code, type, next, requests, reason }) => {
      const requestedModels: unknown[] = [];
      server.use(
        http.post(endpoint, async ({ request }) => {
          const body = await request.json();
          requestedModels.push(
            body && typeof body === "object" && "model" in body
              ? body.model
              : undefined,
          );
          if (requestedModels.length > 1 && next === "success") {
            return response({ finishReason: "stop", text: "Recovered answer" });
          }
          return response({
            error:
              requestedModels.length > 1 && next === "generic"
                ? undefined
                : { code, type, message: "Specific upstream failure" },
          });
        }),
      );
      const current = await session();
      await current.prompt("hello");
      const final = current.messages.at(-1);
      if (!final || final.role !== "assistant")
        throw new Error("Missing assistant result");
      expect(requestedModels).toEqual(
        Array.from({ length: requests }, () => {
          return route.model;
        }),
      );
      expect(final.stopReason).toBe(next === "success" ? "stop" : "error");
      expect(piModelFailureReason(final)).toBe(reason);
      if (next === "success") {
        expect(final.content).toMatchObject([
          { type: "text", text: "Recovered answer" },
        ]);
      }
      if (next === "generic") {
        expect(final.errorMessage).toBe("Provider finish_reason: error");
      }
    },
  );
});
