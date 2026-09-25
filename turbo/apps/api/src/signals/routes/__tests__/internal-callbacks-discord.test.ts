import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import { testDiscordDeliveriesContract } from "@okouai/api-contracts/contracts/test-discord-deliveries";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testDiscordDeliveriesRoutes } from "../test-discord-deliveries";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { deleteDiscordFixture } from "./helpers/discord";
import {
  discordChatThreads,
  discordMessageForTest,
  mockDiscordProvider,
  postDiscordMessage,
  setupConnectedDiscordActor,
  type ConnectedDiscordActor,
} from "./helpers/discord-fixture";
import { createFixtureTracker } from "./helpers/route-test";

const context = testContext();
const runs = createRunsApi(context);
const misc = createMiscRoutesApi(context);
const webhooks = createWebhookCallbackApi(context);
const trackDiscordFixture = createFixtureTracker(
  async (fixture: { actor: ConnectedDiscordActor; deleted: boolean }) => {
    if (!fixture.deleted) {
      await deleteDiscordFixture(context, fixture.actor.fixture);
    }
  },
);

async function startDiscordRun() {
  const fixture = await trackDiscordFixture(
    setupConnectedDiscordActor(context).then((actor) => {
      return { actor, deleted: false };
    }),
  );
  const { actor } = fixture;
  runs.acceptTelemetryIngest();
  const provider = mockDiscordProvider(actor);
  const message = discordMessageForTest(actor, {
    channelId: provider.guildChannelId,
    content: `<@${actor.botUserId}> Finish the Discord task`,
  });
  provider.messages.set(message.id, message);
  await postDiscordMessage(context, message);
  await flushWaitUntilForTest();
  const [thread] = await discordChatThreads(context, actor);
  if (!thread) {
    throw new Error("Discord ingress did not create a canonical chat");
  }
  const events = await readProjectedChatEvents(context, {
    threadId: thread.id,
    headers: { authorization: "Bearer clerk-session" },
  });
  const input = events.find((event) => {
    return event.eventType === "input.prompt" && event.runId !== undefined;
  });
  if (!input?.runId) {
    throw new Error("Discord ingress did not launch a canonical run");
  }
  return {
    actor,
    fixture,
    provider,
    runId: input.runId,
    threadId: thread.id,
    channelId: message.id,
  };
}

async function claimRun(actor: ConnectedDiscordActor, runId: string) {
  await runs.heartbeatRunner(actor.runnerGroup);
  return runs.claimRunnerJob(runId);
}

async function completeRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly text?: string;
  readonly error?: string;
}) {
  const headers = { authorization: `Bearer ${args.sandboxToken}` };
  if (args.error !== undefined) {
    await webhooks.requestAgentComplete(
      { runId: args.runId, exitCode: 1, error: args.error },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    return;
  }
  if (args.text !== undefined) {
    await webhooks.requestAgentEvents(
      {
        runId: args.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: `discord-answer-${args.runId}`,
              content: [{ type: "text", text: args.text }],
            },
          },
          { type: "system", sequenceNumber: 1 },
        ],
      },
      headers,
      [200],
    );
  }
  const history = `Discord conversation history ${args.runId}`;
  const hash = createHash("sha256").update(history).digest("hex");
  const size = Buffer.byteLength(history);
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: args.runId,
      hash,
      rawSize: size,
      encodedSize: size,
      encoding: "identity",
    },
    headers,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `discord-session-${args.runId}`,
        cliAgentSessionHistoryHash: hash,
      },
      ...(args.text === undefined ? {} : { lastEventSequence: 1 }),
    },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
}

function recoverReplies(actor: ConnectedDiscordActor) {
  return accept(
    setupApp({ context, routes: testDiscordDeliveriesRoutes })(
      testDiscordDeliveriesContract,
    ).drain({ body: { connectionIds: [actor.connectionId] } }),
    [200],
  );
}

describe("canonical Discord terminal replies", () => {
  it("delivers canonical output after a long task to the native thread exactly once", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    mockNow(now() + 16 * 60_000);
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The Discord task is complete.",
    });
    expect(started.provider.sentMessages).toHaveLength(1);
    expect(started.provider.sentMessages[0]).toMatchObject({
      channel_id: started.channelId,
      content: expect.stringContaining("The Discord task is complete."),
    });
    expect(started.provider.sentMessages[0]?.content).toContain(
      "Claude Fable 5.1",
    );
    await recoverReplies(started.actor);
    expect(started.provider.sentMessages).toHaveLength(1);
    const events = await readProjectedChatEvents(context, {
      threadId: started.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "run.completed",
        runId: started.runId,
      }),
    );
  });

  it("delivers the canonical safe run error without exposing the internal failure", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      error: "Discord test execution failed",
    });
    expect(started.provider.sentMessages).toHaveLength(1);
    const events = await readProjectedChatEvents(context, {
      threadId: started.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    const failed = events.filter((event) => {
      return event.eventType === "run.failed" && event.runId === started.runId;
    });
    expect(failed).toHaveLength(1);
    const canonicalError = failed[0]?.content;
    if (!canonicalError) {
      throw new Error("Discord run failure must have canonical error text");
    }
    expect(started.provider.sentMessages[0]?.content).toContain(canonicalError);
    expect(canonicalError).not.toContain("Discord test execution failed");
    expect(started.provider.sentMessages[0]?.content).not.toContain(
      "Discord test execution failed",
    );
  });

  it("delivers cancellation before a runner claims the queued run", async () => {
    const started = await startDiscordRun();
    await runs.requestCancelRun(started.actor.actor, started.runId, [200]);
    await flushWaitUntilForTest();
    expect(started.provider.sentMessages).toHaveLength(1);
    expect(started.provider.sentMessages[0]?.content.toLowerCase()).toContain(
      "cancel",
    );
  });

  it("delivers a queued admission failure once without launching another run", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    const followup = discordMessageForTest(started.actor, {
      channelId: started.channelId,
      content: `<@${started.actor.botUserId}> Reject this queued follow-up.`,
    });
    started.provider.messages.set(followup.id, followup);
    await postDiscordMessage(context, followup);
    await flushWaitUntilForTest();
    const pending = await readProjectedChatEvents(context, {
      threadId: started.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    const revokedIds = revokedChatEventIds(pending);
    expect(
      pending.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.runId === undefined &&
          !revokedIds.has(event.id)
        );
      }),
    ).toHaveLength(1);
    await misc.deleteOrgModelProvider(
      started.actor.actor,
      "anthropic-api-key",
      [204],
    );
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The original task finished.",
    });
    const events = await readProjectedChatEvents(context, {
      threadId: started.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    const rejected = events.filter((event) => {
      return event.eventType === "input.rejected";
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.runId).toBeUndefined();
    expect(
      new Set(
        events.flatMap((event) => {
          return event.runId === undefined ? [] : [event.runId];
        }),
      ),
    ).toStrictEqual(new Set([started.runId]));
    const errors = events.filter((event) => {
      return event.eventType === "output.error" && event.runId === undefined;
    });
    expect(errors).toHaveLength(1);
    const errorText = errors[0]?.content;
    if (!errorText) {
      throw new Error(
        "Discord admission failure must have canonical error text",
      );
    }
    expect(
      started.provider.sentMessages.filter((message) => {
        return message.content.includes(errorText);
      }),
    ).toHaveLength(1);
    const messageCount = started.provider.sentMessages.length;
    await recoverReplies(started.actor);
    expect(started.provider.sentMessages).toHaveLength(messageCount);
  });

  it.each(["binding", "channel"] as const)(
    "suppresses a final reply after %s revocation without losing canonical completion",
    async (revocation) => {
      const started = await startDiscordRun();
      const claim = await claimRun(started.actor, started.runId);
      if (revocation === "binding") {
        await deleteDiscordFixture(context, started.actor.fixture);
        started.fixture.deleted = true;
      } else {
        started.provider.deniedChannels.add(started.channelId);
      }
      await completeRun({
        runId: started.runId,
        sandboxToken: claim.sandboxToken,
        text: "This output belongs to the original user.",
      });
      expect(started.provider.sentMessages).toHaveLength(0);
      const events = await readProjectedChatEvents(context, {
        threadId: started.threadId,
        headers: { authorization: "Bearer clerk-session" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          eventType: "run.completed",
          runId: started.runId,
        }),
      );
    },
  );

  it.each(["pending", "reserved"] as const)(
    "rejects a revoked %s active input without retrying or delivering it",
    async (phase) => {
      const started = await startDiscordRun();
      const claim = await claimRun(started.actor, started.runId);
      const followup = discordMessageForTest(started.actor, {
        channelId: started.channelId,
        content: `<@${started.actor.botUserId}> Use the confidential follow-up details.`,
      });
      started.provider.messages.set(followup.id, followup);
      await postDiscordMessage(context, followup);
      await flushWaitUntilForTest();
      if (phase === "reserved") {
        const reserved = await runs.reserveRunnerActiveInputs(
          claim.sandboxToken,
          started.runId,
        );
        expect(reserved).toMatchObject({
          outcome: "reserved",
          prompt: expect.stringContaining(
            "Use the confidential follow-up details.",
          ),
        });
      }
      await deleteDiscordFixture(context, started.actor.fixture);
      started.fixture.deleted = true;
      await expect(
        runs.reserveRunnerActiveInputs(claim.sandboxToken, started.runId),
      ).resolves.toStrictEqual({ outcome: "empty" });
      await expect(
        runs.reserveRunnerActiveInputs(claim.sandboxToken, started.runId),
      ).resolves.toStrictEqual({ outcome: "empty" });
      const events = await readProjectedChatEvents(context, {
        threadId: started.threadId,
        headers: { authorization: "Bearer clerk-session" },
      });
      expect(
        events.filter((event) => {
          return event.eventType === "input.rejected";
        }),
      ).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          eventType: "output.error",
          content: "This Discord conversation is no longer available.",
        }),
      );
      await completeRun({
        runId: started.runId,
        sandboxToken: claim.sandboxToken,
        text: "The original task is complete.",
      });
      expect(started.provider.sentMessages).toHaveLength(0);
    },
  );

  it("drops previously read history when current history permission is revoked", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const followup = discordMessageForTest(started.actor, {
      channelId: started.channelId,
      content: `<@${started.actor.botUserId}> Continue with the current message.`,
    });
    const history = discordMessageForTest(started.actor, {
      id: (BigInt(followup.id) - 1n).toString(),
      channelId: started.channelId,
      content: "History that is no longer readable.",
    });
    started.provider.messages.set(history.id, history);
    started.provider.messages.set(followup.id, followup);
    await postDiscordMessage(context, followup);
    await flushWaitUntilForTest();
    const initial = await runs.reserveRunnerActiveInputs(
      claim.sandboxToken,
      started.runId,
    );
    expect(initial).toMatchObject({
      outcome: "reserved",
      prompt: expect.stringContaining(history.content),
    });
    started.provider.state.everyonePermissions = (
      (1n << 10n) |
      (1n << 11n) |
      (1n << 38n)
    ).toString();
    const narrowed = await runs.reserveRunnerActiveInputs(
      claim.sandboxToken,
      started.runId,
    );
    expect(narrowed).toMatchObject({
      outcome: "reserved",
      prompt: expect.stringContaining("Continue with the current message."),
    });
    if (narrowed.outcome !== "reserved") {
      throw new Error("Current Discord input should remain deliverable");
    }
    expect(narrowed.prompt).not.toContain(history.content);
    expect(narrowed.prompt).toContain("current Discord permissions");
    await runs.recordRunnerActiveInputDelivery(
      claim.sandboxToken,
      started.runId,
      narrowed.deliveryId,
    );
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The current task is complete.",
    });
  });

  it("honors Discord Retry-After beyond the worker lease without uncertain-send receipts", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let attempts = 0;
    started.provider.state.beforeMessageCreate = () => {
      attempts += 1;
      return HttpResponse.json(
        { message: "Rate limited", retry_after: 300, global: false },
        { status: 429 },
      );
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "Reply after Discord's cooldown.",
    });
    expect(attempts).toBe(1);
    expect(started.provider.sentMessages).toHaveLength(0);
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(attempts).toBe(1);
    expect(started.provider.sentMessages).toHaveLength(0);
    started.provider.state.beforeMessageCreate = () => {
      attempts += 1;
      return undefined;
    };
    mockNow(now() + 180_000);
    await recoverReplies(started.actor);
    expect(attempts).toBe(2);
    expect(started.provider.sentMessages).toHaveLength(1);
    expect(started.provider.sentMessages[0]?.content).toContain(
      "Reply after Discord's cooldown.",
    );
  });

  it("replays a lost Discord send with its enforced nonce and sends each chunk once", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    const answer = "A complete Discord answer. ".repeat(180);
    let sendRequests = 0;
    let historyReads = 0;
    let responseLost = false;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return undefined;
    };
    started.provider.state.historyResponse = () => {
      historyReads += 1;
      return undefined;
    };
    started.provider.state.afterMessageCreated = () => {
      if (responseLost) {
        return undefined;
      }
      responseLost = true;
      return HttpResponse.error();
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: answer,
    });
    const delivered = started.provider.sentMessages;
    expect(delivered.length).toBeGreaterThan(1);
    // The lost first send was replayed once and returned the original message.
    expect(sendRequests).toBe(delivered.length + 1);
    expect(historyReads).toBe(0);
    expect(
      new Set(
        delivered.map((message) => {
          return message.nonce;
        }),
      ).size,
    ).toBe(delivered.length);
    expect(
      delivered
        .map((message) => {
          return message.content;
        })
        .join(""),
    ).toContain(answer);
    mockNow(now() + 121_000);
    await Promise.all([
      recoverReplies(started.actor),
      recoverReplies(started.actor),
    ]);
    expect(started.provider.sentMessages).toHaveLength(delivered.length);
    expect(sendRequests).toBe(delivered.length + 1);
  });

  it("keeps a lost send uncertain outside the nonce window instead of sending it again", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return undefined;
    };
    started.provider.state.afterMessageCreated = () => {
      return HttpResponse.json({ message: "Bad gateway" }, { status: 502 });
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply whose receipts keep getting lost.",
    });
    // One send plus two bounded enforced-nonce replays inside the claim.
    expect(sendRequests).toBe(3);
    expect(started.provider.sentMessages).toHaveLength(1);
    started.provider.state.afterMessageCreated = undefined;
    // Discord still deduplicates this nonce, but the next claim starts after
    // Okou's conservative replay window and must not risk a second message.
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(sendRequests).toBe(3);
    expect(started.provider.sentMessages).toHaveLength(1);
  });

  it("treats a rate-limited replay beyond the nonce window as uncertain", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return sendRequests === 2
        ? HttpResponse.json(
            { message: "Rate limited", retry_after: 300, global: false },
            { status: 429 },
          )
        : undefined;
    };
    started.provider.state.afterMessageCreated = () => {
      return HttpResponse.error();
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply whose replay is rate limited.",
    });
    expect(sendRequests).toBe(2);
    expect(started.provider.sentMessages).toHaveLength(1);
    started.provider.state.afterMessageCreated = undefined;
    mockNow(now() + 400_000);
    await recoverReplies(started.actor);
    expect(sendRequests).toBe(2);
    expect(started.provider.sentMessages).toHaveLength(1);
  });

  it("waits out a short replay rate limit and returns the original message", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    let responseLost = false;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return sendRequests === 2
        ? HttpResponse.json(
            { message: "Rate limited", retry_after: 0.01, global: false },
            { status: 429 },
          )
        : undefined;
    };
    started.provider.state.afterMessageCreated = () => {
      if (responseLost) {
        return undefined;
      }
      responseLost = true;
      return HttpResponse.error();
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply replayed after a short cooldown.",
    });
    expect(sendRequests).toBe(3);
    expect(started.provider.sentMessages).toHaveLength(1);
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(sendRequests).toBe(3);
  });

  it("rechecks access before replaying a lost send and suppresses it after revocation", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return undefined;
    };
    started.provider.state.afterMessageCreated = (message) => {
      // Access is revoked while the first send's receipt is lost.
      started.provider.deniedChannels.add(message.channel_id);
      return HttpResponse.error();
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply whose destination is revoked mid-send.",
    });
    expect(sendRequests).toBe(1);
    started.provider.deniedChannels.clear();
    started.provider.state.afterMessageCreated = undefined;
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(sendRequests).toBe(1);
    expect(started.provider.sentMessages).toHaveLength(1);
  });

  it("never re-sends an unconfirmed part from a later claim", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return undefined;
    };
    started.provider.state.afterMessageCreated = () => {
      // The replay's access check then fails transiently, ending this claim
      // with the part still unconfirmed and the delivery retryable.
      started.provider.state.channelResponse = () => {
        return HttpResponse.json({ message: "Unavailable" }, { status: 500 });
      };
      return HttpResponse.error();
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply whose replay could not be authorized.",
    });
    expect(sendRequests).toBe(1);
    started.provider.state.afterMessageCreated = undefined;
    let accessChecks = 0;
    started.provider.state.channelResponse = () => {
      accessChecks += 1;
      return undefined;
    };
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    // The later claim runs, but it is outside the replay window and must not
    // send the part again, even though Discord would still deduplicate it.
    expect(accessChecks).toBeGreaterThan(0);
    expect(sendRequests).toBe(1);
    expect(started.provider.sentMessages).toHaveLength(1);
    mockNow(now() + 121_000);
    const checksAfterTerminal = accessChecks;
    await recoverReplies(started.actor);
    expect(accessChecks).toBe(checksAfterTerminal);
    expect(sendRequests).toBe(1);
  });
});
