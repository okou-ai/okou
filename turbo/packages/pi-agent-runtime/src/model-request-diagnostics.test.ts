import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { createPiAgentSessionForRuntime } from "./session-runtime";
import rateLimitMessage from "./test/fixtures/codex-rate-limit.json";
import { projectPiApiAssistantMessage } from "./api-turn";

const route = {
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5.6-terra",
  apiKey: "synthetic-token",
  accountId: "synthetic-account",
  dialect: "openai-codex-responses",
  transport: "sse",
} as const;
const server = setupServer();
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});

function stream(signal?: AbortSignal) {
  const model = resolvePiAgentModel(route);
  if (!model) throw new Error("Codex model is required");
  return piAgentStreamForConfig(route)(
    model,
    {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    },
    { apiKey: route.apiKey, signal },
  );
}

function successResponse() {
  const response = {
    id: "synthetic-response",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  };
  return new HttpResponse(
    [
      {
        type: "response.created",
        response: { ...response, status: "in_progress" },
      },
      { type: "response.completed", response },
    ]
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      // Terminate the last SSE frame at EOF so the HTTP body is fully drained.
      .join("")
      .trimEnd(),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("Codex model request diagnostics", () => {
  it("preserves a top-level provider message before the SDK renders HTTP 503", async () => {
    server.use(
      http.post(endpoint, () => {
        return HttpResponse.json(
          {
            message:
              "Our servers are currently overloaded. Please try again later.",
          },
          { status: 503 },
        );
      }),
    );
    const result = await stream().result();
    expect(result.stopReason).toBe("error");
    expect(projectPiApiAssistantMessage(result, 503).failureReason).toBe(
      "provider_overloaded",
    );
  });

  it.each([
    {
      status: 503,
      body: { error: { message: "Service unavailable" } },
      reason: "provider_server_error",
    },
    {
      status: 529,
      body: { error: { message: "Service unavailable" } },
      reason: "provider_overloaded",
    },
    {
      status: 429,
      body: {
        error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" },
      },
      reason: "provider_rate_limited",
    },
    {
      status: 429,
      body: {
        error: { code: "usage_limit_reached", message: "Quota exhausted" },
      },
      reason: "usage_limit",
    },
    {
      status: 429,
      body: { error: { message: "You have hit your ChatGPT usage limit." } },
      reason: "usage_limit",
    },
    {
      status: 401,
      body: {
        error: {
          code: "invalid_api_key",
          message: "Private authentication details",
        },
      },
      reason: "invalid_api_key",
    },
    {
      status: 400,
      body: {
        error: { code: "context_length_exceeded", message: "Private prompt" },
      },
      reason: "context_window_exceeded",
    },
  ])(
    "preserves $reason before SDK error rewriting",
    async ({ status, body, reason }) => {
      server.use(
        http.post(endpoint, () => {
          return HttpResponse.json(body, { status });
        }),
      );
      const result = await stream().result();
      expect(result.stopReason).toBe("error");
      expect(result.diagnostics).toMatchObject([
        {
          details: {
            httpStatus: status,
            transportAttempts: 1,
            failureReason: reason,
          },
        },
      ]);
      expect(projectPiApiAssistantMessage(result, status).failureReason).toBe(
        reason,
      );
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        body.error.message,
      );
    },
  );

  it.each([503, 529])(
    "classifies JSON and opaque HTTP %s consistently",
    async (status) => {
      server.use(
        http.post(endpoint, () => {
          return new HttpResponse("Service unavailable", { status });
        }),
      );
      const result = await stream().result();
      expect(projectPiApiAssistantMessage(result, status).failureReason).toBe(
        status === 529 ? "provider_overloaded" : "provider_server_error",
      );
    },
  );

  it("classifies the production overload after an HTTP 200 stream starts", async () => {
    server.use(
      http.post(endpoint, () => {
        return new HttpResponse(
          `data: ${JSON.stringify({ type: "error", message: "Our servers are currently overloaded. Please try again later." })}`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const result = await stream().result();
    expect(result.errorMessage).toBe(
      "Codex error: Our servers are currently overloaded. Please try again later.",
    );
    expect(projectPiApiAssistantMessage(result, 200).failureReason).toBe(
      "provider_overloaded",
    );
  });

  it.each(["events", "result"])(
    "preserves the shared rate-limit fixture via %s",
    async (consumer) => {
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return HttpResponse.json(
            { detail: "Rate limit exceeded" },
            { status: 429 },
          );
        }),
      );
      const response = stream();
      if (consumer === "result") {
        await expect(response.result()).resolves.toMatchObject(
          rateLimitMessage,
        );
      }
      const terminal = [];
      for await (const event of response) {
        if (event.type === "error") terminal.push(event.error);
      }
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject(rateLimitMessage);
      expect((await response.result()).diagnostics).toHaveLength(1);
      expect(requests).toBe(1);
    },
  );

  it.each([200, 401])(
    "records observed HTTP %s independently of rate-limit prose",
    async (status) => {
      server.use(
        http.post(endpoint, () => {
          return HttpResponse.json(
            { detail: "Rate limit exceeded" },
            { status },
          );
        }),
      );
      expect((await stream().result()).diagnostics).toMatchObject([
        { details: { httpStatus: status, transportAttempts: 1 } },
      ]);
    },
  );

  it("does not attach an HTTP failure diagnostic to an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await stream(controller.signal).result();
    expect(result.stopReason).toBe("aborted");
    expect(result.diagnostics).toBeUndefined();
  });

  it("does not retain a previous call's status after a network failure or success", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        if (requests === 1)
          return HttpResponse.json(
            { detail: "Rate limit exceeded" },
            { status: 429 },
          );
        if (requests === 2) return HttpResponse.error();
        return successResponse();
      }),
    );
    expect((await stream().result()).diagnostics).toMatchObject([
      { details: { httpStatus: 429 } },
    ]);
    const failed = await stream().result();
    expect(failed.stopReason).toBe("error");
    expect(failed.diagnostics?.[0]?.details?.httpStatus).toBeUndefined();
    expect(failed.diagnostics?.[0]?.details?.transportAttempts).toBe(1);
    const recovered = await stream().result();
    expect(recovered.stopReason).toBe("stop");
    expect(recovered.diagnostics).toBeUndefined();
    expect(requests).toBe(3);
  });

  it.each([
    { recover: false, followUp: false },
    { recover: true, followUp: false },
    { recover: false, followUp: true },
  ])(
    "preserves native session retry behavior (recover=$recover, followUp=$followUp)",
    async ({ recover, followUp }) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-rate-limit-"));
      onTestFinished(() => {
        return rm(directory, { recursive: true, force: true });
      });
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        }),
      );
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return recover && requests === 2
            ? successResponse()
            : HttpResponse.json(
                { detail: "Rate limit exceeded" },
                { status: 429 },
              );
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
      const retries: unknown[] = [];
      const failures: unknown[] = [];
      let settlements = 0;
      let queuedFollowUp = false;
      created.session.agent.subscribe(async (event) => {
        if (
          followUp &&
          !queuedFollowUp &&
          event.type === "agent_end" &&
          requests === 3
        ) {
          queuedFollowUp = true;
          await created.session.followUp("next input after exhausted retries");
        }
      });
      created.session.subscribe((event) => {
        if (event.type === "auto_retry_start") retries.push(event);
        if (event.type === "agent_settled") settlements++;
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "error"
        )
          failures.push(event.message);
      });
      await created.session.prompt("hello");
      expect(requests).toBe(followUp ? 6 : recover ? 2 : 3);
      expect(settlements).toBe(1);
      expect(retries).toMatchObject(
        (followUp ? [1, 2, 1, 2] : recover ? [1] : [1, 2]).map((attempt) => {
          return { attempt, maxAttempts: 2 };
        }),
      );
      for (const failure of failures)
        expect(failure).toMatchObject(rateLimitMessage);
      const final = created.session.messages.at(-1);
      if (recover) {
        expect(final).toMatchObject({ role: "assistant", stopReason: "stop" });
        expect(final).not.toHaveProperty("diagnostics");
      } else {
        expect(final).toMatchObject(rateLimitMessage);
      }
    },
  );
});
