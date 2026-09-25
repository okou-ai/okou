import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testDiscordDeliveriesContract } from "@okouai/api-contracts/contracts/test-discord-deliveries";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { testDiscordDeliveriesRoutes } from "../test-discord-deliveries";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
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
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const runs = createRunsApi(context);
const misc = createMiscRoutesApi(context);
const webhooks = createWebhookCallbackApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const trackDiscordFixture = createFixtureTracker(
  async (fixture: { actor: ConnectedDiscordActor; deleted: boolean }) => {
    if (!fixture.deleted) {
      await deleteDiscordFixture(context, fixture.actor.fixture);
    }
  },
);

async function startDiscordRun(
  options: {
    readonly configureProvider?: (
      provider: ReturnType<typeof mockDiscordProvider>,
    ) => void;
    readonly beforeMessage?: (actor: ConnectedDiscordActor) => Promise<void>;
  } = {},
) {
  const fixture = await trackDiscordFixture(
    setupConnectedDiscordActor(context).then((actor) => {
      return { actor, deleted: false };
    }),
  );
  const { actor } = fixture;
  runs.acceptTelemetryIngest();
  const provider = mockDiscordProvider(actor);
  options.configureProvider?.(provider);
  await options.beforeMessage?.(actor);
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

async function selectSupportAgent(actor: ConnectedDiscordActor) {
  const agent = await authOrg.createAgent(actor.actor, {
    displayName: "Discord support agent",
  });
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).setAgentPreference({
      headers: { authorization: "Bearer clerk-session" },
      body: { agentId: agent.agentId },
    }),
    [200],
  );
}

function sentContents(started: Awaited<ReturnType<typeof startDiscordRun>>) {
  return started.provider.sentMessages.map((message) => {
    return message.content;
  });
}

function uncertainPartNotice(
  started: Awaited<ReturnType<typeof startDiscordRun>>,
) {
  return `_I couldn't confirm that part of this reply reached Discord, so I didn't send it again to avoid a duplicate. Read the full reply in Okou: http://localhost:3002/chats/${started.threadId}_`;
}

function recoverReplies(actor: ConnectedDiscordActor) {
  return accept(
    setupApp({ context, routes: testDiscordDeliveriesRoutes })(
      testDiscordDeliveriesContract,
    ).drain({ body: { connectionIds: [actor.connectionId] } }),
    [200],
  );
}

// A non-moderator member: can view, send, read history and send in threads,
// but lacks MANAGE_THREADS, so a moderator lock closes the thread.
const MEMBER_PERMISSIONS = (
  (1n << 10n) |
  (1n << 11n) |
  (1n << 16n) |
  (1n << 38n)
).toString();

function setThreadState(
  started: Awaited<ReturnType<typeof startDiscordRun>>,
  state: { readonly archived: boolean; readonly locked: boolean },
) {
  const thread = started.provider.channels.get(started.channelId);
  if (!thread?.thread_metadata) {
    throw new Error("Discord ingress did not create a native thread");
  }
  thread.thread_metadata = { ...thread.thread_metadata, ...state };
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

  it.each([
    { agent: "the org default agent", footer: "" },
    {
      agent: "a selected agent",
      footer: "\n\n_Sent via Discord support agent_",
    },
  ])(
    "delivers a queued admission failure once for $agent without launching another run",
    async ({ agent, footer }) => {
      const started = await startDiscordRun({
        beforeMessage:
          agent === "a selected agent" ? selectSupportAgent : undefined,
      });
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
      const notices = started.provider.sentMessages.filter((message) => {
        return message.content.includes(errorText);
      });
      expect(notices).toHaveLength(1);
      // An admission failure has no run, so only the agent is named.
      expect(notices[0]?.content).toBe(`${errorText}${footer}`);
      const messageCount = started.provider.sentMessages.length;
      await recoverReplies(started.actor);
      expect(started.provider.sentMessages).toHaveLength(messageCount);
    },
  );

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

  it("delivers the final reply after the thread auto-archives during the run", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    setThreadState(started, { archived: true, locked: false });
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The archived-thread task is complete.",
    });
    expect(started.provider.sentMessages).toHaveLength(1);
    expect(started.provider.sentMessages[0]).toMatchObject({
      channel_id: started.channelId,
      content: expect.stringContaining("The archived-thread task is complete."),
    });
    await recoverReplies(started.actor);
    expect(started.provider.sentMessages).toHaveLength(1);
  });

  it.each([
    { sender: "member", delivered: 0 },
    { sender: "moderator", delivered: 1 },
  ] as const)(
    "delivers into a thread locked during the run only for a MANAGE_THREADS $sender",
    async ({ sender, delivered }) => {
      const started = await startDiscordRun();
      const claim = await claimRun(started.actor, started.runId);
      // The sender's only authority comes from @everyone; the bot keeps its
      // administrator role, which alone must not reopen the lock.
      started.provider.state.everyonePermissions =
        sender === "member"
          ? MEMBER_PERMISSIONS
          : (BigInt(MEMBER_PERMISSIONS) | (1n << 34n)).toString();
      setThreadState(started, { archived: true, locked: true });
      await completeRun({
        runId: started.runId,
        sandboxToken: claim.sandboxToken,
        text: "The locked-thread task is complete.",
      });
      await recoverReplies(started.actor);
      expect(started.provider.sentMessages).toHaveLength(delivered);
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

  it("launches a queued follow-up after the thread auto-archives", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    started.provider.state.everyonePermissions = MEMBER_PERMISSIONS;
    const followup = discordMessageForTest(started.actor, {
      channelId: started.channelId,
      content: `<@${started.actor.botUserId}> Continue after the archive.`,
    });
    started.provider.messages.set(followup.id, followup);
    await postDiscordMessage(context, followup);
    await flushWaitUntilForTest();
    setThreadState(started, { archived: true, locked: false });
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The first task is complete.",
    });
    expect(started.provider.sentMessages).toHaveLength(1);
    const events = await readProjectedChatEvents(context, {
      threadId: started.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(
      events.filter((event) => {
        return event.eventType === "input.rejected";
      }),
    ).toHaveLength(0);
    const launchedRunIds = events.flatMap((event) => {
      return event.eventType === "input.prompt" && event.runId
        ? [event.runId]
        : [];
    });
    expect(launchedRunIds).toHaveLength(2);
    expect(launchedRunIds[0]).toBe(started.runId);
    expect(launchedRunIds[1]).not.toBe(started.runId);
  });

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
    let lostNonce: string | undefined;
    started.provider.state.afterMessageCreated = (message) => {
      lostNonce ??= message.nonce;
      return message.nonce === lostNonce
        ? HttpResponse.json({ message: "Bad gateway" }, { status: 502 })
        : undefined;
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply whose receipts keep getting lost.",
    });
    // One send plus two bounded enforced-nonce replays inside the claim, then
    // one notice that the reply could not be confirmed.
    expect(sendRequests).toBe(4);
    expect(sentContents(started)).toStrictEqual([
      expect.stringContaining("A reply whose receipts keep getting lost."),
      uncertainPartNotice(started),
    ]);
    started.provider.state.afterMessageCreated = undefined;
    // Discord still deduplicates this nonce, but the next claim starts after
    // Okou's conservative replay window and must not risk a second message.
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(sendRequests).toBe(4);
    expect(started.provider.sentMessages).toHaveLength(2);
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
    let lostNonce: string | undefined;
    started.provider.state.afterMessageCreated = (message) => {
      lostNonce ??= message.nonce;
      return message.nonce === lostNonce ? HttpResponse.error() : undefined;
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "A reply whose replay is rate limited.",
    });
    expect(sendRequests).toBe(3);
    expect(sentContents(started)).toStrictEqual([
      expect.stringContaining("A reply whose replay is rate limited."),
      uncertainPartNotice(started),
    ]);
    started.provider.state.afterMessageCreated = undefined;
    mockNow(now() + 400_000);
    await recoverReplies(started.actor);
    expect(sendRequests).toBe(3);
    expect(started.provider.sentMessages).toHaveLength(2);
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
    // It tells the user instead.
    expect(accessChecks).toBeGreaterThan(0);
    expect(sendRequests).toBe(2);
    expect(sentContents(started)).toStrictEqual([
      expect.stringContaining("A reply whose replay could not be authorized."),
      uncertainPartNotice(started),
    ]);
    mockNow(now() + 121_000);
    const checksAfterTerminal = accessChecks;
    await recoverReplies(started.actor);
    expect(accessChecks).toBe(checksAfterTerminal);
    expect(sendRequests).toBe(2);
  });

  it("sends the remaining parts and a notice after one part cannot be confirmed", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    const answer = "A long Discord answer that needs several parts. ".repeat(
      120,
    );
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return undefined;
    };
    // Discord accepts the first part, but every receipt for it is lost.
    let lostNonce: string | undefined;
    started.provider.state.afterMessageCreated = (message) => {
      lostNonce ??= message.nonce;
      return message.nonce === lostNonce
        ? HttpResponse.json({ message: "Bad gateway" }, { status: 502 })
        : undefined;
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: answer,
    });
    const contents = sentContents(started);
    expect(contents.length).toBeGreaterThan(3);
    // Each reply part reaches Discord once, in order, and a notice follows.
    expect(contents.at(-1)).toBe(uncertainPartNotice(started));
    expect(contents.slice(0, -1).join("")).toContain(answer.trim());
    expect(
      new Set(
        started.provider.sentMessages.map((message) => {
          return message.nonce;
        }),
      ).size,
    ).toBe(contents.length);
    // The unconfirmed first part was replayed twice and never sent again.
    expect(sendRequests).toBe(contents.length + 2);
    started.provider.state.afterMessageCreated = undefined;
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(sentContents(started)).toStrictEqual(contents);
  });

  it("sends one notice when several parts cannot be confirmed", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      return undefined;
    };
    // Discord accepts the first two parts, but every receipt for them is lost.
    const lostNonces = new Set<string>();
    started.provider.state.afterMessageCreated = (message) => {
      if (message.nonce !== undefined && lostNonces.size < 2) {
        lostNonces.add(message.nonce);
      }
      return message.nonce !== undefined && lostNonces.has(message.nonce)
        ? HttpResponse.json({ message: "Bad gateway" }, { status: 502 })
        : undefined;
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "Several parts of this answer lose their receipts. ".repeat(120),
    });
    const contents = sentContents(started);
    expect(
      contents.filter((content) => {
        return content === uncertainPartNotice(started);
      }),
    ).toHaveLength(1);
    expect(contents.at(-1)).toBe(uncertainPartNotice(started));
    // Each lost part: one send plus two replays; every other part: one send.
    expect(sendRequests).toBe(contents.length + 4);
  });

  it("keeps one notice when a recovery claim finishes an interrupted reply", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let sendRequests = 0;
    started.provider.state.beforeMessageCreate = () => {
      sendRequests += 1;
      // The second part's first send is rate-limited, ending this claim after
      // the first part became unconfirmed and its notice was recorded.
      return sendRequests === 4
        ? HttpResponse.json(
            { message: "Rate limited", retry_after: 1, global: false },
            { status: 429 },
          )
        : undefined;
    };
    let lostNonce: string | undefined;
    started.provider.state.afterMessageCreated = (message) => {
      lostNonce ??= message.nonce;
      return message.nonce === lostNonce
        ? HttpResponse.json({ message: "Bad gateway" }, { status: 502 })
        : undefined;
    };
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "An interrupted answer that a later claim completes. ".repeat(120),
    });
    expect(started.provider.sentMessages).toHaveLength(1);
    expect(sendRequests).toBe(4);
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    const contents = sentContents(started);
    expect(
      contents.filter((content) => {
        return content === uncertainPartNotice(started);
      }),
    ).toHaveLength(1);
    expect(contents.at(-1)).toBe(uncertainPartNotice(started));
    // The recovery claim sends each remaining part and the notice once and
    // never repeats the unconfirmed first part.
    expect(sendRequests).toBe(4 + contents.length - 1);
    mockNow(now() + 121_000);
    await recoverReplies(started.actor);
    expect(sentContents(started)).toStrictEqual(contents);
  });
});

describe("Discord processing status", () => {
  const TYPING_REFRESH_GAP_MS = 9000;
  const TYPING_ACCESS_REUSE_MS = 45_000;

  async function heartbeat(runId: string, sandboxToken: string) {
    const response = await webhooks.requestAgentHeartbeat(
      { runId },
      { authorization: `Bearer ${sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    return response.body;
  }

  it("shows typing on admission and refreshes it from Runner heartbeats until the reply", async () => {
    const started = await startDiscordRun();
    expect(started.provider.typingChannels).toContain(started.channelId);
    expect(new Set(started.provider.typingChannels)).toStrictEqual(
      new Set([started.channelId]),
    );
    const claim = await claimRun(started.actor, started.runId);

    mockNow(now() + TYPING_REFRESH_GAP_MS);
    const typedBeforeHeartbeat = started.provider.typingChannels.length;
    await expect(
      heartbeat(started.runId, claim.sandboxToken),
    ).resolves.toStrictEqual({ ok: true, typingRefreshIntervalSeconds: 8 });
    expect(started.provider.typingChannels).toHaveLength(
      typedBeforeHeartbeat + 1,
    );

    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The status task is complete.",
    });
    expect(started.provider.sentMessages).toHaveLength(1);
    const typedAtReply = started.provider.typingChannels.length;
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await webhooks.requestAgentHeartbeat(
      { runId: started.runId },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [404],
    );
    await flushWaitUntilForTest();
    expect(started.provider.typingChannels).toHaveLength(typedAtReply);
  });

  it("shows typing when a queued Discord follow-up is admitted and when it launches", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    const typedBeforeFollowup = started.provider.typingChannels.length;
    const followup = discordMessageForTest(started.actor, {
      channelId: started.channelId,
      content: `<@${started.actor.botUserId}> Continue after the first task.`,
    });
    started.provider.messages.set(followup.id, followup);
    await postDiscordMessage(context, followup);
    await flushWaitUntilForTest();
    expect(started.provider.typingChannels).toHaveLength(
      typedBeforeFollowup + 1,
    );

    mockNow(now() + TYPING_REFRESH_GAP_MS);
    const typedBeforeLaunch = started.provider.typingChannels.length;
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "The first task is complete.",
    });
    const events = await readProjectedChatEvents(context, {
      threadId: started.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    const launched = events.filter((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.runId !== undefined &&
        event.runId !== started.runId
      );
    });
    expect(launched).toHaveLength(1);
    expect(started.provider.sentMessages).toHaveLength(1);
    expect(started.provider.typingChannels).toHaveLength(typedBeforeLaunch + 1);
    expect(started.provider.typingChannels.at(-1)).toBe(started.channelId);
  });

  it.each([403, 500] as const)(
    "delivers the reply when Discord rejects typing with HTTP %s",
    async (status) => {
      let typingRequests = 0;
      const started = await startDiscordRun({
        configureProvider: (provider) => {
          provider.state.typingResponse = () => {
            typingRequests += 1;
            return HttpResponse.json({ message: "Rejected" }, { status });
          };
        },
      });
      const { provider } = started;
      expect(typingRequests).toBeGreaterThan(0);
      const claim = await claimRun(started.actor, started.runId);
      mockNow(now() + TYPING_REFRESH_GAP_MS);
      await heartbeat(started.runId, claim.sandboxToken);
      await completeRun({
        runId: started.runId,
        sandboxToken: claim.sandboxToken,
        text: "Delivered despite a typing failure.",
      });
      expect(provider.typingChannels).toHaveLength(0);
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.content).toContain(
        "Delivered despite a typing failure.",
      );
    },
  );

  it("waits out a typing rate limit without delaying the reply", async () => {
    let typingRequests = 0;
    const started = await startDiscordRun({
      configureProvider: (provider) => {
        provider.state.typingResponse = () => {
          typingRequests += 1;
          return typingRequests === 1
            ? HttpResponse.json(
                { message: "Rate limited", retry_after: 60, global: false },
                { status: 429 },
              )
            : undefined;
        };
      },
    });
    const { provider } = started;
    expect(typingRequests).toBe(1);
    const claim = await claimRun(started.actor, started.runId);
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    expect(typingRequests).toBe(1);

    mockNow(now() + 60_000);
    await heartbeat(started.runId, claim.sandboxToken);
    expect(typingRequests).toBe(2);
    expect(provider.typingChannels).toStrictEqual([started.channelId]);

    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "Delivered after a typing rate limit.",
    });
    expect(provider.sentMessages).toHaveLength(1);
  });

  it.each(["binding", "member"] as const)(
    "stops typing after %s revocation",
    async (revocation) => {
      const started = await startDiscordRun();
      const claim = await claimRun(started.actor, started.runId);
      let typingRequests = 0;
      started.provider.state.typingResponse = () => {
        typingRequests += 1;
        return undefined;
      };
      if (revocation === "binding") {
        await deleteDiscordFixture(context, started.actor.fixture);
        started.fixture.deleted = true;
      } else {
        started.provider.deniedMembers.add(started.actor.discordUserId);
      }
      mockNow(now() + TYPING_REFRESH_GAP_MS);
      await heartbeat(started.runId, claim.sandboxToken);
      expect(typingRequests).toBe(0);
    },
  );

  it("refreshes typing without repeating Discord permission reads inside the reuse window", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let channelReads = 0;
    started.provider.state.channelResponse = () => {
      channelReads += 1;
      return undefined;
    };
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    const readsPerFullCheck = channelReads;
    expect(readsPerFullCheck).toBeGreaterThan(0);
    const typedAfterFirstRefresh = started.provider.typingChannels.length;

    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    // One refresh costs one typing request while the permission reads are reused.
    expect(channelReads).toBe(readsPerFullCheck);
    expect(started.provider.typingChannels).toHaveLength(
      typedAfterFirstRefresh + 1,
    );

    mockNow(now() + TYPING_ACCESS_REUSE_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    expect(channelReads).toBe(readsPerFullCheck * 2);
  });

  it("stops typing after member revocation once the reuse window ends", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    started.provider.deniedMembers.add(started.actor.discordUserId);
    mockNow(now() + TYPING_ACCESS_REUSE_MS);
    const typedAtRevocationCheck = started.provider.typingChannels.length;
    await heartbeat(started.runId, claim.sandboxToken);
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    expect(started.provider.typingChannels).toHaveLength(
      typedAtRevocationCheck,
    );
  });

  it("pauses all typing after a rate limit on a Discord permission read", async () => {
    const started = await startDiscordRun();
    const claim = await claimRun(started.actor, started.runId);
    let limited = true;
    let limitedReads = 0;
    server.use(
      http.get(
        "https://discord.com/api/v10/guilds/:guildId/members/:userId",
        () => {
          if (!limited) {
            return undefined;
          }
          limitedReads += 1;
          return HttpResponse.json(
            { message: "Rate limited", retry_after: 30, global: false },
            { status: 429 },
          );
        },
      ),
    );
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    const typedBeforeLimit = started.provider.typingChannels.length;
    await heartbeat(started.runId, claim.sandboxToken);
    expect(limitedReads).toBeGreaterThan(0);
    limited = false;

    // A new conversation in another channel is admitted during the pause.
    const other = discordMessageForTest(started.actor, {
      channelId: started.provider.guildChannelId,
      content: `<@${started.actor.botUserId}> Start a separate task`,
    });
    started.provider.messages.set(other.id, other);
    await postDiscordMessage(context, other);
    await flushWaitUntilForTest();
    mockNow(now() + TYPING_REFRESH_GAP_MS);
    await heartbeat(started.runId, claim.sandboxToken);
    expect(started.provider.typingChannels).toHaveLength(typedBeforeLimit);

    mockNow(now() + 30_000);
    await heartbeat(started.runId, claim.sandboxToken);
    expect(started.provider.typingChannels).toHaveLength(typedBeforeLimit + 1);
    await completeRun({
      runId: started.runId,
      sandboxToken: claim.sandboxToken,
      text: "Delivered after typing yielded to a rate limit.",
    });
    expect(started.provider.sentMessages.at(-1)?.content).toContain(
      "Delivered after typing yielded to a rate limit.",
    );
  });
});
