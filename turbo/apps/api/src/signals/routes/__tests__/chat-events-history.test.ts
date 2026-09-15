import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { randomUUID } from "node:crypto";
import {
  resolveChatEventRecommendedFollowups,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { openRouterModelContractError } from "./helpers/openrouter-model-contract";
import { readThreadSessionBinding } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  openRouterBodySchema,
  requireOrgId,
  assistantMessages,
  userMessages,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  sessionHeaders,
} = createChatEventsFixture(context);

type FollowupsEvent = Extract<ChatEvent, { eventType: "output.followups" }>;

async function waitForThreadTitle(
  actor: ApiTestUser,
  threadId: string,
  title: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return await readThreadTitleFromEvents(actor, threadId);
    })
    .toBe(title);
}

async function readThreadTitleFromEvents(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  const events = await chat.requestThreadEvents(actor, {}, [200]);
  if (events.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }

  let latestTitleEvent:
    | { readonly title: string | null; readonly createdAt: string }
    | undefined;
  for (const event of events.body.events) {
    if (
      event.chatThreadId !== threadId ||
      (event.kind !== "created" && event.kind !== "renamed")
    ) {
      continue;
    }
    if (
      latestTitleEvent === undefined ||
      Date.parse(event.createdAt) >= Date.parse(latestTitleEvent.createdAt)
    ) {
      latestTitleEvent = event;
    }
  }

  return latestTitleEvent?.title ?? null;
}

function recommendedFollowupEvents(
  messages: readonly ChatEvent[],
  runId: string,
): FollowupsEvent[] {
  return messages.filter((message): message is FollowupsEvent => {
    return (
      message.eventType === "output.followups" &&
      message.runId === runId &&
      resolveChatEventRecommendedFollowups(message).length > 0
    );
  });
}

describe("CHAT-02: incomplete-round context", () => {
  it("injects incomplete rounds and truncates old content chronologically", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "establish native session history",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);

    const first = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "first incomplete",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await failChatRun(first.runId, firstClaim.sandboxHeaders, "boom one");
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the failed run to retain its session binding");
    }

    const longPrompt = `second ${"x".repeat(4100)}`;
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: longPrompt,
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await failChatRun(second.runId, secondClaim.sandboxHeaders, "boom two");
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: second.runId,
      run_session_id: firstBinding.agent_session_id,
    });

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after two failures",
    });
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: third.runId,
      run_session_id: firstBinding.agent_session_id,
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended.split("RUN_STATUS: failed")).toHaveLength(3);
    expect(appended).toContain("User: first incomplete");
    expect(appended.indexOf("User: first incomplete")).toBeLessThan(
      appended.indexOf("User: second"),
    );
    expect(appended).toContain("...[truncated]");
    expect(appended).not.toContain("retry after two failures");
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${anchor.runId}`,
    );
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: initial thinking indicator", () => {
  // Provider text is untrusted and must never reach the thread.
  const privateProviderDetail = "private_prompt_history_authorization_canary";

  it.each([
    { enabled: false, existingThread: false },
    { enabled: true, existingThread: false },
    { enabled: false, existingThread: true },
    { enabled: true, existingThread: true },
  ])(
    "hands opening copy to visible demand only when enabled=$enabled (existing thread=$existingThread)",
    async ({ enabled, existingThread }) => {
      const { actor, agentId } = await entitledChatActor();
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.ThreadActivitySummary]: enabled },
      );
      const thread = existingThread
        ? await chat.createThread(actor, { agentId })
        : null;
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-handover-key");
      const indicatorCalls: string[] = [];
      let titleCalls = 0;
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            const payload = openRouterBodySchema.parse(await request.json());
            const system = payload.messages[0]?.content ?? "";
            const isInitial = system.includes(
              "Write user-visible progress copy",
            );
            const isSummary = system.includes("Write three short");
            if (isInitial || isSummary) {
              indicatorCalls.push(isInitial ? "initial" : "summary");
            } else if (system.includes("Generate a short, descriptive title")) {
              titleCalls++;
            }
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: isInitial
                      ? "Preparing the original checklist"
                      : isSummary
                        ? "Preparing the visible checklist"
                        : "Launch Checklist",
                  },
                },
              ],
            });
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare the launch checklist",
        ...(thread ? { threadId: thread.id } : {}),
      });
      await flushWaitUntilForTest();
      const beforeDemand = await chat.listThreadEvents(actor, run.threadId);
      const initial = beforeDemand.events.filter((event) => {
        return event.runEventId === "thinking:initial";
      });
      expect(indicatorCalls).toStrictEqual(enabled ? [] : ["initial"]);
      expect(initial).toHaveLength(enabled ? 0 : 1);
      if (!enabled) {
        expect(initial[0]).toMatchObject({
          eventType: "output.thinking",
          thinking: "Preparing the original checklist",
          runId: run.runId,
        });
      }
      expect(titleCalls).toBeGreaterThan(0);
      expect((await api.readRun(actor, run.runId)).status).toBe("pending");

      const requested = await accept(
        setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
          chatThreadActivitySummaryContract,
        ).summarize({
          headers: sessionHeaders(actor),
          params: { id: run.threadId },
          body: { runId: run.runId },
        }),
        [200, 403],
      );
      if (enabled) {
        expect(requested.status).toBe(200);
        expect(requested.body).toMatchObject({
          messages: [
            {
              id: "Preparing the visible checklist",
              text: "Preparing the visible checklist",
            },
          ],
          status: "available",
          runId: run.runId,
        });
        expect(indicatorCalls).toStrictEqual(["summary"]);
      } else {
        expect(requested.status).toBe(403);
        expect(indicatorCalls).toStrictEqual(["initial"]);
      }
      const afterDemand = await chat.listThreadEvents(actor, run.threadId);
      expect(afterDemand.events).toStrictEqual(beforeDemand.events);
      await cancelChatRun(actor, run.runId);
    },
  );

  const providerDetail = "private-provider-detail";

  // One shape per externally distinguishable outcome. Which gateway code or
  // transport fault the provider classification separates further reaches the
  // thread identically, so those are not enumerated again.
  it.each([
    {
      name: "a provider rate limit",
      thinkingResponse: () => {
        return new HttpResponse(providerDetail, { status: 429 });
      },
    },
    {
      name: "a rejected request",
      thinkingResponse: () => {
        return new HttpResponse(providerDetail, { status: 400 });
      },
    },
    {
      name: "broken credentials",
      thinkingResponse: () => {
        return new HttpResponse(providerDetail, { status: 401 });
      },
    },
    // Shortened copy is unusable for this caller, so the marker stays absent.
    {
      name: "an exhausted token budget",
      thinkingResponse: () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "length",
              native_finish_reason: "MAX_TOKENS",
              message: { content: providerDetail },
            },
          ],
        });
      },
    },
    {
      // Non-empty for the provider, yet nothing survives sanitization.
      name: "output that sanitizes to nothing",
      thinkingResponse: () => {
        return HttpResponse.json({
          choices: [{ finish_reason: "stop", message: { content: '"""' } }],
        });
      },
    },
  ])("omits opening copy after $name", async ({ thinkingResponse }) => {
    const { actor, agentId } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-classification-key");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const system = payload.messages[0]?.content ?? "";
          return system.includes("Write user-visible progress copy")
            ? thinkingResponse()
            : HttpResponse.json({
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: "Launch Checklist" },
                  },
                ],
              });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Prepare the launch checklist",
    });
    await flushWaitUntilForTest();

    // The optional generation is isolated: no marker, the run proceeds, and
    // nothing the provider sent reaches the thread.
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(
      events.events.filter((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toStrictEqual([]);
    expect(JSON.stringify(events.events)).not.toContain(providerDetail);
    expect((await api.readRun(actor, run.runId)).status).toBe("pending");
    await cancelChatRun(actor, run.runId);
  });

  it("persists a fast assistant thinking marker with paragraphs for active web chat runs", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");

    let thinkingAuthorization: string | null = null;
    let thinkingPromptPayload = "";
    let thinkingRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    const titleResponse = "Launch Checklist";
    const thinkingResponse =
      "Reviewing the launch request and recent context.\nIdentifying the checklist's major sections.\nChecking where owners and timing matter.\nPreparing a clear order for the response.";
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const contractError = openRouterModelContractError(payload);
          if (contractError) {
            return contractError;
          }
          const systemContent = payload.messages[0]?.content ?? "";
          let responseContent = "Unrelated completion";
          if (systemContent.includes("Generate a short, descriptive title")) {
            responseContent = titleResponse;
          }
          if (systemContent.includes("Write user-visible progress copy")) {
            thinkingAuthorization = request.headers.get("authorization");
            thinkingRequestBody = payload;
            thinkingPromptPayload = payload.messages
              .map((message) => {
                return message.content;
              })
              .join("\n\n");
            responseContent = thinkingResponse;
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: responseContent },
              },
            ],
          });
        },
      ),
    );

    const clientEventId = randomUUID();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Draft a launch checklist",
      clientEventId,
    });

    const page = await waitForThreadMessages(actor, run.threadId, (items) => {
      return assistantMessages(items).some((message) => {
        return (
          message.eventType === "output.thinking" &&
          message.runId === run.runId &&
          message.content === null &&
          message.thinking === thinkingResponse
        );
      });
    });
    await waitForThreadTitle(actor, run.threadId, titleResponse);
    const marker = assistantMessages(page.events).find((message) => {
      return (
        message.eventType === "output.thinking" &&
        message.runId === run.runId &&
        message.thinking === thinkingResponse
      );
    });
    expect(marker).toMatchObject({
      eventType: "output.thinking",
      content: null,
      runId: run.runId,
      runEventId: "thinking:initial",
      thinking: thinkingResponse,
    });
    expect(thinkingAuthorization).toBe("Bearer thinking-key");
    expect(thinkingRequestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 1024,
      reasoning: { effort: "low" },
    });
    expect(thinkingPromptPayload).toContain("one paragraph at a time");
    expect(thinkingPromptPayload).toContain(
      "about 30 characters, excluding punctuation",
    );
    expect(thinkingPromptPayload).toContain("around four short paragraphs");
    expect(thinkingPromptPayload).toContain("Do not answer the user");
    expect(thinkingPromptPayload).toContain("Do not reveal hidden reasoning");
    expect(thinkingPromptPayload).toContain(
      "Match the current user's language",
    );
    expect(thinkingPromptPayload).toContain("Draft a launch checklist");
    await flushWaitUntilForTest();

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "Draft a launch checklist",
        clientEventId,
      },
      [201],
    );
    await flushWaitUntilForTest();
    const replayed = await chat.listThreadEvents(actor, run.threadId);
    expect(
      replayed.events.filter((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toStrictEqual([marker]);

    await cancelChatRun(actor, run.runId);
  });

  it("discards token-limited progress copy instead of persisting a truncated marker", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");

    let thinkingRequests = 0;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (systemContent.includes("Write user-visible progress copy")) {
            thinkingRequests += 1;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "length",
                  native_finish_reason: "MAX_TOKENS",
                  message: {
                    content: "Incomplete progress copy that must not persist",
                  },
                },
              ],
            });
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Token Limit Title" },
              },
            ],
          });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Draft a concise migration update",
    });
    await flushWaitUntilForTest();

    const page = await chat.listThreadEvents(actor, run.threadId);
    expect(thinkingRequests).toBe(1);
    expect(
      assistantMessages(page.events).some((message) => {
        return (
          message.runId === run.runId &&
          message.runEventId === "thinking:initial"
        );
      }),
    ).toBeFalsy();

    await cancelChatRun(actor, run.runId);
  });

  it("caps complete progress copy at 600 characters while preserving paragraph sanitization", async () => {
    const { actor, agentId } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      return body.messages[0]?.content.includes(
        "Write user-visible progress copy",
      )
        ? `"  Preparing\t the update.\r\n\r\n\r\n${"界".repeat(700)}"`
        : "Update";
    });
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Prepare an update",
    });
    await flushWaitUntilForTest();
    const page = await chat.listThreadEvents(actor, run.threadId);
    const marker = page.events.find((event) => {
      return event.runEventId === "thinking:initial";
    });
    expect(marker).toMatchObject({
      thinking: `Preparing the update.\n\n${"界".repeat(577)}`,
    });
    await cancelChatRun(actor, run.runId);
  });

  it("does not request opening copy while a run waits for org capacity", async () => {
    const { actor, agentId } = await entitledChatActor();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "Occupy capacity",
    });
    await flushWaitUntilForTest();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
    let thinkingRequests = 0;
    chatCallbacks.mockOpenRouterCompletions((body) => {
      if (
        body.messages[0]?.content.includes("Write user-visible progress copy")
      ) {
        thinkingRequests += 1;
      }
      return "Update";
    });
    const queued = await sendChatRun(actor, {
      agentId,
      prompt: "Prepare a later update",
    });
    await flushWaitUntilForTest();
    const [queuedRun, page] = await Promise.all([
      api.readRun(actor, queued.runId),
      chat.listThreadEvents(actor, queued.threadId),
    ]);
    expect(queuedRun.status).toBe("queued");
    expect(page.events).toContainEqual(
      expect.objectContaining({ runEventId: "queue:queued" }),
    );
    expect(
      page.events.some((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toBeFalsy();
    expect(thinkingRequests).toBe(0);
    await cancelChatRun(actor, queued.runId);
    await cancelChatRun(actor, blocker.runId);
  });

  it.each([400, 429, 503])(
    "keeps the main run usable after an auxiliary HTTP %i",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            const body = openRouterBodySchema.parse(await request.json());
            if (
              body.messages[0]?.content.includes(
                "Write user-visible progress copy",
              )
            ) {
              return HttpResponse.json({ error: { code: status } }, { status });
            }
            return HttpResponse.json({
              choices: [
                { finish_reason: "stop", message: { content: "Update" } },
              ],
            });
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare an update",
      });
      await flushWaitUntilForTest();
      const claim = await claimChatRun(runnerGroup, run.runId);
      chatCallbacks.mockChatOutputEvents([
        assistantEvent(0, "The main response is ready."),
      ]);
      await completeChatRunOk(run.runId, claim.sandboxHeaders);
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, run.runId)).status).toBe("completed");
      const page = await chat.listThreadEvents(actor, run.threadId);
      expect(page.events).toContainEqual(
        expect.objectContaining({ content: "The main response is ready." }),
      );
      expect(
        page.events.some((event) => {
          return event.runEventId === "thinking:initial";
        }),
      ).toBeFalsy();
    },
  );

  it.each([
    {
      name: "empty",
      responseBody: {
        choices: [{ finish_reason: "stop", message: { content: "  " } }],
      },
    },
    {
      name: "non-text",
      responseBody: {
        choices: [{ finish_reason: "stop", message: { content: null } }],
      },
    },
    {
      name: "unknown finish reason",
      responseBody: {
        choices: [
          {
            finish_reason: privateProviderDetail,
            native_finish_reason: privateProviderDetail,
            message: { content: "Incomplete" },
          },
        ],
      },
    },
    {
      name: "malformed JSON",
      responseBody: `${privateProviderDetail}: invalid JSON`,
    },
  ])(
    "discards $name output without failing the run or leaking provider data",
    async ({ responseBody }) => {
      const { actor, agentId } = await entitledChatActor();
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            const body = openRouterBodySchema.parse(await request.json());
            if (
              body.messages[0]?.content.includes(
                "Write user-visible progress copy",
              )
            ) {
              return typeof responseBody === "string"
                ? HttpResponse.text(responseBody)
                : HttpResponse.json(responseBody);
            }
            return HttpResponse.json({
              choices: [
                { finish_reason: "stop", message: { content: "Update" } },
              ],
            });
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare an update",
      });
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, run.runId)).status).toBe("pending");
      const page = await chat.listThreadEvents(actor, run.threadId);
      expect(
        page.events.some((event) => {
          return event.runEventId === "thinking:initial";
        }),
      ).toBeFalsy();
      expect(JSON.stringify(page.events)).not.toContain(privateProviderDetail);
      await cancelChatRun(actor, run.runId);
    },
  );

  it.each(["answer", "completed", "cancelled"] as const)(
    "suppresses late progress copy after %s while the provider remains pending",
    async (outcome) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      chatCallbacks.mockOpenRouterCompletions(async (body) => {
        if (
          body.messages[0]?.content.includes("Write user-visible progress copy")
        ) {
          entered.resolve();
          await release.promise;
          return "This progress copy arrived too late.";
        }
        return "Update";
      });
      // The send and main-run lifecycle must proceed before auxiliary generation resolves.
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare an update",
      });
      await entered.promise;
      const claim = await claimChatRun(runnerGroup, run.runId);
      if (outcome === "answer") {
        chatCallbacks.mockChatOutputEvents([assistantEvent(0, "Main answer")]);
        await webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: chatCallbacks.consumeMockChatOutputEvents(),
          },
          claim.sandboxHeaders,
          [200],
        );
      } else if (outcome === "completed") {
        await completeChatRunOk(run.runId, claim.sandboxHeaders);
      } else {
        await api.requestCancelRun(actor, run.runId, [200]);
      }
      release.resolve();
      await flushWaitUntilForTest();
      const page = await chat.listThreadEvents(actor, run.threadId);
      expect(
        page.events.some((event) => {
          return event.runEventId === "thinking:initial";
        }),
      ).toBeFalsy();
      expect((await api.readRun(actor, run.runId)).status).toBe(
        outcome === "answer" ? "running" : outcome,
      );
      if (outcome === "answer") {
        await cancelChatRun(actor, run.runId, claim.sandboxHeaders);
      }
    },
  );
});

describe("CHAT-02: prior rounds and thread titles", () => {
  it("leaves prior completed rounds to the session, generates the thread title, and accepts immutable follow-up revokes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "title-key");
    let upstreamAuthorization: string | null = null;
    let titleRequests = 0;
    let titleRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    let followupRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          upstreamAuthorization = request.headers.get("authorization");
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (systemContent.includes("recommended follow-up messages")) {
            followupRequestBody = payload;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify([
                      { prompt: "Summarize the migration steps", kind: "talk" },
                    ]),
                  },
                },
              ],
            });
          }
          if (systemContent.includes("Generate a short, descriptive title")) {
            titleRequests += 1;
            titleRequestBody = payload;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: "**Migration Plan**" },
                },
              ],
            });
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Generated summary" },
              },
            ],
          });
        },
      ),
    );

    const firstPrompt = "plan the API migration";
    const first = await sendChatRun(actor, { agentId, prompt: firstPrompt });
    await waitForThreadTitle(actor, first.threadId, "Migration Plan");
    expect(titleRequests).toBe(1);
    expect(upstreamAuthorization).toBe("Bearer title-key");
    expect(titleRequestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 2048,
      reasoning: { effort: "low" },
    });

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Assistant migration answer"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterFirst = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return recommendedFollowupEvents(items, first.runId).some((message) => {
          return resolveChatEventRecommendedFollowups(message).length > 0;
        });
      },
    );
    const recommender = recommendedFollowupEvents(
      afterFirst.events,
      first.runId,
    ).find((message) => {
      return resolveChatEventRecommendedFollowups(message).length > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups message");
    }
    expect(recommender.eventType).toBe("output.followups");
    expect(followupRequestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 2048,
      reasoning: { effort: "low" },
    });
    const futureFollowups = resolveChatEventRecommendedFollowups(recommender);
    expect(futureFollowups.length).toBeGreaterThan(0);
    const futureFollowupContent = recommender.content;
    expect(futureFollowupContent).not.toBeNull();

    const futureEvents = await chat.listThreadEvents(actor, first.threadId);
    expect(futureEvents.events).toContainEqual(
      expect.objectContaining({
        id: recommender.id,
        eventType: "output.followups",
        content: futureFollowupContent,
      }),
    );
    expect(
      futureEvents.events.find((event) => {
        return event.id === recommender.id;
      }),
    ).not.toHaveProperty("recommendedFollowups");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow-up question",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Migration Plan");
    expect(titleRequests).toBe(1);
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    // The reused CLI session already holds the completed round, so the prompt
    // only points at the thread instead of replaying it.
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("Assistant: Assistant migration answer");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    expect(appended).not.toContain(futureFollowupContent);
    for (const followup of futureFollowups) {
      expect(appended).not.toContain(followup.prompt);
    }

    await cancelChatRun(actor, second.runId);

    await chat.renameThread(actor, first.threadId, "Manual Migration Title");
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "manual title should stay",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Manual Migration Title");
    expect(titleRequests).toBe(1);
    await cancelChatRun(actor, third.runId);

    const recommendedFollowupQueueEventId = randomUUID();
    const normalFollowup = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "use the recommended follow-up",
        revokesEventId: recommender.id,
        clientEventId: recommendedFollowupQueueEventId,
      },
      [201],
    );
    if (normalFollowup.status !== 201) {
      throw new Error("Expected recommended follow-up send to succeed");
    }
    const normalFollowupRunId = normalFollowup.body.runId;
    if (normalFollowupRunId === null) {
      throw new Error("Expected recommended follow-up send to create a run");
    }
    const afterFollowup = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === recommendedFollowupQueueEventId &&
            message.runId === normalFollowupRunId
          );
        });
      },
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        id: recommendedFollowupQueueEventId,
        eventType: "input.prompt",
        revokesEventId: recommender.id,
      }),
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        revokesEventId: recommendedFollowupQueueEventId,
        runId: normalFollowupRunId,
      }),
    );
    await cancelChatRun(actor, normalFollowupRunId);
  }, 90_000);

  it("steers an active-run recommended follow-up", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "followup-steer-key");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: systemContent.includes(
                    "recommended follow-up messages",
                  )
                    ? JSON.stringify([
                        {
                          prompt: "Use the recommended follow-up",
                          kind: "talk",
                        },
                      ])
                    : "Follow-up steer",
                },
              },
            ],
          });
        },
      ),
    );

    const completed = await sendChatRun(actor, {
      agentId,
      prompt: "prepare a recommended follow-up",
    });
    const completedClaim = await claimChatRun(runnerGroup, completed.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "A completed answer with follow-ups"),
    ]);
    await completeChatRunOk(completed.runId, completedClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    const completedEvents = await waitForThreadMessages(
      actor,
      completed.threadId,
      (events) => {
        return recommendedFollowupEvents(events, completed.runId).some(
          (event) => {
            return resolveChatEventRecommendedFollowups(event).length > 0;
          },
        );
      },
    );
    const recommender = recommendedFollowupEvents(
      completedEvents.events,
      completed.runId,
    ).find((event) => {
      return resolveChatEventRecommendedFollowups(event).length > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups event");
    }

    const active = await sendChatRun(actor, {
      agentId,
      threadId: completed.threadId,
      prompt: "keep working while the follow-up is steered",
    });
    const activeClaim = await claimChatRun(runnerGroup, active.runId);
    const eventId = randomUUID();
    const followup = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: completed.threadId,
        prompt: "steer the recommended follow-up",
        revokesEventId: recommender.id,
        clientEventId: eventId,
      },
      [201],
    );
    if (followup.status !== 201) {
      throw new Error("Expected the recommended follow-up to succeed");
    }
    expect(followup.body.runId).toBeNull();
    const reservation = await api.reserveRunnerActiveInputs(
      activeClaim.claim.sandboxToken,
      active.runId,
    );
    if (reservation.outcome !== "reserved") {
      throw new Error("Expected the recommended follow-up to be reserved");
    }
    expect(reservation.eventIds).toStrictEqual([eventId]);
    expect(reservation.prompt).toBe("steer the recommended follow-up");
    await expect(
      api.recordRunnerActiveInputDelivery(
        activeClaim.claim.sandboxToken,
        active.runId,
        reservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const afterFollowup = await waitForThreadMessages(
      actor,
      completed.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return (
            event.revokesEventId === eventId && event.runId === active.runId
          );
        });
      },
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        id: eventId,
        eventType: "input.prompt",
        revokesEventId: recommender.id,
      }),
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        revokesEventId: eventId,
        runId: active.runId,
      }),
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);
});
