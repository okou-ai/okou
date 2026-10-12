import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { removePublicDiscordBinding } from "./helpers/discord";
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

describe("Discord chat-write rollout compatibility", () => {
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
          await removePublicDiscordBinding(context, actor.fixture);
        },
        async () => {
          await deleteFeatureSwitchesForUser(context, actor);
        },
      );
    },
  );
});
