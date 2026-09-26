import { randomUUID } from "node:crypto";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  ageChatThreadsFixture,
  appendTerminalChatEventsFixture,
  readChatThreadCursorsFixture,
  readSeededUnreadThreadIdsFixture,
} from "../../../test-fixtures/chat-thread-agent-read";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
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

/** Complete seeded unread state for this bulk-write fixture. */
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
    const fixture = await createAgentReadFixture(1);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    clearPublishedNotifications();
    const marked = await readChatThreadCursorsFixture(fixture.threadIds);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(marked);
  });

  it.each([1, NOTIFIED_THREAD_ID_BUDGET] as const)(
    "publishes the exact thread ids for %i unread Agent threads within the budget",
    async (threadCount) => {
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
    },
  );

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
    const fixture = await createAgentReadFixture(2);
    const [recent, stale] = fixture.threadIds;
    if (!recent || !stale) {
      throw new Error("Expected two seeded threads");
    }
    await ageChatThreadsFixture({
      threadIds: [stale],
      lastMessageAt: new Date(now() - 8 * 24 * 60 * 60 * 1000),
    });

    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);

    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set([stale]),
    );
  });

  it("leaves another Agent's unread threads untouched", async () => {
    const fixture = await createAgentReadFixture(1);
    const other = await createAgentReadFixture(1);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(unreadThreadIds(other)).resolves.toStrictEqual(
      new Set(other.threadIds),
    );
  });

  it("keeps the newest terminal event as the cursor and never moves a newer cursor backwards", async () => {
    const fixture = await createAgentReadFixture(2);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const firstRead = await readChatThreadCursorsFixture(fixture.threadIds);

    // A later terminal event makes the thread unread again and the next write
    // adopts that newer marker, never an older one and never `now()`.
    await appendTerminalChatEventsFixture({ threadIds: fixture.threadIds });
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(fixture.threadIds),
    );
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const secondRead = await readChatThreadCursorsFixture(fixture.threadIds);
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
