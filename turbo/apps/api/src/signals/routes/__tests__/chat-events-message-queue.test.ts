import { createHash, randomUUID } from "node:crypto";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import {
  ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@okouai/api-contracts/contracts/runners";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  completeRunWithoutCallbacksFixture,
  holdChatThreadRowLockFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError } from "./helpers/api-bdd";
import { cleanupTimedOutRun } from "./helpers/api-bdd-run-timeout";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  readThreadSessionBinding,
  steerRunTimeBudgetFixture,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  type PromptMessage,
  userMessageWithTemplate,
  assistantMessages,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  api,
  chat,
  webhooks,
  chatCallbacks,
  entitledChatActor,
  sendChatRun,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

const RUN_TIME_BUDGET_STEER_AT_MS = 115 * 60 * 1000;

const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;

/** Steer one owned run without scanning rows owned by other test files. */
async function steerOwnedRunAtElapsedTime(
  runId: string,
  elapsedMs: number,
): Promise<{ readonly scanned: number; readonly steered: number }> {
  return await steerRunTimeBudgetFixture(context, runId, elapsedMs);
}

describe("CHAT-02: queueing and recalling messages", () => {
  it("returns an empty active-input poll without waiting for the thread row", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "keep the empty active-input poll observational",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: active.threadId,
      signal: context.signal,
    });
    let reserveSettled = false;
    const reserveOutcome = api
      .reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId)
      .then(
        (value) => {
          reserveSettled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          reserveSettled = true;
          return { ok: false as const, error };
        },
      );
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
      await reserveOutcome;
    });

    await expect
      .poll(() => {
        return reserveSettled;
      })
      .toBeTruthy();
    const outcome = await reserveOutcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value).toStrictEqual({ outcome: "empty" });
    await expect(threadLock.blockedWaiterCount()).resolves.toBe(0);

    threadLock.release();
    await threadLock.done;
    await cancelChatRun(actor, active.runId);
  }, 30_000);

  it("reserves rich inputs one at a time and settles concurrent receipts once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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

    const reservations = await Promise.all([
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ]);
    const [firstReservation, concurrentReservation] = reservations;
    if (
      firstReservation.outcome !== "reserved" ||
      concurrentReservation.outcome !== "reserved"
    ) {
      throw new Error("Expected both concurrent reservations to succeed");
    }
    expect(concurrentReservation).toStrictEqual(firstReservation);
    expect(firstReservation.eventIds).toStrictEqual([firstEventId]);
    expect(firstReservation.prompt).toBe("first durable steer");

    // Model a lost first response: retry must retrieve the same durable delivery.
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual(firstReservation);

    context.mocks.ably.publish.mockClear();
    const receipts = await Promise.all([
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
    ]);
    expect(receipts).toStrictEqual([
      { outcome: "delivered" },
      { outcome: "delivered" },
    ]);
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
      runId: active.runId,
    });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === "active-input";
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);

    const secondReservation = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (secondReservation.outcome !== "reserved") {
      throw new Error("Expected the second input to be reserved");
    }
    expect(secondReservation.deliveryId).not.toBe(firstReservation.deliveryId);
    expect(secondReservation.eventIds).toStrictEqual([secondEventId]);
    expect(secondReservation.prompt).toBe(
      [
        "Create a video.\nDuration: 6s.",
        `[Web file] delivery-notes.txt (text/plain)\n   [ID] ${fileId}`,
        "second durable steer",
      ].join("\n\n"),
    );
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        secondReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(2);
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const events = await chat.listThreadEvents(actor, active.threadId);
    const replacements = events.events.filter((event) => {
      return (
        event.runId === active.runId &&
        (event.revokesEventId === firstEventId ||
          event.revokesEventId === secondEventId)
      );
    });
    expect(
      replacements.map((event) => {
        return event.revokesEventId;
      }),
    ).toStrictEqual([firstEventId, secondEventId]);
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("finalizes delivered input from completion receipts exactly once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "complete a durable delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "accepted before completion",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected completion input to be reserved");
    }

    const history = `bdd chat session history ${active.runId}`;
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const completion = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 0,
        activeInputDeliveryIds: [reserved.deliveryId],
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${active.runId}`,
          cliAgentSessionHistoryHash: createHash("sha256")
            .update(history)
            .digest("hex"),
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completion).toMatchObject({
      body: { success: true, status: "completed" },
    });
    await flushWaitUntilForTest();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const duplicate = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "late fallback completion",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(duplicate.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
  }, 90_000);

  it("settles delivered input with the terminal run transition", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "complete with a durable delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "settle with the terminal transition",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected terminal input to be reserved");
    }

    const history = `bdd combined delivery history ${active.runId}`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const completed = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 0,
        activeInputDeliveryIds: [reserved.deliveryId],
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-combined-delivery-${active.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completed.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    expect((await api.readRun(actor, active.runId)).status).toBe("completed");
    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
  }, 90_000);

  it("finalizes a late receipt without replaying terminal callbacks", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "leave a terminal delivery open",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "finalize after the terminal transition",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected late completion input to be reserved");
    }
    await completeRunWithoutCallbacksFixture({ runId: active.runId });

    const completed = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "duplicate fallback",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completed.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
  }, 90_000);

  it("releases prompts and expires budget input before draining in FIFO order", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the released prompt to be reserved");
    }
    expect(reserved.eventIds).toStrictEqual([releasedEventId]);
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
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "rejected" });

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

  it("keeps cancelled deliveries as barriers after recovery expiry", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "cancel with a held delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "accepted before cancellation",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected cancelled input to be reserved");
    }
    await api.requestCancelRun(actor, active.runId, [200]);
    await waitForRunStatus(actor, active.runId, "cancelled");

    mockNow(now() + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    onTestFinished(() => {
      clearMockNow();
    });
    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "wait behind stale cancellation recovery",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected post-cancellation input to remain queued");
    }
    expect(later.body.runId).toBeNull();
    const beforeCompletion = await chat.listThreadEvents(
      actor,
      active.threadId,
    );
    expect(
      userMessages(beforeCompletion.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);

    await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "Run cancelled",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    clearMockNow();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === laterEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === laterEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected the post-cancellation input to start a run");
    }
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === heldEventId &&
          message.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    const successorClaim = await claimChatRun(runnerGroup, successor);
    await cancelChatRun(actor, successor, successorClaim.sandboxHeaders);
  }, 90_000);

  it("settles timed-out delivery input when stopping the Runner fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected timeout input to be reserved");
    }
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
      orgId: actor.orgId,
    });
    expect(cleanup.body).toMatchObject({ cleaned: 1, errors: 0 });
    await waitForRunStatus(actor, active.runId, "timeout");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: active.runId,
      mode: "hard",
    });
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "rejected" });

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

  it("cascades delivery state when its thread is deleted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "delete a thread with reserved input",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "delete this reserved input",
        clientEventId: randomUUID(),
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected deleted thread input to be reserved");
    }

    await chat.deleteThread(actor, active.threadId);
    const missingDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${claimed.claim.sandboxToken}`,
      active.runId,
      reserved.deliveryId,
      [403],
    );
    expectApiError(missingDelivery.body);
    expect(missingDelivery.body.error.code).toBe("FORBIDDEN");
    await failChatRun(
      active.runId,
      claimed.sandboxHeaders,
      "Thread deleted during execution",
    );
    await flushWaitUntilForTest();

    const unrelated = await sendChatRun(actor, {
      agentId,
      prompt: "run after deleting another delivery thread",
    });
    const unrelatedClaim = await claimChatRun(runnerGroup, unrelated.runId);
    await cancelChatRun(actor, unrelated.runId, unrelatedClaim.sandboxHeaders);
  }, 90_000);

  it("classifies delivery lifecycle and authorization without route-level 404", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const emptyRun = await sendChatRun(actor, {
      agentId,
      prompt: "empty durable delivery",
    });
    const preclaimSandboxToken = api.sandboxTokenForRun(actor, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(preclaimSandboxToken, emptyRun.runId),
    ).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "run_not_running",
    });
    const emptyClaim = await claimChatRun(runnerGroup, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        emptyClaim.claim.sandboxToken,
        emptyRun.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const missingAuth = await api.requestReserveRunnerActiveInputsAs(
      undefined,
      emptyRun.runId,
      [401],
    );
    expectApiError(missingAuth.body);
    const cli = await api.createCliToken(actor);
    const wrongCredential = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${cli.token}`,
      emptyRun.runId,
      [403],
    );
    expectApiError(wrongCredential.body);

    const peer = bdd.user();
    const wrongTenantToken = api.sandboxTokenForRun(peer, emptyRun.runId);
    const wrongTenant = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${wrongTenantToken}`,
      emptyRun.runId,
      [403],
    );
    expectApiError(wrongTenant.body);
    const randomDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      emptyRun.runId,
      randomUUID(),
      [403],
    );
    expectApiError(randomDelivery.body);

    await cancelChatRun(actor, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        emptyClaim.claim.sandboxToken,
        emptyRun.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "terminal" });

    const heldRun = await sendChatRun(actor, {
      agentId,
      prompt: "hold durable delivery after termination",
    });
    const heldClaim = await claimChatRun(runnerGroup, heldRun.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: heldRun.threadId,
        prompt: "remain held",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      heldClaim.claim.sandboxToken,
      heldRun.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected an active-input delivery reservation");
    }
    const wrongRun = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      heldRun.runId,
      [403],
    );
    expectApiError(wrongRun.body);
    const crossDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      emptyRun.runId,
      reserved.deliveryId,
      [403],
    );
    expectApiError(crossDelivery.body);

    await cancelChatRun(actor, heldRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        heldClaim.claim.sandboxToken,
        heldRun.runId,
      ),
    ).resolves.toStrictEqual({
      outcome: "held",
      deliveryId: reserved.deliveryId,
      eventIds: [heldEventId],
    });
  }, 90_000);

  it("applies the delivery-aware payload limit without consuming rejection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    const exact = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (exact.outcome !== "reserved") {
      throw new Error("Expected exact-limit delivery to be reserved");
    }
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "active-input",
          deliveryId: exact.deliveryId,
          text: exact.prompt,
        }),
        "utf8",
      ),
    ).toBe(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES);
    await api.recordRunnerActiveInputDelivery(
      claimed.claim.sandboxToken,
      active.runId,
      exact.deliveryId,
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
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "payload_too_large",
    });
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

  it("reserves and settles a run-scoped budget input", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "reserve the time budget warning",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 1 });
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the budget input to be reserved");
    }
    expect(reserved.prompt).toBe(RUN_TIME_BUDGET_MESSAGE);
    expect(reserved.eventIds).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.budget",
        runId: active.runId,
        revokesEventId: reserved.eventIds[0],
      }),
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("steers a run once when it reaches its time budget", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run until the time budget warning",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);

    await expect(
      steerOwnedRunAtElapsedTime(
        active.runId,
        RUN_TIME_BUDGET_STEER_AT_MS - 60_000,
      ),
    ).resolves.toStrictEqual({ scanned: 0, steered: 0 });
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });

    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 1 });
    const budgetReservation = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (budgetReservation.outcome !== "reserved") {
      throw new Error("Expected the run time budget input to be reserved");
    }
    expect(budgetReservation.eventIds).toHaveLength(1);
    expect(budgetReservation.prompt).toBe(RUN_TIME_BUDGET_MESSAGE);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        budgetReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const publicEvents = await chat.listThreadEvents(actor, active.threadId);
    const budgetEvent = publicEvents.events.find((event) => {
      return (
        event.eventType === "input.budget" &&
        event.runId === active.runId &&
        chatEventDisplayText(event) === RUN_TIME_BUDGET_MESSAGE
      );
    });
    if (!budgetEvent || budgetEvent.eventType !== "input.budget") {
      throw new Error("Expected the run time budget input to be claimed");
    }
    expect(
      budgetEvent.userMessage.parts.some((part) => {
        return part.type === "model";
      }),
    ).toBeFalsy();

    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 0 });
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });

    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("does not carry an undelivered time budget input into a later run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "leave the budget input unclaimed",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await steerOwnedRunAtElapsedTime(first.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    const firstBudget = await api.reserveRunnerActiveInputs(
      firstClaim.claim.sandboxToken,
      first.runId,
    );
    expect(firstBudget).toMatchObject({
      outcome: "reserved",
      prompt: RUN_TIME_BUDGET_MESSAGE,
    });

    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "start a later run",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        secondClaim.claim.sandboxToken,
        second.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "empty" });
    await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
  }, 90_000);

  it("queues, retries, and recalls messages behind an active run", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
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
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
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
    expect(queuedRetry.body).toStrictEqual(queued.body);
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-opus-4-8",
    );

    // Another user's send cannot claim the queued message's client id.
    const { actor: stranger, agentId: strangerAgentId } =
      await entitledChatActor();
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
      [409],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.message).toBe(
      "clientEventId is already in use",
    );
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

  it("keeps a gap after concurrent idempotent sends reserve the same event", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Concurrent idempotent send thread",
    });
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const clientEventId = randomUUID();
    const sendEvent = () => {
      return chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send once through two concurrent requests",
          clientEventId,
        },
        [201],
      );
    };
    const sends = [sendEvent(), sendEvent()];
    await expect.poll(threadLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    threadLock.release();
    await threadLock.done;

    const responses = await Promise.all(sends);
    const runIds = new Set<string>();
    for (const response of responses) {
      if (response.status !== 201) {
        throw new Error("Expected both concurrent sends to be accepted");
      }
      if (response.body.runId !== null) {
        runIds.add(response.body.runId);
      }
    }
    expect(runIds.size).toBe(1);

    const messages = await chat.listThreadEvents(actor, thread.id);
    const seqIds = messages.events.map((event) => {
      return event.seqId;
    });
    expect(
      seqIds.some((seqId, index) => {
        const previousSeqId = seqIds[index - 1];
        return previousSeqId !== undefined && seqId > previousSeqId + 1;
      }),
    ).toBeTruthy();

    for (const runId of runIds) {
      await cancelChatRun(actor, runId);
    }
  }, 90_000);

  it("keeps a queued message when recall targets another owned thread", async () => {
    const { actor, agentId } = await entitledChatActor();
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

describe("CHAT-02: org queue markers", () => {
  it("marks queued chat runs and revokes the marker on dequeue", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "occupy org concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queuedRun = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "wait behind the active run" },
      [201],
    );
    if (queuedRun.status !== 201 || queuedRun.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queuedRun.body.status).toBe("queued");
    const queuedBinding = await readThreadSessionBinding(
      context,
      queuedRun.body.threadId,
    );
    expect(queuedBinding.agent_session_run_id).toBe(queuedRun.body.runId);
    expect(queuedBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(queuedBinding.run_session_id).toBe(queuedBinding.agent_session_id);

    const queuedThread = queuedRun.body.threadId;
    const beforeDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return message.runId === queuedRun.body.runId;
          }) &&
          assistantMessages(items).some((message) => {
            return message.runEventId === "queue:queued";
          })
        );
      },
    );
    const queuedRunUserRows = userMessages(beforeDequeue.events);
    expect(queuedRunUserRows).toHaveLength(2);
    const queuedRunMessage = queuedRunUserRows.find((message) => {
      return message.runId === queuedRun.body.runId;
    });
    expect(queuedRunMessage).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
    });
    expect(chatEventDisplayText(queuedRunMessage!)).toBe(
      "wait behind the active run",
    );
    expect(queuedRunMessage?.revokesEventId).toBeDefined();
    const queuedRunOriginal = queuedRunUserRows.find((message) => {
      return message.id === queuedRunMessage?.revokesEventId;
    });
    expect(queuedRunOriginal?.content).toBeNull();
    expect(chatEventDisplayText(queuedRunOriginal!)).toBe(
      "wait behind the active run",
    );
    expect(queuedRunOriginal?.runId).toBeUndefined();
    const marker = assistantMessages(beforeDequeue.events).find((message) => {
      return message.runEventId === "queue:queued";
    });
    if (!marker) {
      throw new Error("Expected an assistant queue marker");
    }
    expect(marker).toMatchObject({
      content: "Waiting in queue...",
      runId: queuedRun.body.runId,
    });

    // The queued run still counts as the thread's active run, so a presentation
    // runbook selection queues as an unassociated message carrying that
    // selection.
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "presentation",
      selection: {
        templateId: template.templateId,
      },
    };
    const templateMessageId = randomUUID();
    const queuedTemplate = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: queuedThread,
        prompt: "template queued deck",
        userMessage: userMessageWithTemplate(
          "template queued deck",
          generationTemplate,
        ),
        clientEventId: templateMessageId,
      },
      [201],
    );
    expect(queuedTemplate.body).toMatchObject({ runId: null });
    const withTemplate = await chat.listThreadEvents(actor, queuedThread);
    const templateMessage = userMessages(withTemplate.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.id === templateMessageId
        );
      },
    );
    expect(templateMessage?.userMessage?.parts).toContainEqual(
      expect.objectContaining({
        type: "template",
        template: generationTemplate,
      }),
    );

    const queueBefore = await api.readRunQueue(actor);
    expect(queueBefore.body.queue).toHaveLength(1);
    expect(queueBefore.body.queue[0]).toMatchObject({
      runId: queuedRun.body.runId,
    });

    // Recall the queued template message so the dequeue does not auto-send it.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: queuedThread,
        revokesEventId: templateMessageId,
        clientEventId: randomUUID(),
      },
      [201],
    );

    // Interrupting the blocking run drains the org queue and revokes the
    // queue marker on the dequeued run's thread.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: blocker.body.threadId,
        interruptsRunId: blocker.body.runId,
        clientEventId: randomUUID(),
      },
      [201],
    );

    await waitForRunStatus(actor, blocker.body.runId, "cancelled");
    await waitForRunStatus(actor, queuedRun.body.runId, "pending");
    const afterDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return assistantMessages(items).some((message) => {
          return message.runEventId === "queue:dequeued";
        });
      },
    );
    const revoker = assistantMessages(afterDequeue.events).find((message) => {
      return message.runEventId === "queue:dequeued";
    });
    if (!revoker) {
      throw new Error("Expected an assistant queue-dequeued revoker");
    }
    expect(revoker).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
      revokesEventId: marker.id,
    });
    const queueAfter = await api.readRunQueue(actor);
    expect(queueAfter.body.queue).toHaveLength(0);

    await cancelChatRun(actor, queuedRun.body.runId);
    expect((await api.readRun(actor, queuedRun.body.runId)).status).toBe(
      "cancelled",
    );
  }, 90_000);
});
