import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
} from "./helpers/google-text";
import { randomUUID } from "node:crypto";
import { cronCleanupSandboxesContract } from "@okouai/api-contracts/contracts/cron";
import {
  resolveChatEventRecommendedFollowups,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import { publicChatActor } from "./helpers/public-chat-actor";
import { chatEventsRoutes } from "../chat-events";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import {
  createChatEventsFixture,
  userMessages,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  webhooks,
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
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      return await readThreadTitleFromEvents(actor, threadId);
    })(),
  ).resolves.toBe(title);
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
    { readonly title: string | null; readonly createdAt: string } | undefined;
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
  it.each(["failed", "cancelled", "timeout"] as const)(
    "recovers each accepted input document after a %s Run with steering",
    async (status) => {
      if (status === "timeout") {
        // Heartbeat expiry is an operator boundary; isolate its global sweep.
        await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
      }
      let clock = now();
      const owned = await publicChatActor(context, {
        clockTime: () => {
          return clock;
        },
      });
      const { actor } = owned;
      const initialText = "Initial request A";
      const initialContext = "Initial-only execution context A";
      const active = await owned.sendChatRun(actor, {
        prompt: initialText,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: initialText },
            { type: "additional_info", text: initialContext },
          ],
        },
      });
      const execution = await owned.runExecution(active.runId);
      const steeringText = "Steering request B";
      const steeringContext = "Steering-only execution context B";
      const eventId = randomUUID();
      await owned.requestSendEvent(
        actor,
        {
          threadId: active.threadId,
          clientEventId: eventId,
          prompt: steeringText,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: steeringText },
              { type: "additional_info", text: steeringContext },
            ],
          },
        },
        [201],
      );
      const steering = await owned.run(() => {
        return api.nextSteerableInput(
          execution.execution.sandboxToken,
          active.runId,
        );
      });
      expect(steering).toStrictEqual({
        input: {
          eventId,
          prompt: `${steeringContext}\n\n${steeringText}`,
        },
      });
      await owned.run(() => {
        return api.declareSteeredInput(
          execution.execution.sandboxToken,
          active.runId,
          eventId,
        );
      });
      await owned.run(() => {
        return webhooks.requestAgentEvents(
          {
            runId: active.runId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 0,
                message: {
                  content: [
                    { type: "text", text: "Partial answer after steering B" },
                  ],
                },
              },
            ],
          },
          execution.sandboxHeaders,
          [200],
        );
      });
      await owned.run(flushWaitUntilForTest);
      if (status === "failed") {
        await owned.run(() => {
          return failChatRun(
            active.runId,
            execution.sandboxHeaders,
            "Runner failed after steering",
          );
        });
      } else if (status === "cancelled") {
        await owned.run(() => {
          return cancelChatRun(actor, active.runId, execution.sandboxHeaders);
        });
      } else {
        clock = now() + 121_000;
        await owned.run(async () => {
          await accept(
            setupApp({ context, routes: cronCleanupSandboxesRoutes })(
              cronCleanupSandboxesContract,
            ).cleanup({
              headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
            }),
            [200],
          );
        });
        await owned.run(() => {
          return createRunsApi(context).registerDirectRunner(owned.runnerGroup);
        });
      }
      await owned.run(flushWaitUntilForTest);
      await expect(
        owned.run(() => {
          return api.readRun(actor, active.runId);
        }),
      ).resolves.toMatchObject({ status });

      const next = await owned.sendChatRun(actor, {
        threadId: active.threadId,
        prompt: "Continue after the interrupted Run",
      });
      const recovered = await owned.runExecution(next.runId);
      const appended = recovered.execution.appendSystemPrompt ?? "";
      expect(appended).toContain("# Incomplete Rounds Context");
      expect(appended).toContain(`RUN_STATUS: ${status}`);
      expect(
        appended.split("\n").filter((line) => {
          return line.startsWith("User: ");
        }),
      ).toStrictEqual([`User: ${initialContext}`, `User: ${steeringContext}`]);
      expect(appended).toContain(`User: ${initialContext}\n\n${initialText}`);
      expect(appended).toContain(`User: ${steeringContext}\n\n${steeringText}`);
      expect(appended).toContain(
        "Assistant (partial): Partial answer after steering B",
      );
      expect(recovered.execution.prompt).toBe(
        "Continue after the interrupted Run",
      );
      await owned.run(() => {
        return completeChatRunOk(next.runId, recovered.sandboxHeaders);
      });
    },
  );

  it("injects incomplete rounds and truncates old content chronologically", async () => {
    const { actor } = await entitledNativeChatActor();

    const anchor = await sendChatRun(actor, {
      prompt: "establish native session history",
    });
    const anchorExecution = await runExecution(anchor.runId);
    await completeChatRunOk(anchor.runId, anchorExecution.sandboxHeaders);
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return messages.some((message) => {
        return (
          message.runId === anchor.runId &&
          message.eventType === "run.completed"
        );
      });
    });

    const first = await sendChatRun(actor, {
      threadId: anchor.threadId,
      prompt: "first incomplete",
    });
    const firstExecution = await runExecution(first.runId);
    expect(firstExecution.execution.appendSystemPrompt).not.toContain(
      "# Incomplete Rounds Context",
    );
    await failChatRun(first.runId, firstExecution.sandboxHeaders, "boom one");
    await readCompletedRunSessionId(context, actor, anchor.runId);

    const longPrompt = `second ${"x".repeat(4100)}`;
    const second = await sendChatRun(actor, {
      threadId: first.threadId,
      prompt: longPrompt,
    });
    const secondExecution = await runExecution(second.runId);
    await failChatRun(second.runId, secondExecution.sandboxHeaders, "boom two");

    const third = await sendChatRun(actor, {
      threadId: first.threadId,
      prompt: "retry after two failures",
    });
    const thirdRun = await api.executionInput(third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended.split("RUN_STATUS: failed")).toHaveLength(3);
    expect(appended).toContain("User: first incomplete");
    expect(appended.indexOf("User: first incomplete")).toBeLessThan(
      appended.indexOf("User: second"),
    );
    expect(appended).toContain("...[truncated]");
    expect(thirdRun.prompt).toBe("retry after two failures");
    const thirdExecution = await runExecution(third.runId);
    expect(thirdExecution.execution.nativeContinuation).toStrictEqual({
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: expect.stringContaining(
        "okou chat messages --output-dir /tmp/okou-chat-history",
      ),
    });
    await completeChatRunOk(third.runId, thirdExecution.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, third.runId),
    ).resolves.toBe(`bdd-cli-${third.runId}`);
  }, 90_000);
});

describe("CHAT-02: prior rounds and thread titles", () => {
  it("leaves prior completed rounds to the session, generates the thread title, and accepts immutable follow-up revokes", async () => {
    const { actor } = await entitledNativeChatActor();
    mockGoogleText();
    let upstreamAuthorization: string | null = null;
    let titleRequests = 0;
    let titleRequestBody: ReturnType<typeof vertexTextRequest> | undefined;
    let followupRequestBody: ReturnType<typeof vertexTextRequest> | undefined;
    server.use(
      http.post(VERTEX_TEXT_URL, async ({ request }) => {
        upstreamAuthorization = request.headers.get("authorization");
        const payload = vertexTextRequest(await request.json(), request.url);
        const systemContent = payload.messages[0]?.content ?? "";
        if (systemContent.includes("recommended follow-up messages")) {
          followupRequestBody = payload;
          return HttpResponse.json({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify([
                        {
                          prompt: "Summarize the migration steps",
                          kind: "talk",
                        },
                      ]),
                    },
                  ],
                },
              },
            ],
          });
        }
        if (systemContent.includes("Generate a short, descriptive title")) {
          titleRequests += 1;
          titleRequestBody = payload;
          return HttpResponse.json({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: "**Migration Plan**",
                    },
                  ],
                },
              },
            ],
          });
        }
        return HttpResponse.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: "Generated summary",
                  },
                ],
              },
            },
          ],
        });
      }),
    );

    const firstPrompt = "plan the API migration";
    const first = await sendChatRun(actor, { prompt: firstPrompt });
    await waitForThreadTitle(actor, first.threadId, "Migration Plan");
    expect(titleRequests).toBe(1);
    expect(upstreamAuthorization).toBe("Bearer synthetic-google-token");
    expect(titleRequestBody).toMatchObject({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      },
    });

    const firstExecution = await runExecution(first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Assistant migration answer"),
    ]);
    await completeChatRunOk(first.runId, firstExecution.sandboxHeaders, {
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
    expect(followupRequestBody).toMatchObject({
      model: "gemini-3.8-flash",
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });
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

    const second = await sendChatRun(actor, {
      threadId: first.threadId,
      prompt: "follow-up question",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Migration Plan");
    expect(titleRequests).toBe(1);
    const secondRun = await api.executionInput(second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(secondRun.prompt).toBe("follow-up question");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);

    await cancelChatRun(actor, second.runId, {
      authorization: `Bearer ${(await api.executionInput(second.runId)).sandboxToken}`,
    });

    await chat.renameThread(actor, first.threadId, "Manual Migration Title");
    const ordinaryInputId = randomUUID();
    const third = await sendChatRun(actor, {
      threadId: first.threadId,
      prompt: "manual title should stay",
      clientEventId: ordinaryInputId,
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Manual Migration Title");
    expect(titleRequests).toBe(1);
    await cancelChatRun(actor, third.runId, {
      authorization: `Bearer ${(await api.executionInput(third.runId)).sandboxToken}`,
    });

    const recommendedFollowupRequest = {
      threadId: first.threadId,
      prompt: "use the recommended follow-up",
      revokesEventId: recommender.id,
      clientEventId: randomUUID(),
    };
    const unrelatedId = await chat.requestSendEvent(
      actor,
      { ...recommendedFollowupRequest, clientEventId: ordinaryInputId },
      [409],
    );
    expect(unrelatedId.body).toMatchObject({
      error: { message: "clientEventId is already in use" },
    });
    const competingFollowupRequest = {
      ...recommendedFollowupRequest,
      clientEventId: randomUUID(),
    };
    const attempts = await Promise.all(
      [
        recommendedFollowupRequest,
        competingFollowupRequest,
        recommendedFollowupRequest,
        competingFollowupRequest,
      ].map(async (request) => {
        return {
          request,
          response: await chat.requestSendEvent(actor, request, [201, 409]),
        };
      }),
    );
    expect(
      attempts
        .map(({ response }) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 201, 409, 409]);
    const acceptedAttempt = attempts.find(({ response }) => {
      return response.status === 201;
    });
    if (!acceptedAttempt) {
      throw new Error("Expected a recommended follow-up send to succeed");
    }
    const { response: normalFollowup, request: acceptedRequest } =
      acceptedAttempt;
    for (const { request, response } of attempts) {
      if (request.clientEventId === acceptedRequest.clientEventId) {
        expect(response.status).toBe(201);
        expect(response.body).toStrictEqual(normalFollowup.body);
      } else {
        expect(response.status).toBe(409);
      }
    }
    const recommendedFollowupQueueEventId = acceptedRequest.clientEventId;
    if (normalFollowup.status !== 201) {
      throw new Error("Expected recommended follow-up send to succeed");
    }
    const retriedFollowup = await chat.requestSendEvent(
      actor,
      acceptedRequest,
      [201],
    );
    expect(retriedFollowup.body).toStrictEqual(normalFollowup.body);
    const rejectedAttempt = attempts.find(({ response }) => {
      return response.status === 409;
    });
    if (!rejectedAttempt) {
      throw new Error(
        "Expected a competing recommended follow-up to be rejected",
      );
    }
    await chat.requestSendEvent(actor, rejectedAttempt.request, [409]);
    await flushWaitUntilForTest();
    const afterFollowup = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === recommendedFollowupQueueEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const normalFollowupRunId = userMessages(afterFollowup.events).find(
      (message) => {
        return message.revokesEventId === recommendedFollowupQueueEventId;
      },
    )?.runId;
    if (normalFollowupRunId === undefined) {
      throw new Error("Expected the recommended follow-up to launch a run");
    }
    expect(
      afterFollowup.events.filter((event) => {
        return event.revokesEventId === recommender.id;
      }),
    ).toHaveLength(1);
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
    const { actor } = await entitledNativeChatActor();
    mockGoogleText();
    server.use(
      http.post(VERTEX_TEXT_URL, async ({ request }) => {
        const payload = vertexTextRequest(await request.json(), request.url);
        const systemContent = payload.messages[0]?.content ?? "";
        return HttpResponse.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: systemContent.includes(
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
                ],
              },
            },
          ],
        });
      }),
    );

    const completed = await sendChatRun(actor, {
      prompt: "prepare a recommended follow-up",
    });
    const completedExecution = await runExecution(completed.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "A completed answer with follow-ups"),
    ]);
    await completeChatRunOk(
      completed.runId,
      completedExecution.sandboxHeaders,
      {
        lastEventSequence: 0,
      },
    );
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
      threadId: completed.threadId,
      prompt: "keep working while the follow-up is steered",
    });
    const activeExecution = await runExecution(active.runId);
    const eventId = randomUUID();
    const followup = await chat.requestSendEvent(
      actor,
      {
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
    await expect(
      api.nextSteerableInput(
        activeExecution.execution.sandboxToken,
        active.runId,
      ),
    ).resolves.toStrictEqual({
      input: { eventId, prompt: "steer the recommended follow-up" },
    });
    await expect(
      api.declareSteeredInput(
        activeExecution.execution.sandboxToken,
        active.runId,
        eventId,
      ),
    ).resolves.toStrictEqual({ outcome: "steered" });

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
