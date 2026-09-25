import { createRouteMocks } from "./helpers/route-test";
import { randomUUID } from "node:crypto";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  advanceRunActivityClockFixture,
  deleteActiveAgentRunFixture,
  readActiveAgentRunFixture,
} from "../../../test-fixtures/run-activity";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const callbacks = createChatCallbacksApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const completionBody = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});
const evidenceSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  activity: z.array(
    z.object({
      sequence: z.number(),
      index: z.number(),
      kind: z.string(),
      name: z.string(),
      callId: z.string(),
      excerpt: z.string(),
    }),
  ),
});
type Evidence = z.infer<typeof evidenceSchema>;
type TestRun = { runId: string; threadId: string };

function request(
  actor: ApiTestUser,
  run: TestRun,
  options: { signal?: AbortSignal; rethrowErrors?: boolean } = {},
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupApp({
    context,
    routes: chatThreadActivitySummaryRoutes,
    ...options,
  })(chatThreadActivitySummaryContract).summarize({
    headers: { authorization: "Bearer clerk-session" },
    params: { id: run.threadId },
    body: { runId: run.runId },
  });
}
async function summarize(actor: ApiTestUser, run: TestRun) {
  return (await accept(request(actor, run), [200])).body;
}
async function fixture(prompt = "Prepare a launch checklist") {
  const actor = bdd.user();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const group = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  const [{ providerId }, agent] = await Promise.all([
    runs.ensureOrgModelProvider(actor),
    bdd.createAgent(actor, {
      displayName: "Activity summary",
      description: "Activity API integration",
      visibility: "private",
    }),
  ]);
  // The activity suite needs a live Runner claim, not a Pi API-first turn.
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      model: "claude-fable-5-1",
      prompt,
      clientEventId: randomUUID(),
    },
    [201],
  );
  if (sent.status !== 201 || !sent.body.runId) {
    throw new Error("Expected active run");
  }
  const run = { runId: sent.body.runId, threadId: sent.body.threadId };
  await flushWaitUntilForTest();
  await runs.heartbeatRunner(group);
  const claimed = await runs.claimRunnerJob(run.runId);
  await flushWaitUntilForTest();
  return {
    actor,
    run,
    agentId: agent.agentId,
    sandboxToken: claimed.sandboxToken,
    headers: { authorization: `Bearer ${claimed.sandboxToken}` },
  };
}
function provider(
  reply: (
    input: Evidence,
    index: number,
  ) => string | Response | Promise<string | Response> = () => {
    return "Preparing the launch checklist";
  },
) {
  const inputs: Evidence[] = [];
  mockOptionalEnv("OPENROUTER_API_KEY", "activity-test-key");
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request: upstream }) => {
        const body = completionBody.parse(await upstream.json());
        if (
          !body.messages[0]?.content.startsWith(
            "Write three short, distinct, user-visible progress messages",
          )
        ) {
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Existing opening copy" },
              },
            ],
          });
        }
        expect(body.model).toBe("google/gemini-3.8-flash");
        expect(body.max_tokens).toBe(1024);
        const input = evidenceSchema.parse(
          JSON.parse(body.messages[1]!.content),
        );
        inputs.push(input);
        const output = await reply(input, inputs.length);
        return typeof output === "string"
          ? HttpResponse.json({
              choices: [
                { finish_reason: "stop", message: { content: output } },
              ],
            })
          : output;
      },
    ),
  );
  return inputs;
}
function tool(sequenceNumber: number, command = "inspect launch checklist") {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      content: [
        {
          type: "tool_use",
          id: `call-${sequenceNumber}`,
          name: "bash",
          input: { command },
        },
      ],
    },
  };
}

async function deliver(
  f: Awaited<ReturnType<typeof fixture>>,
  events: Parameters<typeof webhooks.requestAgentEvents>[0]["events"],
) {
  await webhooks.requestAgentEvents(
    { runId: f.run.runId, events },
    f.headers,
    [200],
  );
  await flushWaitUntilForTest();
}

const privatePayload = "private-provider-payload";

function completion(content: unknown, finishReason = "stop") {
  return HttpResponse.json({
    choices: [
      {
        finish_reason: finishReason,
        ...(finishReason === "length"
          ? { native_finish_reason: "MAX_TOKENS" }
          : {}),
        message: { content },
      },
    ],
  });
}
// A rejected body stream is the only real transport failure a handler can
// produce; a handler that throws would answer with HTTP 500 instead.
function brokenBody(error: Error) {
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
  );
}
describe("thread activity summary", () => {
  it("enforces run ownership before cache or model exposure", async () => {
    const f = await fixture();
    const inputs = provider();
    await accept(request(bdd.user({ orgId: f.actor.orgId }), f.run), [404]);
    await accept(
      request({ ...f.actor, orgId: `org_${randomUUID()}` }, f.run),
      [404],
    );
    await accept(request(f.actor, { ...f.run, runId: randomUUID() }), [404]);
    expect(inputs).toHaveLength(0);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "available",
    });
    expect(inputs).toHaveLength(1);
  });

  it("returns and caches the complete message batch", async () => {
    const f = await fixture();
    const messages = [
      "Preparing the launch checklist",
      "Reviewing the release evidence",
      "Checking the remaining tasks",
    ];
    const inputs = provider(() => {
      return messages.join("\n");
    });
    const first = await summarize(f.actor, f.run);
    expect(first).toMatchObject({
      status: "available",
      messages: messages.map((text) => {
        return { id: text, text };
      }),
    });
    await expect(summarize(f.actor, f.run)).resolves.toStrictEqual(first);
    expect(inputs).toHaveLength(1);
  });

  it("retains activity for tool output PostgreSQL cannot store verbatim", async () => {
    const f = await fixture();
    const inputs = provider();
    // A runtime can emit a NUL byte or a lone surrogate through a tool
    // argument, and a long tool name can end mid surrogate pair. PostgreSQL
    // rejects every one of those while parsing the jsonb value, which would
    // otherwise drop the whole batch rather than the offending characters.
    const astral = String.fromCodePoint(0x1_f6_00);
    await deliver(f, [
      {
        type: "assistant",
        sequenceNumber: 0,
        message: {
          content: [
            {
              type: "tool_use",
              id: `call-0${astral}`,
              name: `${"n".repeat(99)}${astral}${"tail".repeat(20)}`,
              input: {
                command: `read${String.fromCharCode(0)}binary${String.fromCharCode(0xd8_3d)}`,
              },
            },
          ],
        },
      },
    ]);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "available",
      messages: [
        {
          id: "Preparing the launch checklist",
          text: "Preparing the launch checklist",
        },
      ],
    });
    expect(inputs).toHaveLength(1);
  });

  it("rejects queued and superseded run identities before cached or model output", async () => {
    const f = await fixture();
    const inputs = provider();
    await summarize(f.actor, f.run);
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const queued = await chat.requestSendEvent(
      f.actor,
      { agentId: f.agentId, prompt: "Wait for capacity" },
      [201],
    );
    if (queued.status !== 201 || !queued.body.runId) {
      throw new Error("Expected queued run identity");
    }
    expect(queued.body.status).toBe("queued");
    await expect(
      summarize(f.actor, {
        runId: queued.body.runId,
        threadId: queued.body.threadId,
      }),
    ).resolves.toMatchObject({ status: "ineligible", messages: [] });
    expect(inputs).toHaveLength(1);
    await runs.requestCancelRun(f.actor, queued.body.runId, [200]);
    await runs.requestCancelRun(f.actor, f.run.runId, [200]);
    await webhooks.requestAgentComplete(
      { runId: f.run.runId, exitCode: 1, error: "Run cancelled" },
      f.headers,
      [200],
    );
    await flushWaitUntilForTest();
    const next = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        threadId: f.run.threadId,
        prompt: "Prepare the next checklist",
      },
      [201],
    );
    if (next.status !== 201 || !next.body.runId) {
      throw new Error("Expected replacement run identity");
    }
    await flushWaitUntilForTest();
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "ineligible",
      messages: [],
    });
    await expect(
      summarize(f.actor, {
        runId: next.body.runId,
        threadId: next.body.threadId,
      }),
    ).resolves.toMatchObject({ status: "available", runId: next.body.runId });
    expect(inputs).toHaveLength(2);
  });

  it("captures public tools before results after commentary, without demand generation or history writes", async () => {
    const f = await fixture();
    const inputs = provider();
    await deliver(f, [
      {
        type: "assistant",
        sequenceNumber: 0,
        message: {
          content: [
            { type: "text", text: "I will inspect the launch materials" },
            { type: "thinking", thinking: "PRIVATE_REASONING" },
          ],
        },
      },
      {
        type: "assistant",
        sequenceNumber: 1,
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "search",
              input: { query: "launch checklist", api_key: "PRIVATE_KEY" },
            },
          ],
        },
      },
    ]);
    expect(inputs).toHaveLength(0);
    const before = await chat.listThreadEvents(f.actor, f.run.threadId);
    const first = await summarize(f.actor, f.run);
    expect(first).toMatchObject({
      status: "available",
      messages: [
        {
          id: "Preparing the launch checklist",
          text: "Preparing the launch checklist",
        },
      ],
    });
    expect(JSON.stringify(inputs)).toContain("launch checklist");
    expect(JSON.stringify(inputs)).toContain("search");
    expect(JSON.stringify(inputs)).not.toContain("PRIVATE_");
    await expect(summarize(f.actor, f.run)).resolves.toStrictEqual(first);
    const after = await chat.listThreadEvents(f.actor, f.run.threadId);
    expect(after.events).toStrictEqual(before.events);
    expect(inputs).toHaveLength(1);
  });

  it("merges late evidence deterministically, bounds payloads, and ignores duplicates and usage", async () => {
    const f = await fixture();
    const inputs = provider();
    // Capture is a best-effort compare-and-set; a delivery that loses a race
    // is dropped, so this test delivers sequentially.
    await deliver(f, [tool(20), tool(19)]);
    await deliver(f, [tool(18)]);
    const first = await summarize(f.actor, f.run);
    expect(
      inputs[0]!.activity.map((entry) => {
        return entry.sequence;
      }),
    ).toStrictEqual([18, 19, 20]);
    // A repeated tool call and a usage-only record are not new evidence; a
    // relevant late event merges into the retained window behind them.
    await deliver(f, [
      tool(19),
      { type: "usage", sequenceNumber: 21, usage: { input_tokens: 300 } },
      tool(17),
    ]);
    await expect(summarize(f.actor, f.run)).resolves.toStrictEqual(first);
    expect(inputs).toHaveLength(1);
    // Time passage and expired process leases have no production mutation API.
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await summarize(f.actor, f.run);
    expect(
      inputs[1]!.activity.map((entry) => {
        return entry.sequence;
      }),
    ).toStrictEqual([17, 18, 19, 20]);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await deliver(
      f,
      Array.from({ length: 30 }, (_, i) => {
        return tool(30 + i, "界".repeat(1000));
      }),
    );
    const bounded = await summarize(f.actor, f.run);
    expect(bounded.status).toBe("available");
    const activity = inputs[2]!.activity;
    expect(activity.length).toBeLessThanOrEqual(16);
    expect(
      Buffer.byteLength(JSON.stringify(activity), "utf8"),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(
      activity.every((entry) => {
        return Array.from(entry.excerpt).length <= 700;
      }),
    ).toBeTruthy();
    expect(activity.at(-1)?.sequence).toBe(59);
  });

  it("shares one claim across concurrent callers", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<string>(context.signal);
    const inputs = provider(async () => {
      entered.resolve(undefined);
      return await release.promise;
    });
    const first = settleIncludingAbort(summarize(f.actor, f.run));
    await entered.promise;
    const concurrent = await Promise.all([
      summarize(f.actor, f.run),
      summarize(f.actor, f.run),
    ]);
    expect(
      concurrent.every((value) => {
        // A follower finds the live claim and returns the empty stored batch
        // without dispatching another call.
        return value.messages.length === 0;
      }),
    ).toBeTruthy();
    await deliver(f, [tool(0, "new activity while the provider is working")]);
    release.resolve("Preparing the requested checklist");
    const outcome = await first;
    if (!outcome.ok) {
      throw outcome.error;
    }
    // The single claim owner publishes its batch even though newer evidence
    // arrived while it was generating.
    expect(outcome.value.messages[0]?.text).toBe(
      "Preparing the requested checklist",
    );
    expect(inputs).toHaveLength(1);
  });

  it("fences an expired owner's completion after a replacement claim succeeds", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<string>(context.signal);
    provider(async (_input, index) => {
      if (index === 1) {
        entered.resolve(undefined);
        return await release.promise;
      }
      return "Checking the current launch materials";
    });
    const abandoned = summarize(f.actor, f.run);
    await entered.promise;
    // Reproduce an instance paused beyond its lease using only this run's clock.
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await deliver(f, [tool(0)]);
    const replacement = await summarize(f.actor, f.run);
    release.resolve("Obsolete preparation phrase");
    await expect(abandoned).resolves.toStrictEqual(replacement);
    expect(replacement.messages[0]?.text).toBe(
      "Checking the current launch materials",
    );
  });

  it.each(["cancel", "complete", "delete"] as const)(
    "discards a completion after %s and never exposes terminal cache",
    async (action) => {
      const f = await fixture();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<string>(context.signal);
      const inputs = provider(async () => {
        entered.resolve(undefined);
        return await release.promise;
      });
      const pending = summarize(f.actor, f.run);
      await entered.promise;
      if (action === "cancel") {
        await runs.requestCancelRun(f.actor, f.run.runId, [200]);
      } else if (action === "complete") {
        await webhooks.requestAgentComplete(
          { runId: f.run.runId, exitCode: 0 },
          f.headers,
          [200],
        );
        // Completion callbacks also acquire content locks. Finish them before
        // asserting terminal eligibility instead of transient unavailability.
        await flushWaitUntilForTest();
      } else {
        await chat.deleteThread(f.actor, f.run.threadId);
      }
      release.resolve("This phrase must not revive the run");
      // The combined completion/response transaction freshly rechecks
      // current-run eligibility and cannot return a terminal run's cache.
      await expect(pending).resolves.toMatchObject({
        status: "ineligible",
        messages: [],
      });
      if (action !== "delete") {
        await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
          status: "ineligible",
          messages: [],
        });
      } else {
        await accept(request(f.actor, f.run), [404]);
      }
      expect(inputs).toHaveLength(1);
    },
  );

  it.each(["", "one\ntwo\nthree\nfour\nfive", "**Markdown**"])(
    "cools down malformed output %j without retrying",
    async (output) => {
      const f = await fixture();
      const inputs = provider(() => {
        return output;
      });
      const failed = await summarize(f.actor, f.run);
      expect(failed).toMatchObject({ status: "available", messages: [] });
      await summarize(f.actor, f.run);
      expect(inputs).toHaveLength(1);
    },
  );

  it.each([
    {
      name: "a completion that spent the whole token budget",
      reply: () => {
        return completion(privatePayload, "length");
      },
    },
    {
      name: "a completion that ended on an unoffered tool call",
      reply: () => {
        return completion(privatePayload, "tool_calls");
      },
    },
    {
      name: "a rejected transport request",
      reply: () => {
        return HttpResponse.error();
      },
    },
    {
      name: "a body that timed out mid-stream",
      reply: () => {
        return brokenBody(
          new TypeError("terminated", {
            cause: { code: "UND_ERR_BODY_TIMEOUT" },
          }),
        );
      },
    },
    {
      name: "a body that is not JSON",
      reply: () => {
        return new HttpResponse(privatePayload);
      },
    },
    {
      name: "an envelope without choices",
      reply: () => {
        return HttpResponse.json({});
      },
    },
    {
      name: "an exception nothing classified",
      reply: () => {
        return brokenBody(
          new TypeError(`${privatePayload}\n at /src/signals/redacted.ts:1:2`),
        );
      },
    },
  ])("cools down after $name without retrying", async ({ reply }) => {
    const f = await fixture();
    const inputs = provider(reply);
    const absorbed = await summarize(f.actor, f.run);
    // The optional output is simply omitted; the response stays truthful and
    // the shared cooldown bounds recovery.
    expect(absorbed).toMatchObject({ status: "available", messages: [] });
    // The cooldown really reached the database: no second provider call.
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(1);
  });

  it("keeps a stored summary when the optional key disappears", async () => {
    const f = await fixture();
    const inputs = provider();
    const first = await summarize(f.actor, f.run);
    expect(first.messages[0]?.text).toBe("Preparing the launch checklist");
    // New evidence plus an elapsed attempt interval make a fresh attempt legal.
    await deliver(f, [tool(0)]);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const degraded = await summarize(f.actor, f.run);
    // The attempt still claims, writes and rereads, so the caller degrades to
    // the stored phrase instead of to an empty batch.
    expect(degraded.messages).toStrictEqual(first.messages);
    expect(degraded.status).toBe("available");
    expect(inputs).toHaveLength(1);
  });

  it("keeps a stored summary through a rejected batch and recovers after the cooldown", async () => {
    const f = await fixture();
    const inputs = provider((_input, index) => {
      return index === 2
        ? "Valid message\n**Markdown**"
        : "Preparing the launch checklist";
    });
    const first = await summarize(f.actor, f.run);
    await deliver(f, [tool(0)]);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    const rejected = await summarize(f.actor, f.run);
    expect(rejected.messages).toStrictEqual(first.messages);
    expect(inputs).toHaveLength(2);
    // The failure cooldown outlasts the plain attempt interval.
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(2);
    // The persisted cooldown expires and the next attempt publishes a phrase.
    await advanceRunActivityClockFixture(f.run.runId, 45_000);
    const recovered = await summarize(f.actor, f.run);
    expect(recovered.messages[0]?.text).toBe("Preparing the launch checklist");
    expect(inputs).toHaveLength(3);
  });

  it("accepts existing Codex commands and tool results while bounding graphemes", async () => {
    const f = await fixture();
    const inputs = provider(() => {
      return "👨‍👩‍👧‍👦".repeat(80);
    });
    await deliver(f, [
      {
        type: "item.started",
        sequenceNumber: 0,
        item: {
          id: "command-1",
          type: "command_execution",
          command: "inspect launch data",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 1,
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "PRIVATE_REASONING",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 2,
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          tool: "search",
          arguments: { query: "launch owners" },
        },
      },
      {
        type: "user",
        sequenceNumber: 3,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "mcp-1",
              content: [
                { type: "text", text: "Found launch owners" },
                { type: "image", source: { data: "PRIVATE_IMAGE" } },
              ],
            },
          ],
        },
      },
    ]);
    const summary = await summarize(f.actor, f.run);
    expect(summary.messages[0]?.text).toBe("👨‍👩‍👧‍👦".repeat(60));
    expect(
      inputs[0]!.activity.map((entry) => {
        return entry.sequence;
      }),
    ).toStrictEqual([0, 2, 3]);
    expect(JSON.stringify(inputs)).not.toContain("PRIVATE_");
    expect(inputs[0]!.activity.at(-1)?.excerpt).toBe("Found launch owners");
  });

  it("rejects unauthenticated requests and client-supplied evidence", async () => {
    const client = setupApp({
      context,
      routes: chatThreadActivitySummaryRoutes,
    })(chatThreadActivitySummaryContract);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await accept(
      client.summarize({
        headers: {},
        params: { id: randomUUID() },
        body: { runId: randomUUID() },
      }),
      [401],
    );
    const f = await fixture();
    const inputs = provider();
    createRouteMocks(context).clerk.session(
      f.actor.userId,
      f.actor.orgId,
      f.actor.orgRole,
    );
    const body = {
      runId: f.run.runId,
      prompt: "Client evidence must not be trusted",
    };
    await accept(
      client.summarize({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: f.run.threadId },
        body,
      }),
      [400],
    );
    expect(inputs).toHaveLength(0);
  });

  it("uses a shared cooldown when the model is unconfigured", async () => {
    const f = await fixture();
    const failed = await summarize(f.actor, f.run);
    expect(failed).toMatchObject({ status: "available", messages: [] });
    const inputs = provider();
    // The cooldown bounds the next provider call even when no summary exists
    // to fall back to, so restoring the key mid-cooldown generates nothing.
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(0);
  });

  it("bounds a hanging provider request and never retries within the request", async () => {
    const f = await fixture();
    const release = createDeferredPromise<string>(context.signal);
    const inputs = provider(async () => {
      return await release.promise;
    });
    const result = await summarize(f.actor, f.run);
    release.resolve("Too late");
    expect(result).toMatchObject({ status: "available", messages: [] });
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(1);
  }, 15_000);

  it("sends the bounded current task as the only message", async () => {
    const prompt = "current task ".repeat(100);
    const f = await fixture(prompt);
    const inputs = provider();
    await deliver(f, [
      {
        type: "assistant",
        sequenceNumber: 0,
        message: {
          content: [{ type: "text", text: "Public commentary" }],
        },
      },
    ]);
    await summarize(f.actor, f.run);
    expect(inputs[0]!.messages).toStrictEqual([
      { role: "user", content: prompt.trim().slice(0, 700) },
    ]);
    expect(inputs[0]!.activity[0]?.excerpt).toBe("Public commentary");
  });

  it("captures activity and delivers messages independently of Axiom ingestion", async () => {
    const f = await fixture();
    const inputs = provider();
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await deliver(f, [
      tool(0),
      {
        type: "assistant",
        sequenceNumber: 1,
        message: {
          content: [
            { type: "text", text: "Public commentary during the Axiom outage" },
          ],
        },
      },
    ]);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "available",
    });
    expect(inputs[0]!.activity[0]?.name).toBe("bash");
    expect(
      JSON.stringify(
        (await chat.listThreadEvents(f.actor, f.run.threadId)).events,
      ),
    ).toContain("Public commentary during the Axiom outage");
  });

  it("absorbs a rate limit before any summary exists and recovers after the cooldown", async () => {
    const f = await fixture();
    const inputs = provider((_input, index) => {
      return index === 1
        ? HttpResponse.json(
            { error: { code: 429, message: "PRIVATE_PROVIDER_BODY" } },
            { status: 429 },
          )
        : "Checking the current launch materials";
    });
    const empty = await summarize(f.actor, f.run);
    // Nothing was ever generated for this run, so the viewer keeps the generic
    // label its own fallback renders for an empty batch.
    expect(empty.messages).toStrictEqual([]);
    expect(empty.status).toBe("available");
    // The shared cooldown really reached the database: no second provider call.
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(1);
    await advanceRunActivityClockFixture(f.run.runId, 61_000);
    const recovered = await summarize(f.actor, f.run);
    expect(recovered.messages[0]?.text).toBe(
      "Checking the current launch materials",
    );
    expect(recovered.status).toBe("available");
    expect(inputs).toHaveLength(2);
  });

  it("absorbs upstream unavailability and keeps the last known summary", async () => {
    const f = await fixture();
    const inputs = provider((_input, index) => {
      return index === 1
        ? "Preparing the launch checklist"
        : HttpResponse.json(
            { error: { code: 503, message: "PRIVATE_PROVIDER_BODY" } },
            { status: 503 },
          );
    });
    const first = await summarize(f.actor, f.run);
    await deliver(f, [tool(0)]);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    const failed = await summarize(f.actor, f.run);
    expect(failed.messages).toStrictEqual(first.messages);
    // The charged cooldown still bounds the next provider call.
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(2);
  });

  it("absorbs an envelope unavailability and an upstream timeout", async () => {
    const f = await fixture();
    const inputs = provider((_input, index) => {
      // A native unavailability arrives inside a successful envelope, which
      // this client wraps as a synthetic 502; the reason decides, not the status.
      return index === 1
        ? HttpResponse.json({
            choices: [
              {
                finish_reason: "error",
                error: {
                  code: "UNAVAILABLE",
                  message: "PRIVATE_PROVIDER_BODY",
                },
              },
            ],
          })
        : HttpResponse.json(
            { error: { code: 504, message: "PRIVATE_PROVIDER_BODY" } },
            { status: 504 },
          );
    });
    const absorbed = await summarize(f.actor, f.run);
    expect(absorbed).toMatchObject({ status: "available", messages: [] });
    await advanceRunActivityClockFixture(f.run.runId, 61_000);
    const timedOut = await summarize(f.actor, f.run);
    expect(timedOut).toMatchObject({ status: "available", messages: [] });
    expect(inputs).toHaveLength(2);
  });

  it("keeps the last known summary when an attempt misses its deadline", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const stalled = createDeferredPromise<string>(context.signal);
    const inputs = provider(async (_input, index) => {
      if (index === 1) {
        return "Preparing the launch checklist";
      }
      entered.resolve(undefined);
      return await stalled.promise;
    });
    const first = await summarize(f.actor, f.run);
    await deliver(f, [tool(0)]);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    const deadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? deadline.signal : undefined;
    });
    const pending = summarize(f.actor, f.run);
    await entered.promise;
    deadline.abort(
      new DOMException("Summary deadline reached", "TimeoutError"),
    );
    stalled.resolve("This phrase arrives after its own deadline");
    const missed = await pending;
    // The caller keeps its last real phrase and a bounded, self-recovering wait.
    expect(missed.messages).toStrictEqual(first.messages);
    expect(missed.status).toBe("available");
    expect(inputs).toHaveLength(2);
  });

  it("charges no cooldown when the instance stops before the provider answers", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<string>(context.signal);
    const inputs = provider(async (_input, index) => {
      if (index === 1) {
        entered.resolve(undefined);
        return await release.promise;
      }
      return "Checking the current launch materials";
    });
    const shutdown = new AbortController();
    createRouteMocks(context).clerk.session(
      f.actor.userId,
      f.actor.orgId,
      f.actor.orgRole,
    );
    const abandoned = settleIncludingAbort(
      setupApp({
        context,
        routes: chatThreadActivitySummaryRoutes,
        signal: shutdown.signal,
      })(chatThreadActivitySummaryContract).summarize({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: f.run.threadId },
        body: { runId: f.run.runId },
      }),
    );
    await entered.promise;
    shutdown.abort(new DOMException("API instance stopping", "AbortError"));
    release.resolve("This phrase never reaches an absent caller");
    await abandoned;
    // Only the attempt interval was ever charged, so the next viewer generates
    // again instead of waiting out a failure cooldown it never caused.
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    const recovered = await summarize(f.actor, f.run);
    expect(recovered.messages[0]?.text).toBe(
      "Checking the current launch materials",
    );
    expect(inputs).toHaveLength(2);
  });

  it("treats a run without an active row as having no activity", async () => {
    const f = await fixture();
    const inputs = provider();
    // A run created by an older API during rollout has no active row.
    await deleteActiveAgentRunFixture(f.run.runId);
    await deliver(f, [tool(0)]);
    await expect(
      readActiveAgentRunFixture(f.run.runId),
    ).resolves.toBeUndefined();
    await expect(summarize(f.actor, f.run)).resolves.toStrictEqual({
      runId: f.run.runId,
      status: "ineligible",
      messages: [],
    });
    expect(inputs).toHaveLength(0);
  });
});
