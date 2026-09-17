import { randomUUID } from "node:crypto";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOrganizationFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  appendTerminalChatEventsFixture,
  holdAgentRowLockFixture,
  readChatThreadCursorsFixture,
  withChatThreadAgentReadBarrierFixture,
} from "../../../test-fixtures/chat-thread-agent-read-erasure";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

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
  // Bound same-actor requests and drain them before propagating errors or
  // changing identities, without flooding the pool or event sequence row lock.
  const batchSize = 4;
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

const readCursorPayloadAgentSchema = z.object({ agentId: z.string() });
const readCursorPayloadThreadIdsSchema = z.object({
  threadIds: z.array(z.string()),
});

/**
 * The payloads published for one Agent since the last clear. Every user-org
 * channel shares one publish mock, so an assertion about the Agent under test
 * has to name it: an unrelated owner making independent progress in the same
 * window publishes their own invalidation on their own channel.
 */
function publishedReadCursorPayloadsFor(agentId: string): readonly unknown[] {
  return publishedReadCursorPayloads().filter((payload) => {
    const parsed = readCursorPayloadAgentSchema.safeParse(payload);
    return parsed.success && parsed.data.agentId === agentId;
  });
}

/** The exact ids one published payload carries, order-independent. */
function publishedThreadIds(payload: unknown): ReadonlySet<string> {
  return new Set(readCursorPayloadThreadIdsSchema.parse(payload).threadIds);
}

/** The channels resolved for a publication since the last clear. The route
 * targets exactly the caller's own user-org channel. */
function notifiedChannels(): readonly string[] {
  return context.mocks.ably.channelGet.mock.calls.map((call) => {
    return call[0];
  });
}

function readCursorChannel(fixture: AgentReadFixture): string {
  return `user-org:${fixture.actor.userId}:${fixture.orgId}`;
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

  it("makes a closure wait for an admitted bulk write, publishes nothing before its commit, then denies the next attempt", async () => {
    const fixture = await createAgentReadFixture(3);
    const unrelated = await createAgentReadFixture(1);
    const before = await readChatThreadCursorsFixture(fixture.threadIds);
    clearPublishedNotifications();

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

          // The paused transaction has written every matched cursor and has
          // not sent its COMMIT, so nothing outside it observes the new read
          // state and no invalidation has been published for this Agent, even
          // though the unrelated owner just published their own.
          await expect(
            readChatThreadCursorsFixture(fixture.threadIds),
          ).resolves.toStrictEqual(before);
          await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
            new Set(fixture.threadIds),
          );
          expect(publishedReadCursorPayloadsFor(fixture.agentId)).toStrictEqual(
            [],
          );
          expect(notifiedChannels()).not.toContain(readCursorChannel(fixture));
          expect(
            publishedReadCursorPayloadsFor(unrelated.agentId),
          ).toHaveLength(1);

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

    // Exactly one invalidation for this Agent, on this caller's own user-org
    // channel, naming exactly the ids that committed.
    const published = publishedReadCursorPayloadsFor(fixture.agentId);
    expect(published).toStrictEqual([
      {
        agentId: fixture.agentId,
        threadIds: expect.arrayContaining([...fixture.threadIds]),
      },
    ]);
    expect(publishedThreadIds(published[0])).toStrictEqual(
      new Set(fixture.threadIds),
    );
    expect(notifiedChannels()).toContain(readCursorChannel(fixture));

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

  it("leaves every cursor unchanged when the bulk write cannot take a matched row's lock", async () => {
    const fixture = await createAgentReadFixture(4);
    const before = await readChatThreadCursorsFixture(fixture.threadIds);
    const blockedThreadId = fixture.threadIds.at(-1);
    if (blockedThreadId === undefined) {
      throw new Error("Expected a seeded thread to block");
    }
    clearPublishedNotifications();

    // One statement updates every matching row, and an exclusive holder on any
    // one of them makes it wait and then fail. SQL fixes no visit order, so
    // this proves the atomic failure outcome — a real failure is neither a 204
    // nor the closure 403, and no cursor moves — not that a different row had
    // already been written. The cancellation case below supplies that.
    const holder = await holdChatThreadRowLockFixture({
      threadId: blockedThreadId,
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

  it("rolls every executed cursor write back when the operation is cancelled after the bulk UPDATE", async () => {
    // Past the notification budget, so the rolled-back write is the overflow
    // shape as well as a multi-row one.
    const fixture = await createAgentReadFixture(NOTIFIED_THREAD_ID_BUDGET + 1);
    const before = await readChatThreadCursorsFixture(fixture.threadIds);
    const controller = new AbortController();
    // The operation signal `honoSignalHandler` hands this route's command, which
    // is the signal the admission helper checks. A `fetchOptions` signal would
    // only abandon the client's own promise and could not reach the database.
    const cancellable = chat.readCursorWritesWithOperationSignal(
      controller.signal,
    );
    clearPublishedNotifications();

    await withChatThreadAgentReadBarrierFixture(
      {
        agentId: fixture.agentId,
        // PostgreSQL has executed the bulk statement and its result has not yet
        // resumed the helper's last in-transaction check, so no COMMIT has been
        // sent. This is the only boundary where cancelling proves rollback of
        // work the database really performed.
        stopAt: "update-result",
        work: async (barrier) => {
          const marking = cancellable.markAgentRead(
            fixture.actor,
            fixture.agentId,
          );
          const entered = await barrier.entered;
          // The statement itself reported its returned ids, so this is not a
          // pre-write lock timeout, and no other caller can see the new state.
          expect(entered.rowCount).toBe(NOTIFIED_THREAD_ID_BUDGET + 1);
          await expect(
            readChatThreadCursorsFixture(fixture.threadIds),
          ).resolves.toStrictEqual(before);

          controller.abort(new DOMException("Operation ended", "AbortError"));
          barrier.release();
          await expect(marking).rejects.toThrow(/Unknown response status 500/);
        },
      },
      context.signal,
    );

    // The cancelled operation is a failure, never the existing 204 and never
    // the closure 403, every executed row write is gone, and nothing was
    // published.
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(before);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(
      new Set(fixture.threadIds),
    );

    // A rolled back attempt is not a durable denial: the same request commits
    // the whole set once its operation is no longer cancelled.
    await chat.markAgentThreadsRead(fixture.actor, fixture.agentId);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
  });

  it("keeps every committed cursor when the operation is cancelled after COMMIT, publishing nothing", async () => {
    const fixture = await createAgentReadFixture(2);
    const controller = new AbortController();
    const cancellable = chat.readCursorWritesWithOperationSignal(
      controller.signal,
    );
    clearPublishedNotifications();

    await withChatThreadAgentReadBarrierFixture(
      {
        agentId: fixture.agentId,
        stopAt: "commit",
        work: async (barrier) => {
          const marking = cancellable.markAgentRead(
            fixture.actor,
            fixture.agentId,
          );
          await barrier.entered;
          // Already past the transaction's post-write abort check, so releasing
          // sends a COMMIT that succeeds. This is a race the caller loses, not
          // a rollback, and the case exists so the boundary above is never read
          // as a promise that any late cancellation undoes a write.
          controller.abort(new DOMException("Operation ended", "AbortError"));
          barrier.release();
          await expect(marking).rejects.toThrow(/Unknown response status 500/);
        },
      },
      context.signal,
    );

    // The cursors are committed and stay committed; only the notification,
    // which runs after the transaction, is lost with the cancelled operation.
    const committed = await readChatThreadCursorsFixture(fixture.threadIds);
    expect(
      [...committed.values()].filter((cursor) => {
        return cursor === null;
      }),
    ).toHaveLength(0);
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
  });

  it("keeps the existing 204 when the Agent is deleted between selection and its retained lock", async () => {
    const fixture = await createAgentReadFixture(2);
    const unrelated = await createAgentReadFixture(1);
    clearPublishedNotifications();

    await withChatThreadAgentReadBarrierFixture(
      {
        agentId: fixture.agentId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const marking = chat.requestMarkAgentThreadsRead(
            fixture.actor,
            fixture.agentId,
            [204],
          );
          await barrier.entered;
          // The canonical product boundary: the Agent's owner deletes it, and
          // the matched threads go with it.
          await bdd.deleteAgent(fixture.owner, fixture.agentId);
          barrier.release();
          await marking;
        },
      },
      context.signal,
    );

    // Revalidation under the retained lock finds no identity, so the write is
    // the preserved missing 204: no cursor is resurrected for the deleted
    // Agent, no identity it never admitted is written under, and nothing is
    // published.
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(new Map());
    await expect(unreadThreadIds(fixture)).resolves.toStrictEqual(new Set());
    await chat.requestMarkAgentThreadsRead(
      fixture.actor,
      fixture.agentId,
      [204],
    );
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(new Map());

    // The unrelated owner keeps their own unread state and can still commit it.
    await expect(unreadThreadIds(unrelated)).resolves.toStrictEqual(
      new Set(unrelated.threadIds),
    );
    await chat.markAgentThreadsRead(unrelated.actor, unrelated.agentId);
    await expect(unreadThreadIds(unrelated)).resolves.toStrictEqual(new Set());
  });

  it("returns the existing 204 for an Agent moved to another organization under the locks", async () => {
    const fixture = await createAgentReadFixture(2);
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
            [204],
          );
          await barrier.entered;
          await transferAgentOrganizationFixture({
            agentId: fixture.agentId,
            orgId: `org_${randomUUID()}`,
          });
          barrier.release();
          await marking;
        },
      },
      context.signal,
    );

    // The same reselection the owner transfer takes, with this route's other
    // disposition: the caller's organization no longer authorizes the Agent, so
    // it reads as absent and no cursor moves under the stale organization.
    expect(publishedReadCursorPayloads()).toStrictEqual([]);
    await expect(
      readChatThreadCursorsFixture(fixture.threadIds),
    ).resolves.toStrictEqual(before);
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
