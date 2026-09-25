import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
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
  const { actor, agentId, runnerGroup, providerId } = await entitledChatActor();
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const first = await sendChatRun(actor, {
    agentId,
    model: "claude-fable-5-1",
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

describe("Runner claims racing cancellation", () => {
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
});
