import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  appendTerminalChatEventsFixture,
  holdAgentRowLockFixture,
  readChatThreadCursorsFixture,
  withChatThreadAgentReadBarrierFixture,
} from "../../../test-fixtures/chat-thread-agent-read-erasure";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
/** The route's notification budget; one more id than this overflows it. */
const NOTIFIED_THREAD_ID_BUDGET = 100;

interface AgentReadFixture {
  /** Owns the threads and calls the endpoint; never owns the Agent. */
  readonly actor: ApiTestUser;
  /** The canonical Agent owner, a user subject distinct from the actor. */
  readonly owner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly threadIds: readonly string[];
}

/**
 * One shared Agent owned by another member of the caller's organization, with
 * `threadCount` threads that belong to the caller. The distinct Agent owner
 * exists before any request runs, so a closure test never has to transfer the
 * Agent first and can never be satisfied by an identity mismatch instead of the
 * shared admission.
 */
async function createAgentReadFixture(
  threadCount: number,
): Promise<AgentReadFixture> {
  const orgId = `org_${randomUUID()}`;
  const owner = bdd.user({ orgId });
  const actor = bdd.user({ orgId });
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(owner, {
    displayName: `Shared ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const model = await chat.getDefaultCreateThreadModel(actor);
  const threadIds: string[] = [];
  for (let index = 0; index < threadCount; index++) {
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: `Bulk ${index}`,
      model,
    });
    threadIds.push(thread.id);
  }
  await appendTerminalChatEventsFixture({ threadIds });
  return { actor, owner, agentId: agent.agentId, orgId, threadIds };
}

/** Projects one dormant B1 closure and retires it with the test. */
function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
}

/** Unread thread ids as a set: the unread listing owns its own ordering. */
async function unreadThreadIds(
  fixture: AgentReadFixture,
): Promise<ReadonlySet<string>> {
  const unreads = await chat.listThreadUnreads(fixture.actor, fixture.agentId);
  return new Set(
    unreads.map((unread) => {
      return unread.threadId;
    }),
  );
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

describe("account erasure fences the bulk Agent read-cursor write", () => {
  it("denies the bulk write for the closed actor, the closed distinct Agent owner and the closed organization", async () => {
    const fixture = await createAgentReadFixture(2);
    const unrelated = await createAgentReadFixture(1);
    const before = await readChatThreadCursorsFixture(fixture.threadIds);

    for (const subject of [
      { subjectKind: "user", subjectId: fixture.actor.userId },
      { subjectKind: "user", subjectId: fixture.owner.userId },
      { subjectKind: "organization", subjectId: fixture.orgId },
    ] satisfies readonly ErasureSubject[]) {
      const closed = await closeErasureSubjectFixture(subject);
      clearPublishedNotifications();
      const denied = await chat.requestMarkAgentThreadsRead(
        fixture.actor,
        fixture.agentId,
        [204, 403],
      );
      expect(denied.status).toBe(403);
      if (denied.status === 403) {
        // Generic: it names no subject, no owner and no reason.
        expect(denied.body.error.message).toBe(
          "Chat read state is unavailable",
        );
        expect(JSON.stringify(denied.body)).not.toContain(subject.subjectId);
      }
      expect(publishedReadCursorPayloads()).toStrictEqual([]);
      await expect(
        readChatThreadCursorsFixture(fixture.threadIds),
      ).resolves.toStrictEqual(before);
      await removeErasureSubjectsFixture([closed.jobId]);
    }

    // An unrelated owner keeps working, and normal shared-Agent use is allowed
    // again once no subject is closed: the caller never owns this Agent.
    await chat.markAgentThreadsRead(unrelated.actor, unrelated.agentId);
    await expect(unreadThreadIds(unrelated)).resolves.toStrictEqual(new Set());
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });

  it("denies an admitted Agent with no unread threads instead of reporting a successful no-op", async () => {
    const fixture = await createAgentReadFixture(1);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
    const before = await readChatThreadCursorsFixture(fixture.threadIds);

    await closeSubject({
      subjectKind: "user",
      subjectId: fixture.owner.userId,
    });
    clearPublishedNotifications();

    await chat.requestMarkAgentThreadsRead(
      fixture.actor,
      fixture.agentId,
      [403],
    );
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(before);
  });

  it("keeps the existing 204 for a missing Agent and for another organization's Agent, even when the caller is closed", async () => {
    const fixture = await createAgentReadFixture(1);
    const other = await createAgentReadFixture(1);
    await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    const before = await readChatThreadCursorsFixture([
      ...fixture.threadIds,
      ...other.threadIds,
    ]);
    clearPublishedNotifications();

    // Resolved before admission: neither reveals that a subject is closed, and
    // neither takes another account's subject locks.
    await chat.requestMarkAgentThreadsRead(fixture.actor, randomUUID(), [204]);
    await chat.requestMarkAgentThreadsRead(fixture.actor, other.agentId, [204]);

    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture([...fixture.threadIds, ...other.threadIds]),
    ).resolves.toStrictEqual(before);
  });

  it("makes a closure wait for an admitted bulk write, commits every matched row, then denies the next attempt", async () => {
    const fixture = await createAgentReadFixture(3);
    const unrelated = await createAgentReadFixture(1);

    const closed = await withChatThreadAgentReadBarrierFixture(
      {
        agentId: fixture.agentId,
        stopAt: "commit",
        work: async (barrier) => {
          const marking = chat.markAgentThreadsRead(
            fixture.actor,
            fixture.agentId,
          );
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          // The admitted write holds its shared subject barrier with every
          // matched cursor already written, so the exclusive closure cannot
          // commit ahead of it.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          // An unrelated owner is not serialized behind that barrier.
          await chat.markAgentThreadsRead(unrelated.actor, unrelated.agentId);
          await expect(unreadThreadIds(unrelated)).resolves.toStrictEqual(
            new Set(),
          );

          barrier.release();
          await marking;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    // Every matched row committed coherently, not a partial page.
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
    const committed = await readChatThreadCursorsFixture(fixture.threadIds);
    expect(
      [...committed.values()].filter((cursor) => {
        return cursor === null;
      }),
    ).toHaveLength(0);

    await appendTerminalChatEventsFixture({ threadIds: fixture.threadIds });
    await chat.requestMarkAgentThreadsRead(
      fixture.actor,
      fixture.agentId,
      [403],
    );
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(committed);
  });

  it("re-resolves an Agent transferred under the locks instead of writing cursors under a stale owner", async () => {
    const fixture = await createAgentReadFixture(2);
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });
    const before = await readChatThreadCursorsFixture(fixture.threadIds);
    clearPublishedNotifications();

    await withChatThreadAgentReadBarrierFixture(
      {
        agentId: fixture.agentId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const marking = chat.requestMarkAgentThreadsRead(
            fixture.actor,
            fixture.agentId,
            [403],
          );
          await barrier.entered;
          await transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: newOwner,
          });
          barrier.release();
          await marking;
        },
      },
      context.signal,
    );

    // The retry admitted the newly resolved owner rather than writing under the
    // owner selected before the lock.
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(before);
  });

  it("propagates a held Agent identity lock as a failure rather than a closure denial or a success", async () => {
    const fixture = await createAgentReadFixture(2);
    const before = await readChatThreadCursorsFixture(fixture.threadIds);
    clearPublishedNotifications();

    const holder = await holdAgentRowLockFixture({
      agentId: fixture.agentId,
      signal: context.signal,
    });
    await expect(
      chat.requestMarkAgentThreadsRead(
        fixture.actor,
        fixture.agentId,
        [204, 403],
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(before);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });

  it("rolls every cursor back when the bulk write fails after some rows would update", async () => {
    const fixture = await createAgentReadFixture(4);
    const before = await readChatThreadCursorsFixture(fixture.threadIds);
    const blockedThreadId = fixture.threadIds.at(-1);
    if (blockedThreadId === undefined) {
      throw new Error("Expected a seeded thread to block");
    }
    clearPublishedNotifications();

    const holder = await holdChatThreadRowLockFixture({
      threadId: blockedThreadId,
      signal: context.signal,
    });
    // The single statement updates every matching row, so it blocks on the held
    // row only after the other rows would have been updated. A real failure is
    // neither a 204 nor the closure 403.
    await expect(
      chat.requestMarkAgentThreadsRead(
        fixture.actor,
        fixture.agentId,
        [204, 403],
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(before);

    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });
});

describe("bulk Agent read-cursor notifications stay bounded", () => {
  it("updates every eligible row and bounds the payload at 0, 1, 100, 101 and 129 unread threads", async () => {
    const fixture = await createAgentReadFixture(
      NOTIFIED_THREAD_ID_BUDGET + 29,
    );
    const other = await createAgentReadFixture(1);

    // Every seeded thread is unread, and marking once moves all of them.
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const overflow = publishedReadCursorPayloads();
    expect(overflow).toStrictEqual([
      { agentId: fixture.agentId, threadIds: [], scope: "agent" },
    ]);
    expect(JSON.stringify(overflow[0]).length).toBeLessThan(4096);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());

    // A genuine no-op publishes nothing and stays idempotent.
    clearPublishedNotifications();
    const marked = await readChatThreadCursorsFixture(fixture.threadIds);
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(marked);

    // Exactly one unread thread publishes its exact id.
    const single = fixture.threadIds.slice(0, 1);
    await appendTerminalChatEventsFixture({ threadIds: single });
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([
      { agentId: fixture.agentId, threadIds: single },
    ]);

    // The budget itself still publishes the exact list, in a bounded payload.
    const atBudget = fixture.threadIds.slice(0, NOTIFIED_THREAD_ID_BUDGET);
    await appendTerminalChatEventsFixture({ threadIds: atBudget });
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    const exact = publishedReadCursorPayloads();
    expect(exact).toHaveLength(1);
    expect(exact[0]).toStrictEqual({
      agentId: fixture.agentId,
      threadIds: expect.arrayContaining([...atBudget]),
    });
    expect(JSON.stringify(exact[0]).length).toBeLessThan(4096);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());

    // One more than the budget overflows, and still moves every cursor.
    const pastBudget = fixture.threadIds.slice(
      0,
      NOTIFIED_THREAD_ID_BUDGET + 1,
    );
    await appendTerminalChatEventsFixture({ threadIds: pastBudget });
    clearPublishedNotifications();
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    expect(publishedReadCursorPayloads()).toStrictEqual([
      { agentId: fixture.agentId, threadIds: [], scope: "agent" },
    ]);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());

    // Another user's threads under their own Agent are untouched throughout.
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
