import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { iosNotificationsContract } from "@okouai/api-contracts/contracts/ios-notifications";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { iosNotificationsRoutes } from "../ios-notifications";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  authenticateIosSession,
  reconcileIosNotifications,
  registerIosPush,
} from "./helpers/ios-push";
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
  it("acknowledges only this installation's badge while preserving unread chats across workspaces", async () => {
    prepareRuntime();
    const actor = bdd.user();
    const identity = { ...actor, orgId: actor.orgId! };
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(clearMockNow);
    const old = await unreadConversation(actor);
    const otherWorkspace = bdd.user({ userId: actor.userId });
    await unreadConversation(otherWorkspace);
    let phone = await registerIosPush(context, identity);
    const tablet = await registerIosPush(context, identity);

    mockNow(startedAt + 1000);
    const opened = { badgeClearSequence: 1 };
    expect(
      (await reconcileIosNotifications(context, identity, phone, opened)).body,
    ).toMatchObject({ unreadCount: 2, badgeCount: 0 });
    await expect(chat.listUnreadChatThreadIds(actor)).resolves.toContain(
      old.threadId,
    );

    mockNow(startedAt + 2000);
    const fresh = await unreadConversation(actor);
    expect(
      (await reconcileIosNotifications(context, identity, phone, opened)).body,
    ).toMatchObject({ unreadCount: 3, badgeCount: 1 });
    expect(
      (await reconcileIosNotifications(context, identity, tablet)).body,
    ).toStrictEqual({ unreadCount: 3, removeIdentifiers: [] });

    // A background process can re-register without another foreground visit.
    mockNow(startedAt + 3000);
    phone = await registerIosPush(context, identity, {
      ...phone,
      revision: phone.revision + 1,
    });
    expect(
      (await reconcileIosNotifications(context, identity, phone, opened)).body,
    ).toMatchObject({ unreadCount: 3, badgeCount: 1 });

    await chat.markThreadRead(actor, fresh.threadId);
    await chat.markThreadUnread(actor, old.threadId);
    expect(
      (await reconcileIosNotifications(context, identity, phone, opened)).body,
    ).toMatchObject({ unreadCount: 2, badgeCount: 0 });
  });

  it("never lets a delayed foreground acknowledgement move the badge cursor backwards", async () => {
    prepareRuntime();
    const actor = bdd.user();
    const identity = { ...actor, orgId: actor.orgId! };
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(clearMockNow);
    await unreadConversation(actor);
    const phone = await registerIosPush(context, identity);
    mockNow(startedAt + 1000);
    const earlier = { badgeClearSequence: 1 };
    await reconcileIosNotifications(context, identity, phone, earlier);
    mockNow(startedAt + 2000);
    await unreadConversation(actor);
    mockNow(startedAt + 3000);
    await reconcileIosNotifications(context, identity, phone, {
      badgeClearSequence: 2,
    });
    expect(
      (await reconcileIosNotifications(context, identity, phone, earlier)).body,
    ).toMatchObject({ unreadCount: 2, badgeCount: 0 });
  });

  it("binds badge acknowledgement to the exact installation revision and signed-in account", async () => {
    prepareRuntime();
    const previous = bdd.user();
    const current = bdd.user();
    const previousIdentity = { ...previous, orgId: previous.orgId! };
    const currentIdentity = { ...current, orgId: current.orgId! };
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(clearMockNow);
    const oldBinding = await registerIosPush(context, previousIdentity);
    mockNow(startedAt + 1000);
    const cursor = { badgeClearSequence: 1 };
    await reconcileIosNotifications(
      context,
      previousIdentity,
      oldBinding,
      cursor,
    );
    const currentBinding = await registerIosPush(context, currentIdentity, {
      ...oldBinding,
      revision: oldBinding.revision + 1,
    });
    await reconcileIosNotifications(
      context,
      currentIdentity,
      currentBinding,
      cursor,
    );
    mockNow(startedAt + 2000);
    await unreadConversation(current);
    mockNow(startedAt + 3000);
    await reconcileIosNotifications(context, previousIdentity, oldBinding, {
      badgeClearSequence: 2,
    });
    expect(
      (
        await reconcileIosNotifications(
          context,
          currentIdentity,
          currentBinding,
          cursor,
        )
      ).body,
    ).toMatchObject({ unreadCount: 1, badgeCount: 1 });
  });

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

describe("iOS notification prefetch diagnostics", () => {
  it.each([
    { source: "app" as const },
    {
      source: "extension" as const,
      observedAt: "2026-10-27T01:23:45.678Z",
    },
  ])(
    "accepts payload-free observations from a native $source session",
    async (observation) => {
      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected a workspace session");
      }
      authenticateIosSession(context, actor.userId, actor.orgId);
      const result = await accept(
        setupApp({ context, routes: iosNotificationsRoutes })(
          iosNotificationsContract,
        ).prefetch({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            notificationId: `${randomUUID()}:completed`,
            threadId: randomUUID(),
            runId: randomUUID(),
            ...observation,
            outcome: "saved",
            durationMs: 120,
            lastSeqId: 42,
            containsRun: true,
          },
        }),
        [200],
      );
      expect(result.body).toStrictEqual({ success: true });
    },
  );
});
