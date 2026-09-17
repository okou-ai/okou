import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";
import { testChatThreadSnapshotCompactionContract } from "@okouai/api-contracts/contracts/test-chat-thread-snapshot-compaction";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdChatThreadEventIdFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { testChatThreadSnapshotCompactionRoutes } from "../test-chat-thread-snapshot-compaction";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

interface PinFixture {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly threadId: string;
  readonly orgId: string;
}

async function createPinFixture(): Promise<PinFixture> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Pinned ${randomUUID()}`,
  });
  const { orgId } = actor;
  if (orgId === null) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  return { actor, agentId: agent.agentId, threadId: thread.id, orgId };
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

interface SidebarPinEvent {
  readonly seqId: number;
  readonly kind: string;
  readonly pinOrder: string | null;
}

function isPinEventKind(kind: string): boolean {
  return kind === "pinned" || kind === "unpinned" || kind === "sort_touched";
}

/** The thread's own durable pin events, as a sidebar client reads them. */
async function sidebarPinEvents(
  fixture: PinFixture,
): Promise<readonly SidebarPinEvent[]> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events
    .filter((event) => {
      return (
        isPinEventKind(event.kind) && event.chatThreadId === fixture.threadId
      );
    })
    .map((event) => {
      // An absent key and a null rank both mean "no client rank".
      return {
        seqId: event.seqId,
        kind: event.kind,
        pinOrder: event.pinOrder ?? null,
      };
    });
}

async function lastPinSeqId(fixture: PinFixture): Promise<number> {
  const events = await sidebarPinEvents(fixture);
  const seqId = events.at(-1)?.seqId;
  if (seqId === undefined) {
    throw new Error("Expected at least one durable pin event");
  }
  return seqId;
}

/** The pin timestamp a production metadata reader returns. */
async function readPinnedAt(fixture: PinFixture): Promise<string | null> {
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  return metadata.pinnedAt;
}

/** SQL snapshots omit the timezone suffix; those timestamps are still UTC. */
function pinnedAtMs(pinnedAt: string | null): number | null {
  if (pinnedAt === null) {
    return null;
  }
  return Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(pinnedAt) ? pinnedAt : `${pinnedAt}Z`,
  );
}

/**
 * The persisted `chat_threads` pin columns, read through the snapshot the
 * compaction projector builds from those columns. Compaction consumes the
 * events it folds in, so a test reads this only after its event assertions.
 */
async function compactedPinState(fixture: PinFixture): Promise<{
  readonly pinnedAtMs: number | null;
  readonly pinOrder: string | null;
}> {
  const compaction = setupApp({
    context,
    routes: testChatThreadSnapshotCompactionRoutes,
  })(testChatThreadSnapshotCompactionContract);
  await accept(
    compaction.compact({
      body: {
        scopes: [{ user_id: fixture.actor.userId, org_id: fixture.orgId }],
      },
    }),
    [200],
  );
  const snapshot = await chat.getThreadSnapshot(fixture.actor);
  const projected = snapshot.chatThreads.find((thread) => {
    return thread.id === fixture.threadId;
  });
  if (!projected) {
    throw new Error("Expected the thread in the compacted snapshot");
  }
  return {
    pinnedAtMs: pinnedAtMs(projected.pinnedAt),
    pinOrder: projected.pinOrder ?? null,
  };
}

describe("account erasure fences chat-thread pin mutations", () => {
  it("denies pin, unpin and reorder for a closed thread user and keeps the persisted pin state", async () => {
    const fixture = await createPinFixture();
    await chat.pinThread(fixture.actor, fixture.threadId, {
      pinOrder: "a0",
      eventId: randomUUID(),
    });
    const before = await sidebarPinEvents(fixture);
    const pinnedAt = await readPinnedAt(fixture);
    expect(
      before.map((event) => {
        return event.kind;
      }),
    ).toStrictEqual(["pinned"]);
    expect(pinnedAt).not.toBeNull();

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });

    await chat.requestPinThread(fixture.actor, fixture.threadId, [404], {
      pinOrder: "a5",
      eventId: randomUUID(),
    });
    await chat.requestUnpinThread(fixture.actor, fixture.threadId, [404], {
      eventId: randomUUID(),
    });
    await chat.requestReorderPinnedThread(
      fixture.actor,
      fixture.threadId,
      { pinOrder: "a5", eventId: randomUUID() },
      [404],
    );

    await expect(readPinnedAt(fixture)).resolves.toBe(pinnedAt);
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual(before);

    // The three denied attempts left the durable sequence untouched, so the
    // next accepted reorder takes the very next sidebar sequence id.
    await removeErasureSubjectsFixture([closed.jobId]);
    await chat.reorderPinnedThread(fixture.actor, fixture.threadId, {
      pinOrder: "a1",
      eventId: randomUUID(),
    });
    const after = await sidebarPinEvents(fixture);
    expect(
      after.map((event) => {
        return event.kind;
      }),
    ).toStrictEqual(["pinned", "sort_touched"]);
    expect(after.at(-1)?.seqId).toBe((before.at(-1)?.seqId ?? 0) + 1);

    await expect(compactedPinState(fixture)).resolves.toStrictEqual({
      pinnedAtMs: pinnedAtMs(pinnedAt),
      pinOrder: "a1",
    });
  });

  it("denies the three pin writes for a closed distinct Agent owner", async () => {
    const fixture = await createPinFixture();
    await chat.pinThread(fixture.actor, fixture.threadId, { pinOrder: "a0" });
    const before = await sidebarPinEvents(fixture);
    const pinnedAt = await readPinnedAt(fixture);

    const sharedOwner = `user_${randomUUID()}`;
    await transferAgentOwnerFixture({
      agentId: fixture.agentId,
      owner: sharedOwner,
    });
    await closeSubject({ subjectKind: "user", subjectId: sharedOwner });

    await chat.requestPinThread(fixture.actor, fixture.threadId, [404], {
      pinOrder: "a5",
    });
    await chat.requestUnpinThread(fixture.actor, fixture.threadId, [404]);
    await chat.requestReorderPinnedThread(
      fixture.actor,
      fixture.threadId,
      { pinOrder: "a5", eventId: randomUUID() },
      [404],
    );

    await expect(readPinnedAt(fixture)).resolves.toBe(pinnedAt);
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual(before);
    await expect(compactedPinState(fixture)).resolves.toStrictEqual({
      pinnedAtMs: pinnedAtMs(pinnedAt),
      pinOrder: "a0",
    });
  });

  it("denies the three pin writes for a closed organization", async () => {
    const fixture = await createPinFixture();
    await chat.pinThread(fixture.actor, fixture.threadId, { pinOrder: "a0" });
    const before = await sidebarPinEvents(fixture);
    const pinnedAt = await readPinnedAt(fixture);

    await closeSubject({
      subjectKind: "organization",
      subjectId: fixture.orgId,
    });

    await chat.requestPinThread(fixture.actor, fixture.threadId, [404], {
      pinOrder: "a5",
    });
    await chat.requestUnpinThread(fixture.actor, fixture.threadId, [404]);
    await chat.requestReorderPinnedThread(
      fixture.actor,
      fixture.threadId,
      { pinOrder: "a5", eventId: randomUUID() },
      [404],
    );

    await expect(readPinnedAt(fixture)).resolves.toBe(pinnedAt);
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual(before);
    await expect(compactedPinState(fixture)).resolves.toStrictEqual({
      pinnedAtMs: pinnedAtMs(pinnedAt),
      pinOrder: "a0",
    });
  });

  it("keeps an unrelated owner pinning while another subject is closed", async () => {
    const closed = await createPinFixture();
    const unrelated = await createPinFixture();
    await closeSubject({ subjectKind: "user", subjectId: closed.actor.userId });

    await chat.requestPinThread(closed.actor, closed.threadId, [404]);
    await expect(readPinnedAt(closed)).resolves.toBeNull();

    await chat.pinThread(unrelated.actor, unrelated.threadId, {
      pinOrder: "a0",
    });
    await expect(readPinnedAt(unrelated)).resolves.not.toBeNull();
    await expect(compactedPinState(unrelated)).resolves.toStrictEqual({
      pinnedAtMs: expect.any(Number),
      pinOrder: "a0",
    });
  });

  it("makes a closure wait for an admitted pin while an unrelated owner keeps writing", async () => {
    const fixture = await createPinFixture();
    const unrelated = await createPinFixture();

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const pinning = chat.pinThread(fixture.actor, fixture.threadId, {
            pinOrder: "a0",
          });
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          // The admitted pin holds its shared subject barrier with the pin
          // columns, the durable sequence and the `pinned` event already
          // written, so the exclusive closure cannot commit ahead of it.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          // An unrelated owner is not serialized behind that barrier.
          await chat.pinThread(unrelated.actor, unrelated.threadId, {
            pinOrder: "a1",
          });
          await expect(readPinnedAt(unrelated)).resolves.not.toBeNull();

          barrier.release();
          await pinning;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    const pinnedAt = await readPinnedAt(fixture);
    expect(pinnedAt).not.toBeNull();
    const admitted = await sidebarPinEvents(fixture);
    expect(
      admitted.map((event) => {
        return event.kind;
      }),
    ).toStrictEqual(["pinned"]);

    // The closure landed behind the admitted write, so the next pin mutation
    // is rejected and changes nothing.
    await chat.requestUnpinThread(fixture.actor, fixture.threadId, [404]);
    await expect(readPinnedAt(fixture)).resolves.toBe(pinnedAt);
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual(admitted);
  });

  it("re-resolves a transferred Agent owner under the locks instead of pinning under a stale label", async () => {
    const fixture = await createPinFixture();
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const pinning = chat.requestPinThread(
            fixture.actor,
            fixture.threadId,
            [404],
            { pinOrder: "a0" },
          );
          await barrier.entered;
          await transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: newOwner,
          });
          barrier.release();
          await pinning;
        },
      },
      context.signal,
    );

    await expect(readPinnedAt(fixture)).resolves.toBeNull();
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("finds a thread deleted under the locks and recreates no pin event", async () => {
    const fixture = await createPinFixture();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const pinning = chat.requestPinThread(
            fixture.actor,
            fixture.threadId,
            [404],
            { pinOrder: "a0" },
          );
          await barrier.entered;
          await chat.deleteThread(fixture.actor, fixture.threadId);
          barrier.release();
          await pinning;
        },
      },
      context.signal,
    );

    await chat.requestReadThread(fixture.actor, fixture.threadId, [404]);
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("rolls the pin columns, sidebar event and sequence back when the pin fails after writing them", async () => {
    const fixture = await createPinFixture();
    await chat.pinThread(fixture.actor, fixture.threadId, { pinOrder: "a0" });
    const before = await sidebarPinEvents(fixture);
    const pinnedAt = await readPinnedAt(fixture);
    const lastSeqId = await lastPinSeqId(fixture);

    const eventId = randomUUID();
    const holder = await holdChatThreadEventIdFixture({
      eventId,
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
      chatThreadId: fixture.threadId,
      signal: context.signal,
    });
    // The pin writes both pin columns and reserves the durable sequence, then
    // its last statement blocks on the held event id and fails on its own
    // bounded budget. A genuine transaction failure is neither a 204 nor the
    // closure 404.
    await expect(
      chat.requestPinThread(fixture.actor, fixture.threadId, [204, 404], {
        pinOrder: "a5",
        eventId,
      }),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    await expect(readPinnedAt(fixture)).resolves.toBe(pinnedAt);
    await expect(sidebarPinEvents(fixture)).resolves.toStrictEqual(before);

    // No sidebar sequence was consumed and no invalidation escaped: the next
    // accepted reorder still takes the very next sequence id.
    await chat.reorderPinnedThread(fixture.actor, fixture.threadId, {
      pinOrder: "a1",
      eventId: randomUUID(),
    });
    await expect(lastPinSeqId(fixture)).resolves.toBe(lastSeqId + 1);
    await expect(compactedPinState(fixture)).resolves.toStrictEqual({
      pinnedAtMs: pinnedAtMs(pinnedAt),
      pinOrder: "a1",
    });
  });

  it("propagates a held parent lock as a failure rather than a closure 404", async () => {
    const fixture = await createPinFixture();
    await chat.pinThread(fixture.actor, fixture.threadId, { pinOrder: "a0" });
    const pinnedAt = await readPinnedAt(fixture);

    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    // Neither an accepted 204 nor the closure 404: a real blocked parent lock
    // keeps its own database failure instead of being reported as erasure.
    await expect(
      chat.requestUnpinThread(fixture.actor, fixture.threadId, [204, 404]),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    await expect(readPinnedAt(fixture)).resolves.toBe(pinnedAt);
    await chat.unpinThread(fixture.actor, fixture.threadId);
    await expect(readPinnedAt(fixture)).resolves.toBeNull();
  });
});
