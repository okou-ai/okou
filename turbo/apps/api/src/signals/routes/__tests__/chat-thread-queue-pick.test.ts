import { randomUUID } from "node:crypto";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  claimQueuedChatThreadLeaseFixture,
  readQueuedChatThreadFixture,
} from "../../../test-fixtures/queued-chat-thread";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

/**
 * CHAT-02: pending chat input waits in a per-thread queue row and a picker
 * launches the thread's FIFO head when a slot frees, the organization's
 * capacity grows, or the cron sweep finds a pickable row.
 */
const context = testContext({ connectorCatalog: true });
const {
  chat,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  completeChatRunOk,
  cancelChatRun,
  waitForRunStatus,
  chatCallbacks,
} = createChatEventsFixture(context);

const PICK_LEASE_TTL_MS = 60 * 1000;

/** Run the cron queue sweep scoped to the given threads. */
async function sweepQueuedThreads(chatThreadIds: string[]): Promise<void> {
  await accept(
    setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
      testCronCleanupSandboxesStateContract,
    ).cleanup({
      body: { chatThreadIds, runIds: [], orgIds: [], exportJobIds: [] },
    }),
    [200],
  );
}

/** The run that launched a sent input, or undefined while it still waits. */
async function runOfInput(
  actor: ApiTestUser,
  threadId: string,
  clientEventId: string,
): Promise<string | undefined> {
  const page = await chat.listThreadEvents(actor, threadId);
  return userMessages(page.events).find((message) => {
    return (
      message.revokesEventId === clientEventId && message.runId !== undefined
    );
  })?.runId;
}

async function sendWaiting(
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
  threadId?: string,
) {
  const clientEventId = randomUUID();
  const waiting = await sendWaitingChatInput(actor, {
    agentId,
    prompt,
    clientEventId,
    ...(threadId === undefined ? {} : { threadId }),
  });
  return { ...waiting, clientEventId };
}

describe("CHAT-02: queued chat thread picks", () => {
  it("launches only the FIFO head of a queued thread and resumes its latest session", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the thread session",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const head = await sendWaiting(
      actor,
      agentId,
      "first queued message",
      first.threadId,
    );
    const second = await sendWaiting(
      actor,
      agentId,
      "second queued message",
      first.threadId,
    );

    await cancelChatRun(actor, blocker.runId);
    await flushWaitUntilForTest();

    const picked = await head.launchedRun();
    await expect(
      runOfInput(actor, first.threadId, second.clientEventId),
    ).resolves.toBeUndefined();
    const resumed = await claimChatRun(runnerGroup, picked.runId);
    expect(resumed.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );

    // The second input waits for the head's run and then takes its slot.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(picked.runId, resumed.sandboxHeaders);
    await flushWaitUntilForTest();
    const next = await second.launchedRun();
    expect(next.runId).not.toBe(picked.runId);
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(nextClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${picked.runId}`,
    );
    await cancelChatRun(actor, next.runId);
  }, 90_000);

  it("gives the freed slot to the same thread before an older queued thread", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const running = await sendChatRun(actor, {
      agentId,
      prompt: "thread A holds the only slot",
    });
    const runningClaim = await claimChatRun(runnerGroup, running.runId);
    await waitForRunStatus(actor, running.runId, "running");

    const olderThread = await sendWaiting(
      actor,
      agentId,
      "thread B queued first",
    );
    const sameThread = await sendWaiting(
      actor,
      agentId,
      "thread A queued second",
      running.threadId,
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(running.runId, runningClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const takeover = await sameThread.launchedRun();
    await waitForRunStatus(actor, takeover.runId, "pending");
    await expect(
      runOfInput(actor, olderThread.threadId, olderThread.clientEventId),
    ).resolves.toBeUndefined();

    // Once the same thread's run ends with nothing left, the older thread
    // gets the slot.
    await cancelChatRun(actor, takeover.runId);
    await flushWaitUntilForTest();
    const older = await olderThread.launchedRun();
    await cancelChatRun(actor, older.runId);
  }, 90_000);

  // The Stripe capacity path (untilFull=true) is covered in
  // webhooks-callbacks.bdd.test.ts; here the cron sweep fills the raised
  // limit and leaves the remaining thread queued.
  it("launches queued threads up to a raised limit and no further", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const queued = [
      await sendWaiting(actor, agentId, "queued thread one"),
      await sendWaiting(actor, agentId, "queued thread two"),
      await sendWaiting(actor, agentId, "queued thread three"),
    ] as const;
    const threadIds = queued.map(({ threadId }) => {
      return threadId;
    });

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "3");
    await sweepQueuedThreads(threadIds);

    const launchedOne = await queued[0].launchedRun();
    const launchedTwo = await queued[1].launchedRun();
    await waitForRunStatus(actor, launchedOne.runId, "pending");
    await waitForRunStatus(actor, launchedTwo.runId, "pending");
    await expect(
      runOfInput(actor, queued[2].threadId, queued[2].clientEventId),
    ).resolves.toBeUndefined();
    // The over-limit thread stays queued with its lease released.
    await expect(
      readQueuedChatThreadFixture(queued[2].threadId),
    ).resolves.toStrictEqual({ leased: false });

    await cancelChatRun(actor, launchedOne.runId);
    await flushWaitUntilForTest();
    const launchedThree = await queued[2].launchedRun();
    await cancelChatRun(actor, launchedThree.runId);
    await cancelChatRun(actor, launchedTwo.runId);
    await cancelChatRun(actor, blocker.runId);
  }, 90_000);

  it("waits for an abandoned pick lease to expire before the sweep launches", async () => {
    const start = now();
    mockNow(start);
    onTestFinished(() => {
      clearMockNow();
    });
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const waiting = await sendWaiting(
      actor,
      agentId,
      "picked by a dead picker",
    );
    await claimQueuedChatThreadLeaseFixture(waiting.threadId);

    // The freed slot's pick skips the leased thread, and so does the sweep.
    await cancelChatRun(actor, blocker.runId);
    await flushWaitUntilForTest();
    await sweepQueuedThreads([waiting.threadId]);
    await expect(
      runOfInput(actor, waiting.threadId, waiting.clientEventId),
    ).resolves.toBeUndefined();

    mockNow(start + PICK_LEASE_TTL_MS - 1);
    await sweepQueuedThreads([waiting.threadId]);
    await expect(
      runOfInput(actor, waiting.threadId, waiting.clientEventId),
    ).resolves.toBeUndefined();

    mockNow(start + PICK_LEASE_TTL_MS + 1);
    await sweepQueuedThreads([waiting.threadId]);
    const launched = await waiting.launchedRun();
    await waitForRunStatus(actor, launched.runId, "pending");
    await expect(
      readQueuedChatThreadFixture(waiting.threadId),
    ).resolves.toBeNull();
    await cancelChatRun(actor, launched.runId);
  }, 90_000);

  it("releases the lease when the sweep finds the organization full", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const waiting = await sendWaiting(actor, agentId, "waits for capacity");

    await sweepQueuedThreads([waiting.threadId]);
    await expect(
      runOfInput(actor, waiting.threadId, waiting.clientEventId),
    ).resolves.toBeUndefined();
    await expect(
      readQueuedChatThreadFixture(waiting.threadId),
    ).resolves.toStrictEqual({ leased: false });

    // Capacity grows without a run ending; the next sweep launches at once
    // because the full-org pick released its lease.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
    await sweepQueuedThreads([waiting.threadId]);
    const launched = await waiting.launchedRun();
    await waitForRunStatus(actor, launched.runId, "pending");
    await cancelChatRun(actor, launched.runId);
    await cancelChatRun(actor, blocker.runId);
  }, 90_000);
});
