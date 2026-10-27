import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { iosNotificationsContract } from "@okouai/api-contracts/contracts/ios-notifications";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { iosNotificationsRoutes } from "../ios-notifications";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { authenticateIosSession } from "./helpers/ios-push";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);

function prepareRuntime() {
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

async function unreadConversation(actor: ApiTestUser) {
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Notification state",
    visibility: "private",
  });
  const sent = await chat.sendAndLaunch(actor, {
    agentId: agent.agentId,
    prompt: "Unread result",
  });
  await runs.requestCancelRun(actor, sent.runId, [200]);
  await flushWaitUntilForTest();
  return { ...sent, agentId: agent.agentId };
}

function reconcile(
  actor: ApiTestUser,
  notifications: {
    identifier: string;
    threadId: string;
    runId: string;
  }[],
) {
  if (!actor.orgId) {
    throw new Error("Expected a workspace-scoped test session");
  }
  authenticateIosSession(context, actor.userId, actor.orgId);
  return accept(
    setupApp({ context, routes: iosNotificationsRoutes })(
      iosNotificationsContract,
    ).reconcile({
      headers: { authorization: "Bearer clerk-session" },
      body: { installationId: randomUUID(), notifications },
    }),
    [200],
  );
}

describe("iOS notification read-state reconciliation", () => {
  it("counts owned unread conversations across workspaces and clears only read or unavailable receipts", async () => {
    prepareRuntime();
    const actor = bdd.user();
    const otherWorkspace = bdd.user({ userId: actor.userId });
    const foreign = bdd.user();
    const read = await unreadConversation(actor);
    const unread = await unreadConversation(otherWorkspace);
    const inaccessible = await unreadConversation(foreign);
    await chat.markThreadRead(actor, read.threadId);
    const notifications = [
      { identifier: "read", threadId: read.threadId, runId: read.runId },
      { identifier: "unread", threadId: unread.threadId, runId: unread.runId },
      {
        identifier: "foreign",
        threadId: inaccessible.threadId,
        runId: inaccessible.runId,
      },
      { identifier: "missing", threadId: randomUUID(), runId: randomUUID() },
    ];
    const result = await reconcile(actor, notifications);
    expect(result.body).toStrictEqual({
      unreadCount: 1,
      removeIdentifiers: ["read", "foreign", "missing"],
    });
    await updateFeatureSwitchesForUser(
      context,
      {
        ...otherWorkspace,
        orgId: otherWorkspace.orgId!,
      },
      { chatThreadMuting: true },
    );
    await chat.requestSetThreadMuted(
      otherWorkspace,
      unread.threadId,
      true,
      [204],
    );
    const muted = await reconcile(actor, notifications);
    expect(muted.body).toStrictEqual({
      unreadCount: 0,
      removeIdentifiers: ["read", "unread", "foreign", "missing"],
    });
  });

  it("removes an older read run while preserving a newer unread run in the same conversation", async () => {
    prepareRuntime();
    const actor = bdd.user();
    const first = await unreadConversation(actor);
    await chat.markThreadRead(actor, first.threadId);
    const next = await chat.sendAndLaunch(actor, {
      agentId: first.agentId,
      threadId: first.threadId,
      prompt: "A later unread result",
    });
    await runs.requestCancelRun(actor, next.runId, [200]);
    await flushWaitUntilForTest();
    const result = await reconcile(actor, [
      { identifier: "older", threadId: first.threadId, runId: first.runId },
      { identifier: "newer", threadId: next.threadId, runId: next.runId },
    ]);
    expect(result.body).toStrictEqual({
      unreadCount: 1,
      removeIdentifiers: ["older"],
    });
  });
});
