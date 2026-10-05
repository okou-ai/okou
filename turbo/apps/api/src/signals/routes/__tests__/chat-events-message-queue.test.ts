import {
  ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
} from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { expectApiError } from "./helpers/api-bdd";
import { cleanupTimedOutRun } from "./helpers/api-bdd-run-timeout";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { steerRunTimeBudgetFixture } from "./helpers/runtime-state";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
} = createChatEventsFixture(context);

const RUN_TIME_BUDGET_STEER_AT_MS = 115 * 60 * 1000;

const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;

/** Run the queue repair sweep over one owned thread. */
async function sweepOwnedThreadQueue(chatThreadId: string): Promise<void> {
  await accept(
    setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
      testCronCleanupSandboxesStateContract,
    ).cleanup({
      body: {
        chatThreadIds: [chatThreadId],
        runIds: [],
        exportJobIds: [],
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

/** Cancel a claimed run and queue a prompt behind its recovery barrier. */
async function queueBehindCancellationRecovery(label: string) {
  const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
  const active = await sendChatRun(actor, {
    agentId,
    prompt: `${label} cancelled run`,
  });
  await claimChatRun(runnerGroup, active.runId);
  await api.requestCancelRun(actor, active.runId, [200]);
  await waitForRunStatus(actor, active.runId, "cancelled");
  const queuedEventId = randomUUID();
  const queued = await chat.requestSendEvent(
    actor,
    {
      agentId,
      threadId: active.threadId,
      prompt: `${label} queued prompt`,
      clientEventId: queuedEventId,
    },
    [201],
  );
  if (queued.status !== 201) {
    throw new Error("Expected the prompt to queue behind cancellation");
  }
  expect(queued.body.runId).toBeNull();
  return {
    actor,
    threadId: active.threadId,
    runId: active.runId,
    queuedEventId,
  };
}

/** Steer one owned run without scanning rows owned by other test files. */
async function steerOwnedRunAtElapsedTime(
  runId: string,
  elapsedMs: number,
): Promise<{ readonly scanned: number; readonly steered: number }> {
  return await steerRunTimeBudgetFixture(context, runId, elapsedMs);
}

describe("CHAT-02: queueing and recalling messages", () => {
  it("steers rich inputs one at a time and settles concurrent declarations once", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "anchor durable active input delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const fileId = randomUUID();
    chat.mockCompletedUploadObject(actor, fileId, "delivery-notes.txt", 23);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "first durable steer",
        clientEventId: firstEventId,
      },
      [201],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "second durable steer",
        clientEventId: secondEventId,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "additional_info",
              text: "Create a video.\nDuration: 6s.",
            },
            {
              type: "file",
              fileId,
              filenameSnapshot: "delivery-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "second durable steer" },
          ],
        },
      },
      [201],
    );

    const reads = await Promise.all([
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ]);
    const [firstRead, concurrentRead] = reads;
    expect(concurrentRead).toStrictEqual(firstRead);
    expect(firstRead).toStrictEqual({
      input: { eventId: firstEventId, prompt: "first durable steer" },
    });

    // Model a lost first response: a retry reads the same pending input.
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual(firstRead);

    // Enqueue notifications run in waitUntil; finish them before counting the
    // notifications owned by the concurrent steering declarations.
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    const declarations = await Promise.all([
      api.declareSteeredInput(
        claimed.claim.sandboxToken,
        active.runId,
        firstEventId,
      ),
      api.declareSteeredInput(
        claimed.claim.sandboxToken,
        active.runId,
        firstEventId,
      ),
    ]);
    expect(declarations).toStrictEqual([
      { outcome: "steered" },
      { outcome: "steered" },
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
      runId: active.runId,
    });
    await expect(
      api.declareSteeredInput(
        claimed.claim.sandboxToken,
        active.runId,
        firstEventId,
      ),
    ).resolves.toStrictEqual({ outcome: "steered" });
    // Realtime hints may repeat; the public event stream must contain only
    // one replacement after concurrent declarations and a response retry.
    const afterRepeatedDeclaration = await chat.listThreadEvents(
      actor,
      active.threadId,
    );
    const firstReplacements = afterRepeatedDeclaration.events.filter(
      (event) => {
        return event.revokesEventId === firstEventId;
      },
    );
    expect(firstReplacements).toHaveLength(1);
    expect(firstReplacements[0]).toMatchObject({
      eventType: "input.prompt",
      runId: active.runId,
    });

    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: {
        eventId: secondEventId,
        prompt: [
          "Create a video.\nDuration: 6s.",
          `[Web file] delivery-notes.txt (text/plain)\n   [ID] ${fileId}`,
          "second durable steer",
        ].join("\n\n"),
      },
    });
    await expect(
      api.declareSteeredInput(
        claimed.claim.sandboxToken,
        active.runId,
        secondEventId,
      ),
    ).resolves.toStrictEqual({ outcome: "steered" });
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ input: null });
    const events = await chat.listThreadEvents(actor, active.threadId);
    const replacements = events.events.filter((event) => {
      return (
        event.revokesEventId === firstEventId ||
        event.revokesEventId === secondEventId
      );
    });
    expect(
      replacements.map((event) => {
        return {
          eventType: event.eventType,
          runId: event.runId,
          revokesEventId: event.revokesEventId,
        };
      }),
    ).toStrictEqual([
      {
        eventType: "input.prompt",
        runId: active.runId,
        revokesEventId: firstEventId,
      },
      {
        eventType: "input.prompt",
        runId: active.runId,
        revokesEventId: secondEventId,
      },
    ]);
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("steers a message into the running sandbox run by its source event id", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run that receives a steer",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const steerEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "steer into the running run",
        clientEventId: steerEventId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the steer message to be accepted");
    }
    expect(sent.body.runId).toBeNull();

    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: steerEventId, prompt: "steer into the running run" },
    });
    await expect(
      api.declareSteeredInput(
        claimed.claim.sandboxToken,
        active.runId,
        steerEventId,
      ),
    ).resolves.toStrictEqual({ outcome: "steered" });
    await completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, active.runId, "completed");
    await sweepOwnedThreadQueue(active.threadId);
    // A repeated declaration after completion stays idempotent.
    await expect(
      api.declareSteeredInput(
        claimed.claim.sandboxToken,
        active.runId,
        steerEventId,
      ),
    ).resolves.toStrictEqual({ outcome: "steered" });

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      userMessages(events.events)
        .filter((message) => {
          return message.revokesEventId === steerEventId;
        })
        .map((message) => {
          return message.runId;
        }),
    ).toStrictEqual([active.runId]);
    expect(
      userMessages(events.events).filter((message) => {
        return (
          typeof message.runId === "string" && message.runId !== active.runId
        );
      }),
    ).toHaveLength(0);
  }, 90_000);

  it("releases prompts and expires budget input before draining in FIFO order", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "finalize an unconfirmed delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const releasedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "released queue head",
        clientEventId: releasedEventId,
      },
      [201],
    );
    await steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    // Read but never declared steered: completion leaves it queued.
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: releasedEventId, prompt: "released queue head" },
    });
    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "later queue input",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected later input to remain queued");
    }
    expect(later.body.runId).toBeNull();

    await completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === releasedEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === releasedEventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the released queue head to be promoted");
    }
    expect(
      messages.events.filter((event) => {
        return (
          event.eventType === "control.revoke" &&
          event.runId === active.runId &&
          event.revokesEventId !== releasedEventId
        );
      }),
    ).toHaveLength(1);
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);

    const successorClaim = await claimChatRun(runnerGroup, promoted.runId);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: laterEventId,
      },
      [201],
    );
    await cancelChatRun(actor, promoted.runId, successorClaim.sandboxHeaders);
  }, 90_000);

  it("redrives a queue once its cancellation recovery barrier expires", async () => {
    const queued = await queueBehindCancellationRecovery("recent expiry");

    mockNow(now() + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    onTestFinished(() => {
      clearMockNow();
    });
    await sweepOwnedThreadQueue(queued.threadId);
    clearMockNow();

    const messages = await waitForThreadMessages(
      queued.actor,
      queued.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queued.queuedEventId &&
            typeof message.runId === "string" &&
            message.runId !== queued.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queued.queuedEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected the queued prompt to start a run");
    }
    expect(successor).not.toBe(queued.runId);
    await cancelChatRun(queued.actor, successor);
  }, 90_000);

  it("releases timed-out steerable input when stopping the Runner fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped chat actor");
    }

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "time out with an uncertain delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "release only after teardown completion",
        clientEventId: heldEventId,
      },
      [201],
    );
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: {
        eventId: heldEventId,
        prompt: "release only after teardown completion",
      },
    });
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValueOnce(
      new DOMException("timeout cancel unavailable", "AbortError"),
    );
    mockNow(now() + 3 * 60 * 1000);
    onTestFinished(() => {
      clearMockNow();
    });
    const cleanup = await cleanupTimedOutRun(context, {
      runId: active.runId,
      chatThreadId: active.threadId,
    });
    expect(cleanup.body).toMatchObject({ cleaned: 1, errors: 0 });
    await waitForRunStatus(actor, active.runId, "timeout");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: active.runId,
      mode: "hard",
    });
    const late = await api.requestDeclareSteeredInputAs(
      `Bearer ${claimed.claim.sandboxToken}`,
      active.runId,
      heldEventId,
      [409],
    );
    expect(late.body.error.code).toBe(STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE);

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === heldEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === heldEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected timed-out delivery input to be released");
    }

    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "wait behind the timeout successor",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected post-timeout input to remain queued");
    }
    expect(later.body.runId).toBeNull();
    expect(
      userMessages(
        (await chat.listThreadEvents(actor, active.threadId)).events,
      ).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);
    const successorClaim = await claimChatRun(runnerGroup, successor);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: laterEventId,
      },
      [201],
    );
    await cancelChatRun(actor, successor, successorClaim.sandboxHeaders);
  }, 90_000);

  it("expires an unconsumed time budget input after a heartbeat timeout", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped chat actor");
    }

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "time out before the budget warning is consumed",
    });
    await claimChatRun(runnerGroup, active.runId);
    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 1 });

    mockNow(now() + 3 * 60 * 1000);
    onTestFinished(() => {
      clearMockNow();
    });
    const cleanup = await cleanupTimedOutRun(context, {
      runId: active.runId,
      chatThreadId: active.threadId,
    });
    expect(cleanup.body).toMatchObject({ cleaned: 1, errors: 0 });
    await waitForRunStatus(actor, active.runId, "timeout");

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.eventType === "control.revoke" && event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
  }, 90_000);

  it("applies the control payload limit without consuming an oversized prompt", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "validate durable delivery payload limit",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const emptyDeliveryPayloadBytes = Buffer.byteLength(
      JSON.stringify({
        type: "active-input",
        deliveryId: randomUUID(),
        text: "",
      }),
      "utf8",
    );
    const exactEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - emptyDeliveryPayloadBytes,
        ),
        clientEventId: exactEventId,
      },
      [201],
    );
    const exact = await api.nextSteerableInput(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (!exact.input) {
      throw new Error("Expected the exact-limit input to be steerable");
    }
    expect(exact.input.eventId).toBe(exactEventId);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "active-input",
          deliveryId: exact.input.eventId,
          text: exact.input.prompt,
        }),
        "utf8",
      ),
    ).toBe(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES);
    await api.declareSteeredInput(
      claimed.claim.sandboxToken,
      active.runId,
      exact.input.eventId,
    );

    const oversizedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES -
            emptyDeliveryPayloadBytes +
            1,
        ),
        clientEventId: oversizedEventId,
      },
      [201],
    );
    // An oversized prompt is not steerable and stays queued for the next pick.
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ input: null });
    expect(
      (await chat.listThreadEvents(actor, active.threadId)).events.filter(
        (event) => {
          return event.revokesEventId === oversizedEventId;
        },
      ),
    ).toHaveLength(0);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: oversizedEventId,
      },
      [201],
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("steers a run once when it reaches its time budget", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run until the time budget warning",
    });
    await claimChatRun(runnerGroup, active.runId);

    await expect(
      steerOwnedRunAtElapsedTime(
        active.runId,
        RUN_TIME_BUDGET_STEER_AT_MS - 60_000,
      ),
    ).resolves.toStrictEqual({ scanned: 0, steered: 0 });

    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 1 });
    const publicEvents = await chat.listThreadEvents(actor, active.threadId);
    const budgetEvent = publicEvents.events.find((event) => {
      return (
        event.eventType === "input.budget" &&
        chatEventDisplayText(event) === RUN_TIME_BUDGET_MESSAGE
      );
    });
    if (!budgetEvent || budgetEvent.eventType !== "input.budget") {
      throw new Error("Expected the run time budget input to be appended");
    }
    expect(
      budgetEvent.userMessage.parts.some((part) => {
        return part.type === "model";
      }),
    ).toBeFalsy();

    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 0 });

    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("queues, retries, and recalls messages behind an active run", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "anchor active run",
    });

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientEventId: queuedId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued send to be accepted");
    }
    expect(queued.body.runId).toBeNull();
    await api.updateUserModelPreference(actor, "claude-opus-5");
    const queuedRetry = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queuedRetry.body).toStrictEqual({
      runId: null,
      threadId: first.threadId,
      createdAt: expect.any(String),
    });
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-opus-5",
    );

    // Another user's send cannot claim the queued message's client id: the
    // conflicting insert is accepted as a duplicate and appends nothing.
    const { actor: stranger, agentId: strangerAgentId } =
      await entitledNativeChatActor();
    const strangerThread = await chat.createThread(stranger, {
      agentId: strangerAgentId,
      title: "Cross-user conflict thread",
    });
    const crossUser = await chat.requestSendEvent(
      stranger,
      {
        agentId: strangerAgentId,
        threadId: strangerThread.id,
        prompt: "cross-user retry",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(crossUser.body).toStrictEqual({
      runId: null,
      threadId: strangerThread.id,
      createdAt: expect.any(String),
    });
    const strangerMessages = await chat.listThreadEvents(
      stranger,
      strangerThread.id,
    );
    expect(strangerMessages.events).toStrictEqual([]);

    const strangerRun = await sendChatRun(stranger, {
      agentId: strangerAgentId,
      threadId: strangerThread.id,
      prompt: "first accepted event after the rejected id",
    });
    await cancelChatRun(stranger, strangerRun.runId);

    const beforeRecall = await chat.listThreadEvents(actor, first.threadId);
    expect(
      userMessages(beforeRecall.events).filter((message) => {
        return message.id === queuedId;
      }),
    ).toHaveLength(1);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: queuedId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the recall send to be accepted");
    }
    expect(recalled.body.runId).toBeNull();

    const repeatedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: queuedId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    const afterRepeated = await chat.listThreadEvents(actor, first.threadId);

    // Run-associated messages cannot be recalled.
    const associated = userMessages(afterRepeated.events).find((message) => {
      return message.runId === first.runId;
    });
    if (!associated) {
      throw new Error("Expected the active run's user message to be listed");
    }
    const rejectedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: associated.id,
        clientEventId: randomUUID(),
      },
      [400],
    );
    expectApiError(rejectedRecall.body);
    expect(rejectedRecall.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );

    await cancelChatRun(actor, first.runId);
    expect((await api.readRun(actor, first.runId)).status).toBe("cancelled");
  }, 90_000);

  it("keeps a queued message when recall targets another owned thread", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "cross-thread recall anchor",
    });
    const queuedMessageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "must remain queued in the original thread",
        clientEventId: queuedMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const otherThread = await chat.createThread(actor, {
      agentId,
      title: "Cross-thread recall target",
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: otherThread.id,
        revokesEventId: queuedMessageId,
        clientEventId: randomUUID(),
      },
      [201, 400],
    );

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the original queued message to create a run");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe(
      "must remain queued in the original thread",
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});
