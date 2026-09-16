import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
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
import { projectPiApiAssistantMessage } from "./api-turn";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { createPiAgentSessionForRuntime } from "./session-runtime";

const queueTimeout =
  "We were unable to start processing your request within the 900-second timeout limit. Please try again later.";
const route = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  apiKey: "synthetic-token",
  dialect: "openai-responses",
  transport: "sse",
} as const;
const endpoint = "https://api.deepseek.com/responses";
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

function sse(events: unknown[]) {
  return new HttpResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            events
              .map((event) => {
                return `data: ${JSON.stringify(event)}\n\n`;
              })
              .join(""),
          ),
        );
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function expiredResponse() {
  return sse([
    {
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "server_error", message: queueTimeout },
      },
    },
  ]);
}

function completedResponse(text = "Recovered") {
  const item = {
    type: "message",
    id: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function stream(signal?: AbortSignal) {
  const model = resolvePiAgentModel(route);
  if (!model) throw new Error("Expected the pinned DeepSeek model");
  return piAgentStreamForConfig(route)(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] },
    { apiKey: route.apiKey, maxRetries: 3, signal },
  );
}

async function session() {
  const directory = await mkdtemp(join(tmpdir(), "pi-queue-expiry-"));
  onTestFinished(() => {
    return rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } }),
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
  return { ...created, directory };
}

describe("provider-declared queue expiry", () => {
  it.each(["stream", "json", "text", "prefixed text", "unknown code"] as const)(
    "stops both retry layers for a %s failure",
    async (kind) => {
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          if (kind === "stream") return expiredResponse();
          const init = {
            status: 503,
            headers: { "x-should-retry": "true", "retry-after-ms": "1" },
          };
          return kind === "json" || kind === "unknown code"
            ? HttpResponse.json(
                {
                  error: {
                    code: kind === "json" ? "server_error" : "queue_expired",
                    message: queueTimeout,
                  },
                },
                init,
              )
            : new HttpResponse(
                kind === "prefixed text"
                  ? `server_error: ${queueTimeout}`
                  : queueTimeout,
                init,
              );
        }),
      );
      // The same pinned helper owns native summary retries. Each produce call
      // goes through the real adapter with inner transport retries enabled.
      const result = await retryAssistantCall(
        () => {
          return stream().result();
        },
        { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        undefined,
      );
      expect(requests).toBe(1);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(queueTimeout);
      expect(result.diagnostics).toMatchObject([
        {
          type: "okou_model_request",
          details: {
            httpStatus: kind === "stream" ? 200 : 503,
            transportAttempts: 1,
            failureReason: "provider_queue_timeout",
          },
        },
      ]);
      expect(projectPiApiAssistantMessage(result).failureReason).toBe(
        "provider_queue_timeout",
      );
      expect(JSON.stringify(result.diagnostics)).not.toContain(queueTimeout);
    },
  );

  it("preserves diagnosis through stream iteration and result without duplicate metadata", async () => {
    server.use(http.post(endpoint, expiredResponse));
    const response = stream();
    const failures = [];
    for await (const event of response) {
      if (event.type === "error") failures.push(event.error);
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]?.diagnostics?.[0]?.details?.failureReason).toBe(
      "provider_queue_timeout",
    );
    expect((await response.result()).diagnostics).toHaveLength(1);
  });

  it("stops transport retries when expiry follows a transient failure", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return HttpResponse.json(
          {
            error: {
              code: "server_error",
              message: requests === 1 ? "Service unavailable" : queueTimeout,
            },
          },
          { status: 503, headers: { "retry-after-ms": "1" } },
        );
      }),
    );
    const result = await stream().result();
    expect(requests).toBe(2);
    expect(result.diagnostics).toMatchObject([
      {
        details: {
          httpStatus: 503,
          transportAttempts: 2,
          failureReason: "provider_queue_timeout",
        },
      },
    ]);
  });

  it("retains transport recovery for a specific rate-limit code with contradictory text", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        return ++requests === 1
          ? HttpResponse.json(
              { error: { code: "rate_limit_exceeded", message: queueTimeout } },
              { status: 429, headers: { "retry-after-ms": "1" } },
            )
          : completedResponse();
      }),
    );
    const result = await stream().result();
    expect(requests).toBe(2);
    expect(result.stopReason).toBe("stop");
  });

  it.each([false, true])(
    "stops native session retries, including after a prior transient (prior=%s)",
    async (prior) => {
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return prior && requests === 1
            ? HttpResponse.json(
                { error: { message: "Service unavailable" } },
                { status: 503 },
              )
            : expiredResponse();
        }),
      );
      const created = await session();
      const settled: unknown[] = [];
      created.session.subscribe((event) => {
        if (event.type === "agent_settled") settled.push(event);
      });
      await created.session.prompt("finish this input");
      expect(requests).toBe(prior ? 2 : 1);
      expect(settled).toHaveLength(1);
      expect(created.session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "error",
        diagnostics: [
          {
            details: {
              transportAttempts: 1,
              failureReason: "provider_queue_timeout",
            },
          },
        ],
      });
    },
  );

  it("allows independently queued input to recover after queue expiry", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        return ++requests === 1 ? expiredResponse() : completedResponse();
      }),
    );
    const created = await session();
    let queued = false;
    created.session.agent.subscribe(async (event) => {
      if (event.type === "agent_end" && !queued) {
        queued = true;
        await created.session.followUp("a separate accepted input");
      }
    });
    await created.session.prompt("first input");
    expect(requests).toBe(2);
    expect(created.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(created.session.messages.at(-1)).not.toHaveProperty("diagnostics");
  });

  it("preserves a completed tool effect without replaying it after expiry", async () => {
    let requests = 0;
    const item = {
      type: "function_call",
      id: "tool",
      call_id: "effect",
      name: "write",
      arguments: JSON.stringify({ path: "queue-effect.txt", content: "x" }),
      status: "completed",
    };
    server.use(
      http.post(endpoint, () => {
        if (++requests > 1) return expiredResponse();
        return sse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "response",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      }),
    );
    const created = await session();
    await created.session.prompt("perform the effect once");
    expect(
      await readFile(join(created.directory, "queue-effect.txt"), "utf8"),
    ).toBe("x");
    expect(requests).toBe(2);
    expect(
      created.session.messages.filter((message) => {
        return message.role === "toolResult";
      }),
    ).toMatchObject([{ toolName: "write", isError: false }]);
    expect(created.session.messages.at(-1)).toMatchObject({
      stopReason: "error",
    });
  });

  it("does not classify a successful answer quoting the error", async () => {
    server.use(
      http.post(endpoint, () => {
        return completedResponse(queueTimeout);
      }),
    );
    const result = await stream().result();
    expect(result.stopReason).toBe("stop");
    expect(projectPiApiAssistantMessage(result).failureReason).toBeUndefined();
    expect(result.diagnostics).toBeUndefined();
  });

  it("preserves cancellation instead of fabricating queue expiry or retrying", async () => {
    const controller = new AbortController();
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        controller.abort();
        return expiredResponse();
      }),
    );
    const result = await stream(controller.signal).result();
    expect(requests).toBe(1);
    expect(result.stopReason).toBe("aborted");
    expect(result.diagnostics).toBeUndefined();
  });
});
