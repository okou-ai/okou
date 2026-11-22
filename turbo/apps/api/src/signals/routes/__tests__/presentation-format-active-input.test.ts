import { randomUUID } from "node:crypto";
import { presentationFormatContract } from "@okouai/api-contracts/contracts/presentation-format";
import { STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE } from "@okouai/api-contracts/contracts/runners";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { presentationFormatRoutes } from "../presentation-format";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

test("keeps a confirmed presentation for the next Run without letting later prompts overtake it", async () => {
  mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
  const { actor, runnerGroup } = await entitledNativeChatActor({
    userId: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
  });
  const originalEventId = randomUUID();
  const source = await sendChatRun(actor, {
    prompt: "Create a three-slide presentation about the launch plan.",
    clientEventId: originalEventId,
    model: "claude-fable-5-1",
  });
  const sourceExecution = await runExecution(source.runId);
  await failChatRun(
    source.runId,
    sourceExecution.sandboxHeaders,
    "Awaiting the presentation format",
  );
  await flushWaitUntilForTest();

  // The source thread is idle while another thread holds the organization's
  // only slot. This is a public way for an earlier ordinary prompt and a
  // confirmed continuation to queue before that ordinary prompt starts.
  const blocker = await sendChatRun(actor, { prompt: "Occupy the Run slot" });
  const blockerExecution = await runExecution(blocker.runId);
  const earlierEventId = randomUUID();
  await chat.requestSendEvent(
    actor,
    {
      threadId: source.threadId,
      clientEventId: earlierEventId,
      prompt: "Review an unrelated release task first.",
    },
    [201],
  );
  await flushWaitUntilForTest();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const confirmed = await accept(
    setupApp({ context, routes: presentationFormatRoutes })(
      presentationFormatContract,
    ).confirm({
      headers: { authorization: "Bearer clerk-session" },
      body: { sourceRunId: source.runId, presentationFormat: "pptx" },
    }),
    [200],
  );
  const continuationEventId = confirmed.body.continuationEventId;
  await flushWaitUntilForTest();
  await completeChatRunOk(blocker.runId, blockerExecution.sandboxHeaders);
  await flushWaitUntilForTest();

  const started = (
    await chat.listThreadEvents(actor, source.threadId)
  ).events.find((event) => {
    return event.revokesEventId === earlierEventId;
  });
  if (!started?.runId) {
    throw new Error("Expected the earlier ordinary prompt to launch first");
  }
  const activeRunId = started.runId;
  const activeExecution = await runExecution(activeRunId);
  const token = activeExecution.execution.sandboxToken;
  await expect(
    api.nextSteerableInput(token, activeRunId),
  ).resolves.toStrictEqual({ input: null });

  context.mocks.ably.publish.mockClear();
  const laterEventId = randomUUID();
  await chat.requestSendEvent(
    actor,
    {
      threadId: source.threadId,
      clientEventId: laterEventId,
      prompt: "This later prompt must stay behind the presentation.",
    },
    [201],
  );
  await flushWaitUntilForTest();
  expect(context.mocks.ably.publish).not.toHaveBeenCalledWith("active-input", {
    runId: activeRunId,
  });
  await expect(
    api.nextSteerableInput(token, activeRunId),
  ).resolves.toStrictEqual({ input: null });

  // A Runner cannot bypass the read endpoint by declaring the selection or a
  // later prompt directly. The latter exercises the final SQL eligibility.
  for (const eventId of [continuationEventId, laterEventId]) {
    const rejected = await api.requestDeclareSteeredInputAs(
      `Bearer ${token}`,
      activeRunId,
      eventId,
      [409],
    );
    expect(rejected.body.error.code).toBe(
      STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
    );
  }

  // Time warnings target the active Run, not the ordinary prompt FIFO. A
  // selection must not hide its budget notification or block its consumption.
  const active = await api.readRun(actor, activeRunId);
  if (!active.startedAt) {
    throw new Error("Expected the active Run's public start time");
  }
  mockNow(Date.parse(active.startedAt) + 115 * 60 * 1000);
  await createWebhookCallbackApi(context).requestAgentHeartbeat(
    { runId: activeRunId },
    activeExecution.sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  const budget = (
    await chat.listThreadEvents(actor, source.threadId)
  ).events.find((event) => {
    return event.eventType === "input.budget" && event.runId === undefined;
  });
  if (!budget) {
    throw new Error("Expected the active Run's budget warning");
  }
  expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
    runId: activeRunId,
  });
  expect(
    (await api.nextSteerableInput(token, activeRunId)).input?.eventId,
  ).toBe(budget.id);
  await api.declareSteeredInput(token, activeRunId, budget.id);
  await expect(
    api.nextSteerableInput(token, activeRunId),
  ).resolves.toStrictEqual({ input: null });

  // Advancing the wall clock also expires the registered Runner heartbeat.
  await createRunsApi(context).registerDirectRunner(runnerGroup);
  await completeChatRunOk(activeRunId, activeExecution.sandboxHeaders);
  await flushWaitUntilForTest();
  const events = (await chat.listThreadEvents(actor, source.threadId)).events;
  const continuation = events.find((event) => {
    return event.revokesEventId === continuationEventId;
  });
  if (!continuation?.runId) {
    throw new Error(
      "Expected the presentation to launch through normal admission",
    );
  }
  expect(continuation.runId).not.toBe(activeRunId);
  expect(
    events.filter((event) => {
      return event.revokesEventId === laterEventId;
    }),
  ).toStrictEqual([]);
  expect(continuation).toMatchObject({
    eventType: "input.prompt",
    userMessage: {
      version: 1,
      parts: expect.arrayContaining([
        {
          type: "presentation_format_selection",
          sourceRunId: source.runId,
          sourceInputEventIds: [originalEventId],
          presentationFormat: "pptx",
        },
      ]),
    },
  });
  const presentationExecution = await runExecution(continuation.runId);
  expect(presentationExecution.execution.prompt).toContain(
    "Presentation output format selected for this task: PPTX.",
  );
  await expect(
    api.nextSteerableInput(
      presentationExecution.execution.sandboxToken,
      continuation.runId,
    ),
  ).resolves.toMatchObject({ input: { eventId: laterEventId } });
  await api.declareSteeredInput(
    presentationExecution.execution.sandboxToken,
    continuation.runId,
    laterEventId,
  );
  await cancelChatRun(
    actor,
    continuation.runId,
    presentationExecution.sandboxHeaders,
  );
}, 90_000);
