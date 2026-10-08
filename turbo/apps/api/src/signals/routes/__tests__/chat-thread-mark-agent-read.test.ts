import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
/** The route's notification budget; one more id than this overflows it. */
const NOTIFIED_THREAD_ID_BUDGET = 100;
/** Below both the normal Team admission capacity and the API pool size. */
const PUBLIC_REQUEST_BATCH_SIZE = 8;

interface AgentReadFixture {
  /** Owns the threads and calls the endpoint; never owns the Agent. */
  readonly actor: ApiTestUser;
  /** The Agent owner is a different user from the actor. */
  readonly owner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly threadIds: readonly string[];
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
 * it is cancelled, so the caller selects Fable, whose personal Claude
 * subscription route keeps it queued for the native Runner instead of Pi.
 */
async function appendCancelledRun(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly threadId?: string;
}): Promise<string> {
  const { runId, threadId } = await chat.sendAndLaunch(args.actor, {
    agentId: args.agentId,
    prompt: `agent read ${randomUUID()}`,
    model: "claude-fable-5-1",
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

/** Drain every request before propagating an error or advancing the lifecycle. */
async function completeRequests<T>(
  requests: readonly Promise<T>[],
): Promise<T[]> {
  const results = await Promise.allSettled(requests);
  return results.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}

/**
 * A shared Agent owned by another member, built through production APIs:
 * each thread is created by a chat send and made unread by the cancelled
 * Run's terminal event.
 */
async function createUnreadAgentThreads(
  threadCount: number,
): Promise<AgentReadFixture> {
  prepareChatRuntime();
  const orgId = `org_${randomUUID()}`;
  const owner = bdd.user({ orgId });
  const actor = bdd.user({ orgId });
  await runs.grantProEntitlement(actor, { tier: "team" });
  await expect(runs.readBillingStatus(actor)).resolves.toMatchObject({
    concurrencyLimit: 10,
  });
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(owner, {
    displayName: `Shared ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const threadIds: string[] = [];
  for (let start = 0; start < threadCount; start += PUBLIC_REQUEST_BATCH_SIZE) {
    context.signal.throwIfAborted();
    const sent = await completeRequests(
      Array.from(
        { length: Math.min(PUBLIC_REQUEST_BATCH_SIZE, threadCount - start) },
        async () => {
          const clientEventId = randomUUID();
          const response = await chat.requestSendEvent(
            actor,
            {
              agentId: agent.agentId,
              prompt: `agent read ${clientEventId}`,
              clientEventId,
              model: "claude-fable-5-1",
            },
            [201],
          );
          if (response.status !== 201) {
            throw new Error("Expected the chat send to be accepted");
          }
          return { threadId: response.body.threadId, clientEventId };
        },
      ),
    );
    // One owner drains the production work after all sends have returned.
    // Concurrent sendAndLaunch calls would compete for the shared tracker.
    await flushWaitUntilForTest();
    const launched = await completeRequests(
      sent.map(async ({ threadId, clientEventId }) => {
        const { events } = await chat.listThreadEvents(actor, threadId);
        const event = events.find((candidate) => {
          return (
            candidate.eventType === "input.prompt" &&
            candidate.revokesEventId === clientEventId &&
            candidate.runId !== undefined
          );
        });
        if (!event?.runId) {
          throw new Error("Expected the public event feed to identify the run");
        }
        return { threadId, runId: event.runId };
      }),
    );
    await completeRequests(
      launched.map(({ runId }) => {
        return runs.requestCancelRun(actor, runId, [200]);
      }),
    );
    await flushWaitUntilForTest();
    const unread = await chat.listUnreadChatThreadIds(actor);
    for (const { threadId } of launched) {
      expect(unread).toContain(threadId);
      threadIds.push(threadId);
    }
  }
  return { actor, owner, agentId: agent.agentId, orgId, threadIds };
}

/** Each thread's read cursor as the production thread reader returns it. */
async function readCursors(
  fixture: AgentReadFixture,
): Promise<ReadonlyMap<string, string | null>> {
  const cursors = new Map<string, string | null>();
  for (
    let start = 0;
    start < fixture.threadIds.length;
    start += PUBLIC_REQUEST_BATCH_SIZE
  ) {
    const entries = await completeRequests(
      fixture.threadIds
        .slice(start, start + PUBLIC_REQUEST_BATCH_SIZE)
        .map(async (threadId) => {
          const detail = await chat.readThread(fixture.actor, threadId);
          return [threadId, detail.lastReadAt] as const;
        }),
    );
    for (const [threadId, cursor] of entries) {
      cursors.set(threadId, cursor);
    }
  }
  return cursors;
}

/** The thread ids the sidebar currently shows as unread for the actor. */
async function visibleUnreadThreadIds(
  fixture: AgentReadFixture,
): Promise<ReadonlySet<string>> {
  return new Set(await chat.listUnreadChatThreadIds(fixture.actor));
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
  it("marks all unread threads read and publishes Agent scope above the notification budget", async () => {
    // 128 is the unread candidate bound the route shares with the indicators.
    const fixture = await createUnreadAgentThreads(
      NOTIFIED_THREAD_ID_BUDGET + 28,
    );
    const before = await readCursors(fixture);
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const overflow = publishedReadCursorPayloads();
    expect(overflow).toStrictEqual([
      { agentId: fixture.agentId, threadIds: [], scope: "agent" },
    ]);
    expect(JSON.stringify(overflow[0]).length).toBeLessThan(4096);
    const after = await readCursors(fixture);
    for (const threadId of fixture.threadIds) {
      expect(after.get(threadId)).not.toBeNull();
      expect(after.get(threadId)).not.toBe(before.get(threadId));
    }
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(),
    );
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
    const fixture = await createUnreadAgentThreads(threadCount);
    const before = await readCursors(fixture);
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
    const after = await readCursors(fixture);
    for (const threadId of fixture.threadIds) {
      expect(after.get(threadId)).not.toBeNull();
      expect(after.get(threadId)).not.toBe(before.get(threadId));
    }
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(),
    );
  });

  it("publishes Agent scope and marks every thread read one thread above the notification budget", async () => {
    const fixture = await createUnreadAgentThreads(
      NOTIFIED_THREAD_ID_BUDGET + 1,
    );
    const before = await readCursors(fixture);
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([
      { agentId: fixture.agentId, threadIds: [], scope: "agent" },
    ]);
    const after = await readCursors(fixture);
    for (const threadId of fixture.threadIds) {
      expect(after.get(threadId)).not.toBeNull();
      expect(after.get(threadId)).not.toBe(before.get(threadId));
    }
    await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(),
    );
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
