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

import { piModelFailureReason } from "./model-request-diagnostics";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import cyberSafetyRefusal from "./test/fixtures/codex-cyber-safety-refusal.json";

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
  model: "gpt-6-luna",
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

function successResponse(text?: string) {
  const item = {
    id: "synthetic-message",
    type: "message",
    role: "assistant",
    status: "completed",
    content:
      text === undefined
        ? []
        : [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "synthetic-response",
    status: "completed",
    output: text === undefined ? [] : [item],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  };
  return new HttpResponse(
    [
      {
        type: "response.created",
        response: { ...response, status: "in_progress" },
      },
      ...(text === undefined
        ? []
        : [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [], status: "in_progress" },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              item_id: item.id,
              delta: text,
            },
            { type: "response.output_item.done", output_index: 0, item },
          ]),
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
async function session(compaction?: {
  enabled: boolean;
  keepRecentTokens: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-structured-retry-"));
  onTestFinished(() => {
    return rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      compaction,
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
    expect(piModelFailureReason(final)).toBe("provider_server_error");
  });

  it("keeps native text retries for an unclassified HTTP-200 failure", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        return requests === 1
          ? new HttpResponse(
              `data: ${JSON.stringify({ type: "error", message: "socket hang up" })}`,
              { headers: { "content-type": "text/event-stream" } },
            )
          : successResponse();
      }),
    );
    const { created, retries, answers } = await session();
    await created.session.prompt("hello");
    expect(requests).toBe(2);
    expect(retries).toStrictEqual([{ attempt: 1, maxAttempts: 2 }]);
    expect(answers).toHaveLength(2);
    const first = answers[0];
    if (!first) throw new Error("Missing first assistant answer");
    expect(first).toMatchObject({
      stopReason: "error",
      diagnostics: [
        {
          type: "okou_model_request",
          details: { httpStatus: 200, transportAttempts: 1 },
        },
      ],
    });
    expect(piModelFailureReason(first)).toBeUndefined();
    expect(answers.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it("keeps a genuine context overflow on the compact-and-retry path", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests++;
        if (requests === 2) {
          return HttpResponse.json(
            {
              error: {
                code: "context_length_exceeded",
                message: "context_length_exceeded",
              },
            },
            { status: 400 },
          );
        }
        return successResponse(
          requests === 3 || requests === 4
            ? "The prior turn completed."
            : "completed",
        );
      }),
    );
    const { created, retries, answers } = await session({
      enabled: true,
      keepRecentTokens: 1,
    });
    await created.session.prompt("a prior turn");
    await created.session.prompt("hello");
    // Warmup, overflow, history and split-turn summaries, then continuation.
    expect(requests).toBe(5);
    expect(retries).toStrictEqual([]);
    expect(answers).toHaveLength(3);
    const overflow = answers[1];
    if (!overflow) throw new Error("Missing context overflow answer");
    expect(piModelFailureReason(overflow)).toBe("context_window_exceeded");
    expect(answers.at(-1)).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "completed" }],
    });
    expect(
      created.session.sessionManager.getBranch().filter((entry) => {
        return entry.type === "compaction";
      }),
    ).toHaveLength(1);
  });

  it.each([200, 503])(
    "does not compact or replay a cybersecurity refusal with context-like link text behind HTTP %s",
    async (status) => {
      const message = cyberSafetyRefusal.errorMessage
        .replace(
          "https://example.invalid/policy",
          "https://example.invalid/context_length_exceeded",
        )
        .slice("Codex error: ".length);
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          if (requests === 1) return successResponse();
          return status === 200
            ? new HttpResponse(
                `data: ${JSON.stringify({ type: "error", message })}`,
                { headers: { "content-type": "text/event-stream" } },
              )
            : HttpResponse.json({ error: { message } }, { status });
        }),
      );
      const { created, retries, answers } = await session({
        enabled: true,
        keepRecentTokens: 1,
      });
      await created.session.prompt("a prior turn");
      await created.session.prompt("hello");
      expect(requests).toBe(2);
      expect(retries).toStrictEqual([]);
      expect(answers).toHaveLength(2);
      const final = answers.at(-1);
      if (!final) throw new Error("Missing terminal assistant answer");
      expect(final.stopReason).toBe("error");
      expect(final.errorMessage).toContain(message);
      expect(piModelFailureReason(final)).toBe("safety_policy_refusal");
      expect(
        created.session.sessionManager.getBranch().some((entry) => {
          return entry.type === "context_edit" || entry.type === "compaction";
        }),
      ).toBe(false);
    },
  );

  it.each(
    [200, 503].flatMap((status) => {
      return [
        "https://example.invalid/policy",
        "https://example.invalid/503",
        "https://example.invalid/policy?request=500",
        "<redacted:url>",
      ].map((link) => {
        return { status, link };
      });
    }),
  )(
    "keeps the full cybersecurity refusal terminal behind HTTP $status with $link",
    async ({ status, link }) => {
      const refusal = {
        ...cyberSafetyRefusal,
        errorMessage: cyberSafetyRefusal.errorMessage.replace(
          "https://example.invalid/policy",
          link,
        ),
      };
      const message = refusal.errorMessage.slice("Codex error: ".length);
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests++;
          return status === 200
            ? new HttpResponse(
                `data: ${JSON.stringify({ type: "error", message })}`,
                { headers: { "content-type": "text/event-stream" } },
              )
            : HttpResponse.json({ error: { message } }, { status });
        }),
      );
      const { created, retries, answers } = await session();
      await created.session.prompt("hello");
      expect(requests).toBe(1);
      expect(retries).toStrictEqual([]);
      expect(answers).toHaveLength(1);
      const final = answers.at(-1);
      if (!final) throw new Error("Missing terminal assistant answer");
      expect(final).toMatchObject({
        stopReason: "error",
        diagnostics: [
          {
            type: "okou_model_request",
            details: {
              httpStatus: status,
              transportAttempts: 1,
              failureReason: "safety_policy_refusal",
            },
          },
        ],
      });
      expect(piModelFailureReason(final)).toBe("safety_policy_refusal");
      expect(final.errorMessage).toContain(message);
      if (status === 200) expect(final).toMatchObject(refusal);
    },
  );

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
