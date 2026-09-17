import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { holdChatThreadEventInsertTransactionFixture } from "../../../test-fixtures/chat-thread-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createChatEventsFixture,
  requireOrgId,
  type EntitledChatActor,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  completeChatRunOk,
} = createChatEventsFixture(context);

async function holdConcurrentThreadEvent(fixture: EntitledChatActor) {
  const thread = await chat.createThread(fixture.actor, {
    agentId: fixture.agentId,
    title: "Concurrent thread event writer",
  });
  await flushWaitUntilForTest();

  // No production API can pause a transaction between sequence reservation
  // and commit. Hold a real writer for another thread owned by this same
  // user/org to reproduce the infrastructure-level shared-row contention.
  const held = await holdChatThreadEventInsertTransactionFixture({
    userId: fixture.actor.userId,
    orgId: requireOrgId(fixture.actor),
    chatThreadId: thread.id,
    agentId: fixture.agentId,
    title: "Held concurrent event",
    signal: context.signal,
  });
  onTestFinished(async () => {
    held.release();
    await held.done;
  });
  return held;
}

async function waitForBlockedTransaction(
  held: Awaited<ReturnType<typeof holdConcurrentThreadEvent>>,
  previousTransactionId?: string,
): Promise<string> {
  let transactionId: string | undefined;
  await expect
    .poll(
      async () => {
        transactionId = (await held.blockedSequenceWriterTransactionIds()).find(
          (id) => {
            return id !== previousTransactionId;
          },
        );
        return transactionId;
      },
      { interval: 25, timeout: 5000 },
    )
    .toBeDefined();
  if (transactionId === undefined) {
    throw new Error("Expected a blocked chat sequence writer transaction");
  }
  return transactionId;
}

describe("chat terminal callback lock recovery", () => {
  it.each(["cancelled", "completed"] as const)(
    "persists one run.%s event after a shared sequence row lock timeout",
    async (status) => {
      const fixture = await entitledChatActor();
      const { actor, agentId, runnerGroup } = fixture;
      const run = await sendChatRun(actor, {
        agentId,
        model: "claude-sonnet-5",
        prompt: "Recover the terminal event after a concurrent thread write",
      });
      const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
      const held = await holdConcurrentThreadEvent(fixture);

      async function deliverTerminalCallback(): Promise<void> {
        if (status === "cancelled") {
          await api.requestCancelRun(actor, run.runId, [200]);
        } else {
          await completeChatRunOk(run.runId, sandboxHeaders);
        }
      }

      await deliverTerminalCallback();
      const firstTransaction = await waitForBlockedTransaction(held);
      // A different transaction proves the first writer rolled back and a
      // retry reached the same held row. Releasing based only on a waiter
      // count would permit the first attempt to succeed without regression
      // coverage of the timeout.
      await waitForBlockedTransaction(held, firstTransaction);
      held.release();
      await held.done;
      await flushWaitUntilForTest();

      const events = await chat.listThreadEvents(actor, run.threadId);
      const terminalEvents = events.events.filter((event) => {
        return event.runId === run.runId && event.eventType === `run.${status}`;
      });
      expect(terminalEvents).toHaveLength(1);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status,
      });

      await deliverTerminalCallback();
      await flushWaitUntilForTest();
      const redelivered = await chat.listThreadEvents(actor, run.threadId);
      expect(
        redelivered.events.filter((event) => {
          return (
            event.runId === run.runId && event.eventType === `run.${status}`
          );
        }),
      ).toStrictEqual(terminalEvents);
    },
    30_000,
  );

  it("redrives a cancelled callback after its lock retry budget is exhausted", async () => {
    const fixture = await entitledChatActor();
    const { actor, agentId, runnerGroup } = fixture;
    const run = await sendChatRun(actor, {
      agentId,
      model: "claude-sonnet-5",
      prompt: "Recover cancellation after prolonged sequence row contention",
    });
    await claimChatRun(runnerGroup, run.runId);
    const held = await holdConcurrentThreadEvent(fixture);

    await api.requestCancelRun(actor, run.runId, [200]);
    await waitForBlockedTransaction(held);
    // Drain the owned callback while the row remains locked, so every bounded
    // attempt fails before the client asks to redrive the same cancellation.
    await flushWaitUntilForTest();
    const beforeRedrive = await chat.listThreadEvents(actor, run.threadId);
    expect(
      beforeRedrive.events.filter((event) => {
        return event.runId === run.runId && event.eventType === "run.cancelled";
      }),
    ).toHaveLength(0);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });

    held.release();
    await held.done;
    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    const redriven = await chat.listThreadEvents(actor, run.threadId);
    const cancellationEvents = redriven.events.filter((event) => {
      return event.runId === run.runId && event.eventType === "run.cancelled";
    });
    expect(cancellationEvents).toHaveLength(1);

    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    const duplicate = await chat.listThreadEvents(actor, run.threadId);
    expect(
      duplicate.events.filter((event) => {
        return event.runId === run.runId && event.eventType === "run.cancelled";
      }),
    ).toStrictEqual(cancellationEvents);
  }, 30_000);
});
