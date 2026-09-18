import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  barrierQueryBinds,
  barrierQueryText,
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdRunnerClaimSessionFixture } from "../../../test-fixtures/runner-claim-session-lock";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
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

async function inheritedChatRunFixture() {
  const { actor, agentId, runnerGroup } = await entitledChatActor();
  const first = await sendChatRun(actor, {
    agentId,
    model: "claude-sonnet-5",
    prompt: "Establish the conversation inherited by the next run",
  });
  const { sandboxHeaders } = await claimChatRun(runnerGroup, first.runId);
  const history = `Inherited Session history for ${first.runId}`;
  const historyHash = createHash("sha256").update(history).digest("hex");
  await completeChatRunOk(first.runId, sandboxHeaders, {
    sessionHistory: history,
  });
  await flushWaitUntilForTest();

  const second = await sendChatRun(actor, {
    agentId,
    threadId: first.threadId,
    prompt: "Cancel after the Runner has observed this pending run",
  });
  await flushWaitUntilForTest();
  return { actor, ...second, historyHash };
}

function gateClaimHistory(historyHash: string) {
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const release = () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
  };
  const original = context.mocks.s3.getSignedUrl.getMockImplementation();
  if (!original) {
    throw new Error("Expected the external Session history URL signer fixture");
  }
  let paused = false;
  context.mocks.s3.getSignedUrl.mockImplementation(
    async (...args: unknown[]) => {
      const [, request] = args;
      if (
        !paused &&
        request instanceof GetObjectCommand &&
        request.input.Key === `blobs/${historyHash}.blob`
      ) {
        paused = true;
        entered.resolve(undefined);
        await released.promise;
      }
      return await original(...args);
    },
  );
  onTestFinished(release);
  return { entered: entered.promise, release };
}

function staleClaim(runId: string) {
  let settled = false;
  const request = api.requestClaimRunnerJob(true, runId, [404]);
  const done = (async () => {
    const result = await settleIncludingAbort(request);
    settled = true;
    return result;
  })();
  return {
    request,
    done,
    settled: () => {
      return settled;
    },
  };
}

async function awaitClaimHistory(
  history: ReturnType<typeof gateClaimHistory>,
  claim: ReturnType<typeof staleClaim>,
) {
  await Promise.race([
    history.entered,
    (async () => {
      await claim.request;
      throw new Error(
        "Expected claim preparation to request inherited history",
      );
    })(),
  ]);
}

async function cancellationEvents(
  fixture: Awaited<ReturnType<typeof inheritedChatRunFixture>>,
) {
  const page = await chat.listThreadEvents(fixture.actor, fixture.threadId);
  return page.events.filter((event) => {
    return event.runId === fixture.runId && event.eventType === "run.cancelled";
  });
}

function gateRunnerCancellation(runId: string) {
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const release = () => {
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
      payload.runId === runId
    ) {
      paused = true;
      entered.resolve(undefined);
      await released.promise;
    }
    return await original?.(...args);
  });
  onTestFinished(release);
  return { entered: entered.promise, release };
}

describe("Runner claims racing cancellation", () => {
  it("retains an erasure-stopped job across repeated rejected claims", async () => {
    const fixture = await inheritedChatRunFixture();
    // Infrastructure exception: the dormant erasure projector has no public
    // ingress. Close only this test-owned user; claim and read behavior still
    // exercise production endpoints.
    const { jobId } = await closeErasureSubjectFixture({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([jobId]);
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        api.requestClaimRunnerJob(true, fixture.runId, [404]),
      ).resolves.toMatchObject({
        status: 404,
        body: { error: { message: "Run not found" } },
      });
    }
    await expect(
      api.readRun(fixture.actor, fixture.runId),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects a cancelled claim without waiting for its inherited Session", async () => {
    const fixture = await inheritedChatRunFixture();
    const history = gateClaimHistory(fixture.historyHash);
    const claim = staleClaim(fixture.runId);
    const state: {
      held?: Awaited<ReturnType<typeof holdRunnerClaimSessionFixture>>;
    } = {};
    onTestFinished(async () => {
      history.release();
      await state.held?.release();
      await claim.done;
    });

    const result = await settleIncludingAbort(
      (async () => {
        await awaitClaimHistory(history, claim);
        await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
        await flushWaitUntilForTest();
        const cancelledEvents = await cancellationEvents(fixture);
        expect(cancelledEvents).toHaveLength(1);

        // Infrastructure exception: the API cannot pause another transaction's
        // Session lock. Cancellation and its public event have already committed;
        // only the stale Runner claim can now contend with this owned fixture.
        state.held = await holdRunnerClaimSessionFixture({
          runId: fixture.runId,
          signal: context.signal,
        });
        history.release();
        const lock = state.held;
        let outcome: "pending" | "settled" | "blocked" = "pending";
        await expect
          .poll(async () => {
            outcome = claim.settled()
              ? "settled"
              : (await lock.claimIsBlocked())
                ? "blocked"
                : "pending";
            return outcome;
          })
          .not.toBe("pending");
        expect(
          outcome,
          "A cancelled claim must not wait for Session ownership",
        ).toBe("settled");
        await expect(claim.request).resolves.toMatchObject({
          status: 404,
          body: { error: { message: "Run not found" } },
        });
        await expect(
          api.readRun(fixture.actor, fixture.runId),
        ).resolves.toMatchObject({ status: "cancelled" });
        await expect(cancellationEvents(fixture)).resolves.toStrictEqual(
          cancelledEvents,
        );
      })(),
    );
    history.release();
    await state.held?.release();
    await claim.done;
    if (!result.ok) {
      throw result.error;
    }
  }, 30_000);

  it("persists cancellation while a stale claim's ownership query response is held", async () => {
    const fixture = await inheritedChatRunFixture();
    let captureClaim = false;

    // Infrastructure exception: no API can suspend an already-executed SQL
    // response. The query executes unchanged; retaining its transaction proves
    // that rejecting a stale claim does not retain the cancelled Run's lock.
    await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          const text = barrierQueryText(queryArgs);
          return (
            captureClaim &&
            barrierQueryBinds(queryArgs, fixture.runId) &&
            text.includes('from "agent_runs"') &&
            text.includes('"user_id"') &&
            text.includes('"org_id"') &&
            text.includes('"session_id"') &&
            text.includes("for update")
          );
        },
        stopAt: (_queryArgs, selectingStatement) => {
          return selectingStatement;
        },
        pauseAfter: true,
        work: async (barrier) => {
          const history = gateClaimHistory(fixture.historyHash);
          const claim = staleClaim(fixture.runId);
          const cancellation = gateRunnerCancellation(fixture.runId);
          onTestFinished(async () => {
            history.release();
            cancellation.release();
            barrier.release();
            await claim.done;
          });
          const result = await settleIncludingAbort(
            (async () => {
              await awaitClaimHistory(history, claim);
              // Another real Runner wins while the first is preparing its
              // response. Cancellation then commits before that stale claim
              // enters ownership admission.
              await api.claimRunnerJob(fixture.runId);
              await flushWaitUntilForTest();
              await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
              await cancellation.entered;
              captureClaim = true;
              history.release();
              await barrier.entered;
              cancellation.release();

              await flushWaitUntilForTest();
              const terminal = await cancellationEvents(fixture);
              expect(terminal).toHaveLength(1);
              await expect(
                api.readRun(fixture.actor, fixture.runId),
              ).resolves.toMatchObject({ status: "cancelled" });

              barrier.release();
              await expect(claim.request).resolves.toMatchObject({
                status: 404,
                body: { error: { message: "Run not found" } },
              });
              await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
              await flushWaitUntilForTest();
              await expect(cancellationEvents(fixture)).resolves.toStrictEqual(
                terminal,
              );
            })(),
          );
          history.release();
          cancellation.release();
          barrier.release();
          await claim.done;
          if (!result.ok) {
            throw result.error;
          }
        },
      },
      context.signal,
    );
  }, 30_000);
});
