import { randomUUID } from "node:crypto";
import {
  STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
  STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

/**
 * Steering without delivery IDs: a running sandbox run reads the next
 * steerable input prompt, then declares it steered, which consumes it with a
 * replacement event carrying the run ID.
 */
const context = testContext();
const {
  bdd,
  api,
  chat,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
} = createChatEventsFixture(context);

async function sendQueuedPrompt(
  actor: Parameters<typeof chat.requestSendEvent>[0],
  agentId: string,
  threadId: string,
  prompt: string,
): Promise<string> {
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId,
      threadId,
      prompt,
      clientEventId,
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the prompt to be accepted");
  }
  expect(sent.body.runId).toBeNull();
  return clientEventId;
}

describe("CHAT-02: steering input prompts into a running run", () => {
  it("returns the next prompt after the run's own input and declares it steered once", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run that steers queued prompts",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const token = claimed.claim.sandboxToken;

    // The run's own bound input is never steerable.
    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual({ input: null });

    const firstEventId = await sendQueuedPrompt(
      actor,
      agentId,
      active.threadId,
      "first steered prompt",
    );
    const secondEventId = await sendQueuedPrompt(
      actor,
      agentId,
      active.threadId,
      "second steered prompt",
    );
    const next = await api.nextSteerableInput(token, active.runId);
    expect(next).toStrictEqual({
      input: { eventId: firstEventId, prompt: "first steered prompt" },
    });
    // Reading writes nothing, so a repeated read returns the same prompt.
    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual(next);

    context.mocks.ably.publish.mockClear();
    const declarations = await Promise.all([
      api.requestDeclareSteeredInputAs(
        `Bearer ${token}`,
        active.runId,
        firstEventId,
        [200],
      ),
      api.requestDeclareSteeredInputAs(
        `Bearer ${token}`,
        active.runId,
        firstEventId,
        [200],
      ),
    ]);
    expect(
      declarations.map(({ body }) => {
        return body;
      }),
    ).toStrictEqual([{ outcome: "steered" }, { outcome: "steered" }]);
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);

    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: secondEventId, prompt: "second steered prompt" },
    });
    await api.requestDeclareSteeredInputAs(
      `Bearer ${token}`,
      active.runId,
      secondEventId,
      [200],
    );
    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual({ input: null });
    const repeated = await api.requestDeclareSteeredInputAs(
      `Bearer ${token}`,
      active.runId,
      firstEventId,
      [200],
    );
    expect(repeated.body).toStrictEqual({ outcome: "steered" });

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

  it("skips recalled prompts and rejects unknown input", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run that skips unsteerable input",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const token = claimed.claim.sandboxToken;

    const unknown = await api.requestDeclareSteeredInputAs(
      `Bearer ${token}`,
      active.runId,
      randomUUID(),
      [404],
    );
    expectApiError(unknown.body);

    const recalledEventId = await sendQueuedPrompt(
      actor,
      agentId,
      active.threadId,
      "recalled before steering",
    );
    const keptEventId = await sendQueuedPrompt(
      actor,
      agentId,
      active.threadId,
      "kept for steering",
    );
    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: recalledEventId, prompt: "recalled before steering" },
    });
    // The user recalls the prompt between the read and the declaration.
    await chat.requestSendEvent(
      actor,
      { agentId, threadId: active.threadId, revokesEventId: recalledEventId },
      [201],
    );
    const recalled = await api.requestDeclareSteeredInputAs(
      `Bearer ${token}`,
      active.runId,
      recalledEventId,
      [409],
    );
    expect(recalled.body.error.code).toBe(
      STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
    );
    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: keptEventId, prompt: "kept for steering" },
    });

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events
        .filter((event) => {
          return event.revokesEventId === recalledEventId;
        })
        .map((event) => {
          return event.eventType;
        }),
    ).toStrictEqual(["control.revoke"]);
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("rejects a declaration once the run ended and another run took the prompt", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "run that ends before steering",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const queuedEventId = await sendQueuedPrompt(
      actor,
      agentId,
      first.threadId,
      "picked by the next run",
    );
    await expect(
      api.nextSteerableInput(firstClaim.claim.sandboxToken, first.runId),
    ).resolves.toStrictEqual({
      input: { eventId: queuedEventId, prompt: "picked by the next run" },
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, first.runId, "completed");
    const picked = await waitForThreadMessages(
      actor,
      first.threadId,
      (events) => {
        return events.some((event) => {
          return (
            event.revokesEventId === queuedEventId &&
            typeof event.runId === "string"
          );
        });
      },
    );
    const secondRunId = picked.events.find((event) => {
      return event.revokesEventId === queuedEventId;
    })?.runId;
    if (typeof secondRunId !== "string" || secondRunId === first.runId) {
      throw new Error("Expected the next run to take the queued prompt");
    }

    await expect(
      api.nextSteerableInput(firstClaim.claim.sandboxToken, first.runId),
    ).resolves.toStrictEqual({ input: null });
    const late = await api.requestDeclareSteeredInputAs(
      `Bearer ${firstClaim.claim.sandboxToken}`,
      first.runId,
      queuedEventId,
      [409],
    );
    expect(late.body.error.code).toBe(STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE);

    const events = await chat.listThreadEvents(actor, first.threadId);
    expect(
      events.events
        .filter((event) => {
          return event.revokesEventId === queuedEventId;
        })
        .map((event) => {
          return event.runId;
        }),
    ).toStrictEqual([secondRunId]);
    await cancelChatRun(actor, secondRunId);
  }, 90_000);

  it("accepts only the run's own sandbox token", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const other = await sendChatRun(actor, {
      agentId,
      prompt: "another run of the same user",
    });
    await cancelChatRun(actor, other.runId);
    const otherToken = api.sandboxTokenForRun(actor, other.runId);
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run whose steering is protected",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const eventId = await sendQueuedPrompt(
      actor,
      agentId,
      active.threadId,
      "only the owning run may steer",
    );

    const missingAuth = await api.requestNextSteerableInputAs(
      undefined,
      active.runId,
      [401],
    );
    expectApiError(missingAuth.body);
    const cli = await api.createCliToken(actor);
    const cliToken = await api.requestNextSteerableInputAs(
      `Bearer ${cli.token}`,
      active.runId,
      [403],
    );
    expectApiError(cliToken.body);
    const peerToken = api.sandboxTokenForRun(bdd.user(), active.runId);
    const peer = await api.requestNextSteerableInputAs(
      `Bearer ${peerToken}`,
      active.runId,
      [403],
    );
    expectApiError(peer.body);
    const otherRunRead = await api.requestNextSteerableInputAs(
      `Bearer ${otherToken}`,
      active.runId,
      [403],
    );
    expectApiError(otherRunRead.body);
    const otherRunDeclare = await api.requestDeclareSteeredInputAs(
      `Bearer ${otherToken}`,
      active.runId,
      eventId,
      [403],
    );
    expectApiError(otherRunDeclare.body);
    // Through the other run's own path the input is outside its thread.
    const otherThread = await api.requestDeclareSteeredInputAs(
      `Bearer ${otherToken}`,
      other.runId,
      eventId,
      [404],
    );
    expectApiError(otherThread.body);

    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId, prompt: "only the owning run may steer" },
    });
    await cancelChatRun(actor, active.runId);
  }, 90_000);
});
