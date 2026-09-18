import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  barrierQueryBinds,
  barrierQueryText,
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdAgentRunRowLockFixture } from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const { api, chat, entitledChatActor, sendChatRun, claimChatRun } =
  createChatEventsFixture(context);

async function runningChatFixture() {
  const { actor, agentId, runnerGroup } = await entitledChatActor();
  const run = await sendChatRun(actor, {
    agentId,
    model: "claude-sonnet-5",
    prompt: "Cancel while a competing transaction owns the run",
  });
  await claimChatRun(runnerGroup, run.runId);
  await flushWaitUntilForTest();
  return { actor, ...run };
}

async function cancelBehindRunLock(
  fixture: Awaited<ReturnType<typeof runningChatFixture>>,
) {
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const releasePublication = () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
  };
  const original = context.mocks.ably.publish.getMockImplementation();
  let paused = false;
  context.mocks.ably.publish.mockImplementation(async (...args: unknown[]) => {
    const [topic, payload] = args;
    if (
      !paused &&
      topic === "cancel" &&
      typeof payload === "object" &&
      payload !== null &&
      "runId" in payload &&
      payload.runId === fixture.runId
    ) {
      paused = true;
      entered.resolve(undefined);
      await released.promise;
    }
    return await original?.(...args);
  });
  onTestFinished(releasePublication);

  await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
  await entered.promise;
  // Infrastructure exception: APIs cannot retain a PostgreSQL row lock at
  // this scheduling boundary. The real Runner publication pauses after the
  // cancellation commits, before its callback starts; only this run is held.
  const held = await holdAgentRunRowLockFixture({
    runId: fixture.runId,
    signal: context.signal,
  });
  const heldDone = settleIncludingAbort(held.done);
  onTestFinished(async () => {
    held.release();
    await heldDone;
  });
  releasePublication();
  return { ...held, heldDone };
}

async function cancellationEvents(
  fixture: Awaited<ReturnType<typeof runningChatFixture>>,
) {
  const page = await chat.listThreadEvents(fixture.actor, fixture.threadId);
  return page.events.filter((event) => {
    return event.runId === fixture.runId && event.eventType === "run.cancelled";
  });
}

describe("terminal chat callback lock recovery", () => {
  it.each([false, true])(
    "rechecks admission after a real lock timeout (erasure closes: %s)",
    async (closes) => {
      const fixture = await runningChatFixture();
      const erasureJobs: string[] = [];
      onTestFinished(async () => {
        await removeErasureSubjectsFixture(erasureJobs);
      });

      // Infrastructure exception: a public endpoint cannot pause delivery of
      // an actual ROLLBACK. All SQL executes unchanged, including the real
      // lock timeout; the barrier only lets this test release its competitor
      // before the next attempt, without sleeps or replacing a DB error.
      await withDatabaseTransactionBarrierFixture(
        {
          select: (queryArgs) => {
            const text = barrierQueryText(queryArgs);
            return (
              barrierQueryBinds(queryArgs, fixture.runId) &&
              text.includes('from "agent_runs"') &&
              text.includes('"status"') &&
              text.includes('"model_provider"') &&
              text.includes("for update")
            );
          },
          stopAt: (queryArgs) => {
            return barrierQueryText(queryArgs).trim() === "rollback";
          },
          pauseAfter: true,
          work: async (barrier) => {
            const held = await cancelBehindRunLock(fixture);
            const result = await settleIncludingAbort(async () => {
              await barrier.entered;
              await expect(cancellationEvents(fixture)).resolves.toStrictEqual(
                [],
              );
              if (closes) {
                // The dormant erasure projector has no production ingress.
                // Close only this test's user between real write attempts.
                const job = await closeErasureSubjectFixture({
                  subjectKind: "user",
                  subjectId: fixture.actor.userId,
                });
                erasureJobs.push(job.jobId);
              }
              held.release();
              await held.done;
              barrier.release();
              await flushWaitUntilForTest();
            });
            held.release();
            barrier.release();
            await held.heldDone;
            if (!result.ok) {
              throw result.error;
            }
          },
        },
        context.signal,
      );

      await expect(
        api.readRun(fixture.actor, fixture.runId),
      ).resolves.toMatchObject({
        status: "cancelled",
      });
      const terminal = await cancellationEvents(fixture);
      expect(terminal).toHaveLength(closes ? 0 : 1);

      await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
      await flushWaitUntilForTest();
      await expect(cancellationEvents(fixture)).resolves.toStrictEqual(
        terminal,
      );
    },
    30_000,
  );

  it("bounds retries and permits a later cancellation to recover the missing event", async () => {
    const fixture = await runningChatFixture();
    const held = await cancelBehindRunLock(fixture);
    const result = await settleIncludingAbort(async () => {
      // Await finite background completion while the competing lock remains
      // held. Every attempt encounters PostgreSQL's real lock deadline.
      await flushWaitUntilForTest();
      await expect(cancellationEvents(fixture)).resolves.toStrictEqual([]);
      await expect(
        api.readRun(fixture.actor, fixture.runId),
      ).resolves.toMatchObject({
        status: "cancelled",
      });
    });
    held.release();
    await held.heldDone;
    if (!result.ok) {
      throw result.error;
    }

    await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
    await flushWaitUntilForTest();
    const terminal = await cancellationEvents(fixture);
    expect(terminal).toHaveLength(1);

    await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
    await flushWaitUntilForTest();
    await expect(cancellationEvents(fixture)).resolves.toStrictEqual(terminal);
  }, 30_000);
});
