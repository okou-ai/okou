import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  appendTerminalChatEventsFixture,
  readSeededUnreadThreadIdsFixture,
} from "../../../test-fixtures/chat-thread-agent-read";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
/** The route's notification budget; one more id than this overflows it. */
const NOTIFIED_THREAD_ID_BUDGET = 100;

interface AgentReadFixture {
  /** Owns the threads and calls the endpoint; never owns the Agent. */
  readonly actor: ApiTestUser;
  /** The Agent owner is a different user from the actor. */
  readonly owner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly threadIds: readonly string[];
}

/**
 * One shared Agent owned by another member of the caller's organization, with
 * `threadCount` threads that belong to the caller. The distinct Agent owner
 * exists before any request runs, so a test never has to transfer the
 * Agent first; the test exercises the actor's read cursor for a shared Agent.
 */
async function createAgentReadFixture(
  threadCount: number,
): Promise<AgentReadFixture> {
  const signal = context.signal;
  const orgId = `org_${randomUUID()}`;
  const owner = bdd.user({ orgId });
  const actor = bdd.user({ orgId });
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(owner, {
    displayName: `Shared ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const model = await chat.getDefaultCreateThreadModel(actor);
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  // Reuse the creation route app instead of rebuilding it for every thread.
  const client = setupApp({ context, signal, routes: chatThreadCreateRoutes })(
    chatThreadsContract,
  );
  const threadIds: string[] = [];
  // Keep one batch below the ten-connection API pool and drain it before
  // propagating errors or changing identities. Eight leaves capacity for the
  // fixture's other database work while keeping high-cardinality cases within
  // the ordinary test budget under shared-runner load.
  const batchSize = 8;
  for (let start = 0; start < threadCount; start += batchSize) {
    signal.throwIfAborted();
    const batch = await Promise.allSettled(
      Array.from(
        { length: Math.min(batchSize, threadCount - start) },
        (_, index) => {
          return accept(
            client.create({
              headers: { authorization: "Bearer clerk-session" },
              body: {
                agentId: agent.agentId,
                title: `Bulk ${start + index}`,
                model,
              },
            }),
            [201],
          );
        },
      ),
    );
    for (const result of batch) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      threadIds.push(result.value.body.id);
    }
  }
  signal.throwIfAborted();
  await appendTerminalChatEventsFixture({ threadIds });
  return { actor, owner, agentId: agent.agentId, orgId, threadIds };
}

function prepareChatRuntime(): void {
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

/**
 * Appends one terminal Run event to a caller thread the way a user does: a
 * chat send launches a Run, which the caller then cancels. Without
 * `threadId` the send creates a new thread. The Run must still be active when
 * it is cancelled, so the org's Fable policy keeps it queued for the native
 * Runner instead of Pi.
 */
async function appendCancelledRun(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly threadId?: string;
}): Promise<string> {
  const { runId, threadId } = await chat.sendAndLaunch(args.actor, {
    agentId: args.agentId,
    prompt: `agent read ${randomUUID()}`,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
  });
  await runs.requestCancelRun(args.actor, runId, [200]);
  await flushWaitUntilForTest();

  await flushWaitUntilForTest();
  await expect(chat.listUnreadChatThreadIds(args.actor)).resolves.toContain(
    threadId,
  );
  return threadId;
}

/**
 * The same shared-Agent shape as {@link createAgentReadFixture}, built only
 * through production APIs: each thread is created by a chat send and made
 * unread by the cancelled Run's terminal event.
 */
async function createUnreadAgentThreads(
  threadCount: number,
): Promise<AgentReadFixture> {
  prepareChatRuntime();
  const orgId = `org_${randomUUID()}`;
  const owner = bdd.user({ orgId });
  const actor = bdd.user({ orgId });
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
  const agent = await bdd.createAgent(owner, {
    displayName: `Shared ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const threadIds: string[] = [];
  for (let index = 0; index < threadCount; index += 1) {
    threadIds.push(await appendCancelledRun({ actor, agentId: agent.agentId }));
  }
  return { actor, owner, agentId: agent.agentId, orgId, threadIds };
}

/** Each thread's read cursor as the production thread reader returns it. */
async function readCursors(
  fixture: AgentReadFixture,
): Promise<ReadonlyMap<string, string | null>> {
  const cursors = new Map<string, string | null>();
  for (const threadId of fixture.threadIds) {
    const detail = await chat.readThread(fixture.actor, threadId);
    cursors.set(threadId, detail.lastReadAt);
  }
  return cursors;
}

/** The thread ids the sidebar currently shows as unread for the actor. */
async function visibleUnreadThreadIds(
  fixture: AgentReadFixture,
): Promise<ReadonlySet<string>> {
  return new Set(await chat.listUnreadChatThreadIds(fixture.actor));
}

/**
 * Complete seeded unread state for this bulk-write fixture. The public
 * indicators return at most 50 unread threads, so they cannot read back the
 * 100+ thread cases.
 */
async function unreadThreadIds(
  fixture: AgentReadFixture,
): Promise<ReadonlySet<string>> {
  return await readSeededUnreadThreadIdsFixture(fixture.threadIds);
}

function clearPublishedNotifications(): void {
  context.mocks.ably.publish.mockClear();
  context.mocks.ably.channelGet.mockClear();
}

/** Every `chatThreadReadCursorUpdated` payload published since the last clear. */
function publishedReadCursorPayloads(): readonly unknown[] {
  return context.mocks.ably.publish.mock.calls
    .filter((call: readonly unknown[]) => {
      return call[0] === "chatThreadReadCursorUpdated";
    })
    .map((call: readonly unknown[]) => {
      return call[1];
    });
}

const readCursorPayloadThreadIdsSchema = z.object({
  threadIds: z.array(z.string()),
});

describe("bulk Agent read-cursor notifications stay bounded", () => {
  it("updates all unread rows and publishes Agent scope above the notification budget", async () => {
    // 128 is the unread candidate bound the route shares with the indicators.
    const fixture = await createAgentReadFixture(
      NOTIFIED_THREAD_ID_BUDGET + 28,
    );
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const overflow = publishedReadCursorPayloads();
    expect(overflow).toStrictEqual([
      { agentId: fixture.agentId, threadIds: [], scope: "agent" },
    ]);
    expect(JSON.stringify(overflow[0]).length).toBeLessThan(4096);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });

  it("publishes nothing when every Agent thread is already read", async () => {
    const fixture = await createUnreadAgentThreads(1);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    clearPublishedNotifications();
    const marked = await readCursors(fixture);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(readCursors(fixture)).resolves.toStrictEqual(marked);
  });

  it("publishes the exact thread ids for 1 unread Agent threads within the budget", async () => {
    const fixture = await createUnreadAgentThreads(1);
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const payloads = publishedReadCursorPayloads();
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload).toStrictEqual({
      agentId: fixture.agentId,
      threadIds: [...fixture.threadIds],
    });
    expect(JSON.stringify(payload).length).toBeLessThan(4096);
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(),
    );
  });

  it("publishes the exact thread ids for 100 unread Agent threads within the budget", async () => {
    const threadCount = NOTIFIED_THREAD_ID_BUDGET;
    const fixture = await createAgentReadFixture(threadCount);
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const payloads = publishedReadCursorPayloads();
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload).toStrictEqual({
      agentId: fixture.agentId,
      threadIds: expect.arrayContaining([...fixture.threadIds]),
    });
    const { threadIds } = readCursorPayloadThreadIdsSchema.parse(payload);
    expect(threadIds).toHaveLength(threadCount);
    expect(JSON.stringify(payload).length).toBeLessThan(4096);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });

  it("publishes Agent scope and updates every row one thread above the notification budget", async () => {
    const fixture = await createAgentReadFixture(NOTIFIED_THREAD_ID_BUDGET + 1);
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([
      { agentId: fixture.agentId, threadIds: [], scope: "agent" },
    ]);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });

  it("leaves unread threads older than the seven-day window untouched", async () => {
    // The stale thread's last message is written at the real current time;
    // the app clock then moves eight days ahead, so that message falls outside
    // the seven-day window while the recent thread is written inside it.
    const fixture = await createUnreadAgentThreads(1);
    const [stale] = fixture.threadIds;
    if (!stale) {
      throw new Error("Expected one stale thread");
    }
    const staleCursor = (await chat.readThread(fixture.actor, stale))
      .lastReadAt;
    mockNow(now() + 8 * 24 * 60 * 60 * 1000);
    await appendCancelledRun({
      actor: fixture.actor,
      agentId: fixture.agentId,
    });

    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);

    await expect(chat.readThread(fixture.actor, stale)).resolves.toMatchObject({
      lastReadAt: staleCursor,
    });
    // Back at the real time the stale thread is inside the window again and
    // is still unread, while the recent one was marked read.
    clearMockNow();
    await expect(
      chat.listUnreadChatThreadIds(fixture.actor),
    ).resolves.toStrictEqual([stale]);
  });

  it("requires an organization and leaves foreign-user, cross-org and unknown-Agent requests without effects", async () => {
    const fixture = await createUnreadAgentThreads(1);
    const before = await readCursors(fixture);
    const peer = bdd.user({ orgId: fixture.orgId });
    const crossOrg = bdd.user({ userId: fixture.actor.userId });
    const orgless = bdd.user({ userId: fixture.actor.userId, orgId: null });
    clearPublishedNotifications();

    await chat.requestMarkAgentThreadsRead(orgless, fixture.agentId, [401]);
    await chat.requestMarkAgentThreadsRead(peer, fixture.agentId, [204]);
    await chat.requestMarkAgentThreadsRead(crossOrg, fixture.agentId, [204]);
    await chat.requestMarkAgentThreadsRead(fixture.actor, randomUUID(), [204]);

    await expect(readCursors(fixture)).resolves.toStrictEqual(before);
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(fixture.threadIds),
    );
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
  });

  it("excludes muted threads from bulk marking but permits explicit single-thread marking", async () => {
    const fixture = await createUnreadAgentThreads(1);
    const before = await readCursors(fixture);
    const [threadId] = fixture.threadIds;
    if (!threadId) {
      throw new Error("Expected one unread thread");
    }
    await bdd.readOnboardingStatus(fixture.actor);
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
        orgRole: fixture.actor.orgRole,
      },
      { [FeatureSwitchKey.ChatThreadMuting]: true },
    );
    await chat.requestSetThreadMuted(fixture.actor, threadId, true, [204]);
    clearPublishedNotifications();

    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(readCursors(fixture)).resolves.toStrictEqual(before);
    expect(publishedReadCursorPayloads()).toStrictEqual([]);

    const marked = await chat.markThreadRead(fixture.actor, threadId);
    expect(marked.lastReadAt).not.toBe(before.get(threadId));
    await expect(
      chat.readThreadMetadata(fixture.actor, threadId),
    ).resolves.toMatchObject({ muted: true });
    expect(publishedReadCursorPayloads()).toStrictEqual([
      { threadId, agentId: fixture.agentId, lastReadAt: marked.lastReadAt },
    ]);
    await chat.requestSetThreadMuted(fixture.actor, threadId, false, [204]);
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(),
    );
  });

  it("leaves another Agent's unread threads untouched", async () => {
    const fixture = await createUnreadAgentThreads(1);
    const other = await createUnreadAgentThreads(1);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(),
    );
    await expect(visibleUnreadThreadIds(other)).resolves.toStrictEqual(
      new Set(other.threadIds),
    );
  });

  it("keeps the newest terminal event as the cursor and never moves a newer cursor backwards", async () => {
    const fixture = await createUnreadAgentThreads(2);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const firstRead = await readCursors(fixture);

    // A later terminal event makes the thread unread again and the next write
    // adopts that newer marker, never an older one and never `now()`.
    for (const threadId of fixture.threadIds) {
      await appendCancelledRun({
        actor: fixture.actor,
        agentId: fixture.agentId,
        threadId,
      });
    }
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(fixture.threadIds),
    );
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const secondRead = await readCursors(fixture);
    for (const threadId of fixture.threadIds) {
      const first = firstRead.get(threadId);
      const second = secondRead.get(threadId);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(Date.parse(second ?? "")).toBeGreaterThan(Date.parse(first ?? ""));
    }
    const unreads = await chat.listThreadUnreads(
      fixture.actor,
      fixture.agentId,
    );
    expect(unreads).toStrictEqual([]);
  });
});
