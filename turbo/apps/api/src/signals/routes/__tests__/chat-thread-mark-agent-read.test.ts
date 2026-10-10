import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import {
  clearMockNow,
  mockNow,
  now,
  withNowScopeForTest,
} from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  updateFeatureSwitchesForUser,
  deleteFeatureSwitchesForUser,
} from "./helpers/feature-switches";

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
  readonly run: ReturnType<typeof createPublicComputerUseScenario>["run"];
}

/** Create a shared Agent and actual cancelled Runs for each member-owned thread. */
async function createAgentReadFixture(
  threadCount: number,
): Promise<AgentReadFixture> {
  const lifecycle = createPublicComputerUseScenario(context);
  const orgId = `org_${randomUUID()}`;
  const owner = lifecycle.user({ orgId });
  const actor = lifecycle.user({ orgId });
  lifecycle.beforeWorkspaceCleanup(() => {
    return deleteFeatureSwitchesForUser(context, { ...actor, orgId });
  });
  return await lifecycle.run(async () => {
    prepareChatRuntime();
    await lifecycle.prepareActor(actor);
    const agent = await bdd.createAgent(owner, {
      displayName: `Shared ${randomUUID().slice(0, 8)}`,
      visibility: "public",
    });
    const threadIds: string[] = [];
    // Each batch stays within the normal Pro concurrency allowance. Join every
    // accepted send/cancel before changing identity or propagating an error.
    const batchSize = 3;
    for (let start = 0; start < threadCount; start += batchSize) {
      context.signal.throwIfAborted();
      const batch = await Promise.allSettled(
        Array.from({ length: Math.min(batchSize, threadCount - start) }, () => {
          return appendCancelledRun({
            actor,
            agentId: agent.agentId,
            run: lifecycle.run,
          });
        }),
      );
      for (const result of batch) {
        if (result.status === "rejected") {
          throw result.reason;
        }
        threadIds.push(result.value);
      }
    }
    return {
      actor,
      owner,
      agentId: agent.agentId,
      orgId,
      threadIds,
      run: lifecycle.run,
    };
  });
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
  readonly run: AgentReadFixture["run"];
}): Promise<string> {
  return await args.run(async () => {
    const { runId, threadId } = await chat.sendAndLaunch(args.actor, {
      agentId: args.agentId,
      prompt: `agent read ${randomUUID()}`,
      model: "claude-fable-5-1",
      ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
    });
    await runs.requestCancelRun(args.actor, runId, [200]);
    await flushWaitUntilForTest();
    const [page, detail] = await Promise.all([
      chat.listThreadEvents(args.actor, threadId),
      chat.readThread(args.actor, threadId),
    ]);
    const terminals = page.events.filter((event) => {
      return (
        event.runId === runId && isChatRunTerminalEventType(event.eventType)
      );
    });
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    if (!terminal) {
      throw new Error("Expected the actual cancelled Run terminal event");
    }
    expect(terminal.eventType).toBe("run.cancelled");
    expect(
      detail.lastReadAt === null ||
        Date.parse(detail.lastReadAt) < Date.parse(terminal.createdAt),
    ).toBeTruthy();
    return threadId;
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

/** Compare every known thread's public terminal events and cursor, beyond the sidebar limit. */
async function unreadThreadIds(
  fixture: AgentReadFixture,
): Promise<ReadonlySet<string>> {
  return await fixture.run(async () => {
    return await withNowScopeForTest(async () => {
      const unread = new Set<string>();
      const batchSize = 8;
      for (
        let start = 0;
        start < fixture.threadIds.length;
        start += batchSize
      ) {
        const batch = await Promise.allSettled(
          fixture.threadIds
            .slice(start, start + batchSize)
            .map(async (threadId) => {
              const [page, detail] = await Promise.all([
                chat.listThreadEvents(fixture.actor, threadId),
                chat.readThread(fixture.actor, threadId),
              ]);
              const terminals = page.events.filter((event) => {
                return isChatRunTerminalEventType(event.eventType);
              });
              expect(terminals).not.toHaveLength(0);
              if (
                terminals.some((event) => {
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
        for (const result of batch) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      }
      return unread;
    });
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
    const fixture = await createAgentReadFixture(
      NOTIFIED_THREAD_ID_BUDGET + 28,
    );
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
        clearPublishedNotifications();
        await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
        const overflow = publishedReadCursorPayloads();
        expect(overflow).toStrictEqual([
          { agentId: fixture.agentId, threadIds: [], scope: "agent" },
        ]);
        expect(JSON.stringify(overflow[0]).length).toBeLessThan(4096);
        await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
          new Set(),
        );
      });
    });
  });

  it("publishes nothing when every Agent thread is already read", async () => {
    const fixture = await createAgentReadFixture(1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
        await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
        clearPublishedNotifications();
        const marked = await readCursors(fixture);
        await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
        expect(publishedReadCursorPayloads()).toStrictEqual([]);
        await expect(readCursors(fixture)).resolves.toStrictEqual(marked);
      });
    });
  });

  it("publishes the exact thread ids for 1 unread Agent threads within the budget", async () => {
    const fixture = await createAgentReadFixture(1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
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
    });
  });

  it("publishes the exact thread ids for 100 unread Agent threads within the budget", async () => {
    const threadCount = NOTIFIED_THREAD_ID_BUDGET;
    const fixture = await createAgentReadFixture(threadCount);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
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
        await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
          new Set(),
        );
      });
    });
  });

  it("publishes Agent scope and updates every row one thread above the notification budget", async () => {
    const fixture = await createAgentReadFixture(NOTIFIED_THREAD_ID_BUDGET + 1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
        clearPublishedNotifications();
        await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
        expect(publishedReadCursorPayloads()).toStrictEqual([
          { agentId: fixture.agentId, threadIds: [], scope: "agent" },
        ]);
        await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
          new Set(),
        );
      });
    });
  });

  it("leaves unread threads older than the seven-day window untouched", async () => {
    // The stale thread's last message is written at the real current time;
    // the app clock then moves eight days ahead, so that message falls outside
    // the seven-day window while the recent thread is written inside it.
    const fixture = await createAgentReadFixture(1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
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
          run: fixture.run,
        });
        await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
        await expect(
          chat.readThread(fixture.actor, stale),
        ).resolves.toMatchObject({
          lastReadAt: staleCursor,
        });
        // Back at the real time the stale thread is inside the window again and
        // is still unread, while the recent one was marked read.
        clearMockNow();
        await expect(
          chat.listUnreadChatThreadIds(fixture.actor),
        ).resolves.toStrictEqual([stale]);
      });
    });
  });

  it("requires an organization and leaves foreign-user, cross-org and unknown-Agent requests without effects", async () => {
    const fixture = await createAgentReadFixture(1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
        const before = await readCursors(fixture);
        const peer = bdd.user({ orgId: fixture.orgId });
        const crossOrg = bdd.user({ userId: fixture.actor.userId });
        const orgless = bdd.user({ userId: fixture.actor.userId, orgId: null });
        clearPublishedNotifications();
        await chat.requestMarkAgentThreadsRead(orgless, fixture.agentId, [401]);
        await chat.requestMarkAgentThreadsRead(peer, fixture.agentId, [204]);
        await chat.requestMarkAgentThreadsRead(
          crossOrg,
          fixture.agentId,
          [204],
        );
        await chat.requestMarkAgentThreadsRead(
          fixture.actor,
          randomUUID(),
          [204],
        );
        await expect(readCursors(fixture)).resolves.toStrictEqual(before);
        await expect(visibleUnreadThreadIds(fixture)).resolves.toStrictEqual(
          new Set(fixture.threadIds),
        );
        expect(publishedReadCursorPayloads()).toStrictEqual([]);
      });
    });
  });

  it("excludes muted threads from bulk marking but permits explicit single-thread marking", async () => {
    const fixture = await createAgentReadFixture(1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
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
    });
  });

  it("leaves another Agent's unread threads untouched", async () => {
    const fixture = await createAgentReadFixture(1);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
        const other = await createAgentReadFixture(1);
        await other.run(() => {
          return withNowScopeForTest(async () => {
            await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
            await expect(
              visibleUnreadThreadIds(fixture),
            ).resolves.toStrictEqual(new Set());
            await expect(visibleUnreadThreadIds(other)).resolves.toStrictEqual(
              new Set(other.threadIds),
            );
          });
        });
      });
    });
  });

  it("keeps the newest terminal event as the cursor and never moves a newer cursor backwards", async () => {
    const fixture = await createAgentReadFixture(2);
    await fixture.run(async () => {
      return await withNowScopeForTest(async () => {
        await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
        const firstRead = await readCursors(fixture);
        // A later terminal event makes the thread unread again and the next write
        // adopts that newer marker, never an older one and never `now()`.
        for (const threadId of fixture.threadIds) {
          await appendCancelledRun({
            actor: fixture.actor,
            agentId: fixture.agentId,
            run: fixture.run,
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
          expect(Date.parse(second ?? "")).toBeGreaterThan(
            Date.parse(first ?? ""),
          );
        }
        const unreads = await chat.listThreadUnreads(
          fixture.actor,
          fixture.agentId,
        );
        expect(unreads).toStrictEqual([]);
      });
    });
  });
});
