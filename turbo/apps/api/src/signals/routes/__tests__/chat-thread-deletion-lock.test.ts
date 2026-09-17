import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { holdChatThreadCascadeDeleteFixture } from "../../../test-fixtures/chat-thread-deletion-lock";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  completeChatRunOk,
} = createChatEventsFixture(context);

describe("chat thread deletion lock isolation", () => {
  it.each(["cancelled", "completed"] as const)(
    "persists run.%s in another thread while a cascade deletion is blocked",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const removedRun = await sendChatRun(actor, {
        agentId,
        model: "claude-sonnet-5",
        prompt: "Populate the thread that will be deleted",
      });
      await api.requestCancelRun(actor, removedRun.runId, [200]);
      await flushWaitUntilForTest();
      const removedEvents = await chat.listThreadEvents(
        actor,
        removedRun.threadId,
      );
      const heldEvent = removedEvents.events.find((event) => {
        return (
          event.runId === removedRun.runId &&
          event.eventType === "run.cancelled"
        );
      });
      if (!heldEvent) {
        throw new Error("Expected a persisted event in the deleted thread");
      }

      const run = await sendChatRun(actor, {
        agentId,
        model: "claude-sonnet-5",
        prompt: "Finish independently of another thread's deletion",
      });
      const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
      await flushWaitUntilForTest();

      const held = await holdChatThreadCascadeDeleteFixture(
        {
          threadId: removedRun.threadId,
          eventId: heldEvent.id,
        },
        context.signal,
      );
      const heldDone = settleIncludingAbort(held.done);
      const deletion = settleIncludingAbort(
        chat.deleteThread(actor, removedRun.threadId),
      );
      onTestFinished(async () => {
        held.release();
        await Promise.all([heldDone, deletion]);
      });
      await expect.poll(held.deletionIsBlocked).toBeTruthy();

      async function deliverTerminalCallback(): Promise<void> {
        if (status === "cancelled") {
          await api.requestCancelRun(actor, run.runId, [200]);
        } else {
          await completeChatRunOk(run.runId, sandboxHeaders);
        }
      }

      await deliverTerminalCallback();
      // Keep the child-row lock held until the terminal callback finishes.
      // Retrying the shared sequence lock cannot satisfy this contract.
      await flushWaitUntilForTest();
      const events = await chat.listThreadEvents(actor, run.threadId);
      const terminalEvents = events.events.filter((event) => {
        return event.runId === run.runId && event.eventType === `run.${status}`;
      });
      expect(terminalEvents).toHaveLength(1);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status,
      });
      await expect(held.deletionIsBlocked()).resolves.toBeTruthy();

      await deliverTerminalCallback();
      await flushWaitUntilForTest();
      const duplicate = await chat.listThreadEvents(actor, run.threadId);
      expect(
        duplicate.events.filter((event) => {
          return (
            event.runId === run.runId && event.eventType === `run.${status}`
          );
        }),
      ).toStrictEqual(terminalEvents);

      const beforeCommit = await chat.requestThreadEvents(actor, {}, [200]);
      if (beforeCommit.status !== 200) {
        throw new Error("Expected the thread event feed before deletion");
      }
      expect(beforeCommit.body.events).not.toContainEqual(
        expect.objectContaining({
          kind: "deleted",
          chatThreadId: removedRun.threadId,
        }),
      );
      const cursor = beforeCommit.body.events.at(-1)?.seqId;
      if (cursor === undefined) {
        throw new Error("Expected a committed thread event cursor");
      }

      held.release();
      await held.done;
      expect((await deletion).ok).toBeTruthy();
      await chat.requestReadThread(actor, removedRun.threadId, [404]);
      const afterCommit = await chat.requestThreadEvents(
        actor,
        { sinceSeqId: cursor },
        [200],
      );
      if (afterCommit.status !== 200) {
        throw new Error("Expected the thread event feed after deletion");
      }
      expect(afterCommit.body.events).toStrictEqual([
        expect.objectContaining({
          kind: "deleted",
          chatThreadId: removedRun.threadId,
        }),
      ]);
    },
    30_000,
  );
});
