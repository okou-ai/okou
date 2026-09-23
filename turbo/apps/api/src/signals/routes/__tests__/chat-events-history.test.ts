import { randomUUID } from "node:crypto";
import {
  resolveChatEventRecommendedFollowups,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import { readThreadSessionBinding } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  openRouterBodySchema,
  userMessages,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
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
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return messages.some((message) => {
        return (
          message.runId === anchor.runId &&
          message.eventType === "run.completed"
        );
      });
    });

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
      model: "google/gemini-3.1-flash-lite",
      max_tokens: 2048,
      reasoning: { effort: "minimal" },
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
    const recommendedFollowupRequest = {
      agentId,
      threadId: first.threadId,
      prompt: "use the recommended follow-up",
      revokesEventId: recommender.id,
      clientEventId: recommendedFollowupQueueEventId,
    };
    const normalFollowup = await chat.requestSendEvent(
      actor,
      recommendedFollowupRequest,
      [201],
    );
    if (normalFollowup.status !== 201) {
      throw new Error("Expected recommended follow-up send to succeed");
    }
    const retriedFollowup = await chat.requestSendEvent(
      actor,
      recommendedFollowupRequest,
      [201],
    );
    expect(retriedFollowup.body).toStrictEqual(normalFollowup.body);
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
