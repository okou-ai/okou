import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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

/**
 * The provider body from the incident in #35577. It carries no status, no
 * provider error code, and none of the text the retry patterns recognize.
 */
const INCIDENT_BODY = {
  detail: "Unable to verify Daybreak Blue access. Please try again.",
};

const queueTimeout =
  "We were unable to start processing your request within the 900-second timeout limit. Please try again later.";

const route = {
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5.6-terra",
  apiKey: "synthetic-token",
  accountId: "synthetic-account",
  dialect: "openai-codex-responses",
  transport: "sse",
} as const;
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
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
      .join("")
      .trimEnd(),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** One model turn through the production route, without any session budget. */
function turn() {
  const model = resolvePiAgentModel(route);
  if (!model) throw new Error("Codex model is required");
  return piAgentStreamForConfig(route)(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    }),
    { apiKey: route.apiKey },
  );
}

/** A session carrying the retry budget the classifier decides to spend. */
async function session() {
  const directory = await mkdtemp(join(tmpdir(), "pi-structured-retry-"));
  onTestFinished(() => {
    return rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
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
  const retries: { attempt: number; maxAttempts: number }[] = [];
  const answers: AssistantMessage[] = [];
  created.session.subscribe((event) => {
    if (event.type === "auto_retry_start")
      retries.push({ attempt: event.attempt, maxAttempts: event.maxAttempts });
    if (event.type === "message_end" && event.message.role === "assistant")
      answers.push(event.message);
  });
  return { created, retries, answers };
}

describe("Codex structured retry classification", () => {
  it("retries a provider-authored 503 the text classifier cannot read", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return requests === 1
          ? HttpResponse.json(INCIDENT_BODY, { status: 503 })
          : successResponse();
      }),
    );
    const { created, retries, answers } = await session();
    await created.session.prompt("hello");
    expect(requests).toBe(2);
    expect(retries).toStrictEqual([{ attempt: 1, maxAttempts: 2 }]);
    expect(answers.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it("exhausts the session budget and preserves the 503 classification", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return HttpResponse.json(INCIDENT_BODY, { status: 503 });
      }),
    );
    const { created, retries, answers } = await session();
    await created.session.prompt("hello");
    expect(requests).toBe(3);
    expect(retries).toStrictEqual([
      { attempt: 1, maxAttempts: 2 },
      { attempt: 2, maxAttempts: 2 },
    ]);
    const final = answers.at(-1);
    if (!final) throw new Error("Missing terminal assistant answer");
    expect(final).toMatchObject({
      stopReason: "error",
      errorMessage: JSON.stringify(INCIDENT_BODY),
      diagnostics: [
        {
          type: "okou_model_request",
          details: {
            httpStatus: 503,
            transportAttempts: 1,
            failureReason: "provider_server_error",
          },
        },
      ],
    });
    expect(projectPiApiAssistantMessage(final).failureReason).toBe(
      "provider_server_error",
    );
  });

  // A terminal condition in the provider body outranks the transport status, so
  // none of these may become retryable on a 429 or 503 alone.
  it.each([
    {
      reason: "provider_insufficient_credits",
      status: 429,
      body: { error: { code: "insufficient_quota", message: "No quota left" } },
    },
    {
      reason: "usage_limit",
      status: 429,
      body: { error: { type: "usage_limit_reached", plan_type: "Go" } },
    },
    {
      reason: "invalid_api_key",
      status: 401,
      body: { error: { code: "invalid_api_key", message: "Bad key" } },
    },
    {
      reason: "context_window_exceeded",
      status: 400,
      body: {
        error: { code: "context_length_exceeded", message: "Prompt too long" },
      },
    },
    {
      reason: "provider_queue_timeout",
      status: 503,
      body: { error: { code: "server_error", message: queueTimeout } },
    },
    // A transient reason whose body still names billing exhaustion: the
    // terminal text guard runs first and keeps the whole message terminal.
    {
      reason: "provider_server_error",
      status: 503,
      body: {
        error: { code: "server_error", message: "billing subsystem offline" },
      },
    },
  ])(
    "never retries $reason behind HTTP $status",
    async ({ status, body, reason }) => {
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return HttpResponse.json(body, { status });
        }),
      );
      const result = await retryAssistantCall(
        () => {
          return turn().result();
        },
        { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        undefined,
      );
      expect(requests).toBe(1);
      expect(result.stopReason).toBe("error");
      expect(result.diagnostics).toMatchObject([
        { type: "okou_model_request", details: { failureReason: reason } },
      ]);
    },
  );

  // Messages that carry no model-request diagnostic — a native route, or any
  // caller outside this runtime — must still be judged exactly as before.
  it.each([
    { retried: true, errorMessage: "provider HTTP 503: no healthy upstream" },
    { retried: false, errorMessage: JSON.stringify(INCIDENT_BODY) },
  ])(
    "leaves text classification deciding an undiagnosed failure (retried=$retried)",
    async ({ retried, errorMessage }) => {
      let calls = 0;
      const result = await retryAssistantCall(
        () => {
          calls++;
          return Promise.resolve({
            ...fauxAssistantMessage(""),
            stopReason: "error" as const,
            errorMessage,
          });
        },
        { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        undefined,
      );
      expect(calls).toBe(retried ? 3 : 1);
      expect(result.errorMessage).toBe(errorMessage);
    },
  );
});

describe("Codex transport retry policy", () => {
  it("makes a single transport attempt for a persistent 503", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return HttpResponse.json(INCIDENT_BODY, { status: 503 });
      }),
    );
    const result = await turn().result();
    expect(requests).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.diagnostics).toMatchObject([
      {
        type: "okou_model_request",
        details: {
          httpStatus: 503,
          transportAttempts: 1,
          failureReason: "provider_server_error",
        },
      },
    ]);
  });

  it("never retries a terminal usage limit and keeps its friendly message", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return HttpResponse.json(
          {
            error: {
              type: "GoUsageLimitError",
              plan_type: "Go",
              message: "Monthly usage limit reached",
            },
          },
          { status: 429 },
        );
      }),
    );
    const result = await turn().result();
    expect(requests).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "You have hit your ChatGPT usage limit (go plan).",
    );
  });

  it("leaves an ordinary successful turn on a single attempt", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return successResponse();
      }),
    );
    const result = await turn().result();
    expect(requests).toBe(1);
    expect(result.stopReason).toBe("stop");
    expect(result.diagnostics).toBeUndefined();
  });
});
