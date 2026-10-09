import { publicRunOwner } from "./helpers/public-run-owner";
import { randomUUID } from "node:crypto";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { agentsRoutes } from "../agents";
import { mockClerkUsers } from "./helpers/clerk-users";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
import { createRouteMocks } from "./helpers/route-test";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
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

interface AgentReadFixture {
  /** Owns the threads and calls the endpoint; never owns the Agent. */
  readonly actor: ApiTestUser;
  /** The Agent owner is a different user from the actor. */
  readonly owner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly threadIds: readonly string[];
  readonly signal: AbortSignal;
  readonly run: ReturnType<typeof publicRunOwner>["run"];
}

function prepareChatRuntime(): void {
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

/** The normal SharedWorker batch reader returns every fresh thread's full tail. */
async function threadEvents(actor: ApiTestUser, threadIds: readonly string[]) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const response = await accept(
    setupApp({ context, routes: chatThreadRoutes })(
      chatThreadEventsContract,
    ).catchUp({
      headers: { authorization: "Bearer clerk-session" },
      body: threadIds.map((threadId): [string, number] => {
        return [threadId, 0];
      }),
    }),
    [200],
  );
  expect(response.body.notFoundThreads).toStrictEqual([]);
  expect(Object.keys(response.body.events).sort()).toStrictEqual(
    [...threadIds].sort(),
  );
  return new Map(
    Object.entries(response.body.events).map(([id, rows]) => {
      return [id, projectChatEventRows(rows)];
    }),
  );
}

async function settledValues<T>(
  operations: readonly Promise<T>[],
): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  return results.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}

/** Normal chat sends and cancellations; batch only their public observations. */
async function appendCancelledRuns(
  args: {
    readonly actor: ApiTestUser;
    readonly agentId: string;
    readonly threadId?: string;
  },
  count: number,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const sent = await settledValues(
    Array.from({ length: count }, async () => {
      const clientEventId = randomUUID();
      const response = await chat.requestSendEvent(
        args.actor,
        {
          agentId: args.agentId,
          prompt: `agent read ${randomUUID()}`,
          model: "claude-fable-5-1",
          clientEventId,
          ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
        },
        [201],
        {},
        signal,
      );
      if (response.status !== 201) {
        throw new Error("Expected a normal chat send");
      }
      return { threadId: response.body.threadId, clientEventId };
    }),
  );
  signal.throwIfAborted();
  await flushWaitUntilForTest();
  signal.throwIfAborted();
  const threadIds = sent.map(({ threadId }) => {
    return threadId;
  });
  const launched = await threadEvents(args.actor, threadIds);
  const runIds = sent.map(({ threadId, clientEventId }) => {
    const prompt = launched.get(threadId)?.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === clientEventId
      );
    });
    if (!prompt?.runId) {
      throw new Error("Expected the public chat send to launch its Run");
    }
    return prompt.runId;
  });
  signal.throwIfAborted();
  await settledValues(
    runIds.map((runId) => {
      return runs.requestCancelRun(args.actor, runId, [200]);
    }),
  );
  signal.throwIfAborted();
  await flushWaitUntilForTest();
  signal.throwIfAborted();
  const terminal = await threadEvents(args.actor, threadIds);
  for (const [index, threadId] of threadIds.entries()) {
    expect(terminal.get(threadId)).toContainEqual(
      expect.objectContaining({
        eventType: "run.cancelled",
        runId: runIds[index],
      }),
    );
  }
  return threadIds;
}

async function appendCancelledRun(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly threadId?: string;
}): Promise<string> {
  const [threadId] = await appendCancelledRuns(args, 1, context.signal);
  if (!threadId) {
    throw new Error("Expected one cancelled thread");
  }
  return threadId;
}

/**
 * A shared Agent owned by another member, using only production APIs.
 * Each thread is created by a chat send and made
 * unread by the cancelled Run's terminal event.
 */
async function createUnreadAgentThreads(
  threadCount: number,
): Promise<AgentReadFixture> {
  const signal = context.signal;
  prepareChatRuntime();
  const orgId = `org_${randomUUID()}`;
  const owner = bdd.user({ orgId });
  const actor = bdd.user({ orgId });
  createRouteMocks(context).clerk.session(
    owner.userId,
    owner.orgId,
    owner.orgRole,
  );
  mockClerkUsers(context, [
    {
      id: owner.userId,
      emailAddresses: [
        { id: `email_${owner.userId}`, emailAddress: owner.email },
      ],
      primaryEmailAddressId: `email_${owner.userId}`,
      firstName: "Unread",
      lastName: "Owner",
    },
  ]);
  // Select the existing case-local transport in the first real API request.
  // All decisive business state below still comes from ordinary public routes.
  const client = (
    await setupApp({ context, routes: agentsRoutes, isolatePg: true })
  )(agentsMainContract);
  const { body: agent } = await accept(
    client.create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        displayName: `Shared ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      },
    }),
    [201],
  );
  const owned = publicRunOwner(context, actor, {
    afterRuns: async () => {
      context.mocks.s3.send.mockResolvedValue({
        Contents: [],
        IsTruncated: false,
      });
      await bdd.deleteAgent(owner, agent.agentId);
      await flushWaitUntilForTest();
    },
  });
  return await owned.run(async () => {
    signal.throwIfAborted();
    await runs.grantProEntitlement(actor, {
      tier: threadCount > 3 ? "team" : "pro",
    });
    signal.throwIfAborted();
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const threadIds: string[] = [];
    // Team's ten real admission slots accommodate eight concurrent sends.
    const batchSize = threadCount > 3 ? 8 : 2;
    for (let start = 0; start < threadCount; start += batchSize) {
      signal.throwIfAborted();
      threadIds.push(
        ...(await appendCancelledRuns(
          { actor, agentId: agent.agentId },
          Math.min(batchSize, threadCount - start),
          signal,
        )),
      );
    }
    return {
      actor,
      owner,
      agentId: agent.agentId,
      orgId,
      threadIds,
      signal,
      run: owned.run,
    };
  });
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

/** Observe every known thread, without the sidebar's 50-thread cap. */
async function unreadThreadIds(
  fixture: AgentReadFixture,
): Promise<ReadonlySet<string>> {
  return await fixture.run(async () => {
    fixture.signal.throwIfAborted();
    const eventsByThread = await threadEvents(fixture.actor, fixture.threadIds);
    const unread = new Set<string>();
    for (let start = 0; start < fixture.threadIds.length; start += 8) {
      fixture.signal.throwIfAborted();
      await settledValues(
        fixture.threadIds.slice(start, start + 8).map(async (threadId) => {
          const detail = await chat.readThread(fixture.actor, threadId);
          const terminal = (eventsByThread.get(threadId) ?? []).filter(
            (event) => {
              return ["run.completed", "run.cancelled", "run.failed"].includes(
                event.eventType,
              );
            },
          );
          expect(terminal.length).toBeGreaterThan(0);
          if (
            terminal.some((event) => {
              return (
                detail.lastReadAt === null ||
                Date.parse(event.createdAt) > Date.parse(detail.lastReadAt)
              );
            })
          ) {
            unread.add(threadId);
          }
        }),
      );
    }
    return unread;
  });
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
    const fixture = await createUnreadAgentThreads(
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
    const fixture = await createUnreadAgentThreads(threadCount);
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
    const fixture = await createUnreadAgentThreads(
      NOTIFIED_THREAD_ID_BUDGET + 1,
    );
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
