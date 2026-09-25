import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { testDiscordIngressContract } from "@okouai/api-contracts/contracts/test-discord-ingress";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { installDiscordContextFailureFixture } from "../../../test-fixtures/discord-context-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { testDiscordIngressRoutes } from "../test-discord-ingress";
import { createRunsApi } from "./helpers/api-bdd-runs";
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
import { deleteFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

function events(actor: ConnectedDiscordActor, threadId: string) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  return readProjectedChatEvents(context, {
    threadId,
    headers: { authorization: "Bearer clerk-session" },
  });
}

function inputs(rows: readonly ChatEvent[]) {
  const revokedIds = revokedChatEventIds(rows);
  return rows.filter(
    (row): row is Extract<ChatEvent, { eventType: "input.prompt" }> => {
      return row.eventType === "input.prompt" && !revokedIds.has(row.id);
    },
  );
}

async function withCleanup(
  work: () => Promise<void>,
  ...cleanups: readonly (() => Promise<void>)[]
) {
  const outcomes = [await settleIncludingAbort(work())];
  for (const cleanup of cleanups) {
    outcomes.push(await settleIncludingAbort(cleanup()));
  }
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      throw outcome.error;
    }
  }
}

async function exerciseContextRetry() {
  const actor = await setupConnectedDiscordActor(context);
  await withCleanup(
    async () => {
      const provider = mockDiscordProvider(actor);
      const message = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> preserve this context across recovery`,
      });
      provider.messages.set(message.id, message);
      const removeFault = await installDiscordContextFailureFixture(message.id);
      await withCleanup(async () => {
        expect((await postDiscordMessage(context, message)).body.outcome).toBe(
          "accepted",
        );
        await flushWaitUntilForTest();
      }, removeFault);

      // Canonical route creation happens before input preparation. A required
      // context failure must leave this real chat empty and must not launch.
      const threads = await discordChatThreads(context, actor);
      expect(threads).toHaveLength(1);
      const [thread] = threads;
      if (!thread) {
        throw new Error("Expected the canonical Discord thread");
      }
      await expect(events(actor, thread.id)).resolves.toStrictEqual([]);
      expect(
        (await runs.listAgentRuns(actor.actor, { limit: 20 })).runs,
      ).toStrictEqual([]);
      expect(provider.sentMessages).toHaveLength(0);

      expect(
        (await postDiscordMessage(context, message, `redelivery:${message.id}`))
          .body.outcome,
      ).toBe("duplicate");
      mockNow(now() + 61_000);
      await accept(
        setupApp({ context, routes: testDiscordIngressRoutes })(
          testDiscordIngressContract,
        ).recover({ body: { connectionIds: [actor.connectionId] } }),
        [200],
      );
      await flushWaitUntilForTest();

      const recoveredThreads = await discordChatThreads(context, actor);
      expect(
        recoveredThreads.map((row) => {
          return row.id;
        }),
      ).toStrictEqual([thread.id]);
      const recovered = inputs(await events(actor, thread.id));
      expect(recovered).toHaveLength(1);
      const [input] = recovered;
      if (!input?.runId) {
        throw new Error("Expected one Run after required context recovery");
      }
      const run = await runs.readRun(actor.actor, input.runId);
      expect(run.prompt).toBe("@Okou preserve this context across recovery");
      expect(run.appendSystemPrompt).toContain(message.id);
      expect(input.userMessage.parts).toContainEqual({
        type: "source",
        kind: "discord",
        href: `https://discord.com/channels/${actor.guildId}/${provider.guildChannelId}/${message.id}`,
      });

      // Terminal projection and its native delivery also cross the active
      // runtime mapping. Recovery must retain a single visible reply.
      await runs.requestCancelRun(actor.actor, input.runId, [200]);
      await flushWaitUntilForTest();
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]).toMatchObject({
        channel_id: message.id,
        content: expect.stringMatching(/cancel/iu),
      });
      const completed = await events(actor, thread.id);
      expect(inputs(completed)).toHaveLength(1);
      expect(
        completed.filter((event) => {
          return event.eventType === "run.cancelled";
        }),
      ).toHaveLength(1);
      expect(
        new Set(
          completed.map((event) => {
            return event.seqId;
          }),
        ).size,
      ).toBe(completed.length);
    },
    flushWaitUntilForTest,
    async () => {
      await deleteDiscordFixture(context, actor.fixture);
    },
    async () => {
      await deleteFeatureSwitchesForUser(context, actor);
    },
  );
}

describe("Discord chat-write rollout compatibility", () => {
  it("retries a required context failure without a partial input or duplicate reply", async () => {
    expect.hasAssertions();
    await exerciseContextRetry();
  });

  it(
    "posts the Discord reply once when the runner repeats its terminal callback",
    { timeout: 120_000 },
    async () => {
      const actor = await setupConnectedDiscordActor(context);
      await withCleanup(
        async () => {
          runs.acceptTelemetryIngest();
          const provider = mockDiscordProvider(actor);
          const message = discordMessageForTest(actor, {
            channelId: provider.guildChannelId,
            content: `<@${actor.botUserId}> finish the replayed callback`,
          });
          provider.messages.set(message.id, message);
          await postDiscordMessage(context, message);
          await flushWaitUntilForTest();
          const [thread] = await discordChatThreads(context, actor);
          if (!thread) {
            throw new Error("Expected the canonical Discord thread");
          }
          const [input] = inputs(await events(actor, thread.id));
          if (!input?.runId) {
            throw new Error("Expected a Discord Run");
          }
          await runs.heartbeatRunner(actor.runnerGroup);
          const claim = await runs.claimRunnerJob(input.runId);
          const headers = { authorization: `Bearer ${claim.sandboxToken}` };
          const completion = {
            runId: input.runId,
            exitCode: 1,
            error: "Internal Discord callback test failure",
          };
          await webhooks.requestAgentComplete(completion, headers, [200]);
          await webhooks.requestAgentComplete(completion, headers, [200]);
          await webhooks.requestAgentComplete(completion, headers, [200]);
          await flushWaitUntilForTest();
          expect(provider.sentMessages).toHaveLength(1);
          expect(provider.sentMessages[0]?.channel_id).toBe(message.id);
          const final = await events(actor, thread.id);
          const failed = final.filter((event) => {
            return event.eventType === "run.failed";
          });
          expect(failed).toHaveLength(1);
          const error = failed[0]?.content;
          if (!error) {
            throw new Error("Expected the canonical safe run error");
          }
          expect(provider.sentMessages[0]?.content).toContain(error);
          expect(provider.sentMessages[0]?.content).not.toContain(
            completion.error,
          );
        },
        flushWaitUntilForTest,
        async () => {
          await deleteDiscordFixture(context, actor.fixture);
        },
        async () => {
          await deleteFeatureSwitchesForUser(context, actor);
        },
      );
    },
  );
});
