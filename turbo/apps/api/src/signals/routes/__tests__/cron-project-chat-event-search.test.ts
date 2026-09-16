import { randomUUID } from "node:crypto";

import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  insertOrphanedChatEventSearchProjectionFixture,
  insertChatSearchProjectionCoverageFixture,
  insertSearchablePromptFixture,
  readChatEventSearchProjectionFixture,
  readChatEventSearchProjectionRowsFixture,
  removeChatEventSearchProjectionRowsFixture,
  rejectSearchablePromptFixture,
  writeChatEventSearchProjectionFixture,
} from "../../../test-fixtures/chat-event-search";
import {
  holdChatEventSearchWatermarkRowLockFixture,
  holdChatEventInsertTransactionFixture,
  holdChatThreadDeleteTransactionFixture,
  holdChatThreadRowLockFixture,
} from "../../../test-fixtures/chat-events";
import {
  chatSearchBarrierBlockedWaiterCountFixture,
  closeChatSearchErasureSubjectFixture,
  holdChatSearchAgentRowLockFixture,
  holdChatSearchErasureClosureFixture,
  removeChatSearchErasureSubjectsFixture,
  transferChatSearchThreadFixture,
  withChatSearchProjectionCommitBarrierFixture,
} from "../../../test-fixtures/chat-search-erasure";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const CRON_SECRET = "durable-chat-search-projection-secret";
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

function cronClient() {
  mockEnv("CRON_SECRET", CRON_SECRET);
  return setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
}

async function projectOwnedChatEventSearch(chatThreadIds: readonly string[]) {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  const response = await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
  return response.body;
}

interface ProjectionFixture {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly threadId: string;
}

async function createProjectionFixture(
  options: { readonly orgId?: string } = {},
): Promise<ProjectionFixture> {
  const actor =
    options.orgId === undefined
      ? bdd.user()
      : bdd.user({ orgId: options.orgId });
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Projection ${randomUUID()}`,
  });
  return { actor, agentId: agent.agentId, threadId: thread.id };
}

async function createProjectionThread(): Promise<string> {
  const fixture = await createProjectionFixture();
  return fixture.threadId;
}

async function seedProjectionContent(
  chatThreadId: string,
  marker: string,
): Promise<void> {
  await insertChatSearchProjectionCoverageFixture({
    chatThreadId,
    promptText: `${marker} prompt`,
    assistantText: `${marker} assistant`,
    errorText: `${marker} error`,
    terminalText: `${marker} terminal`,
  });
}

function closeSubject(subject: {
  readonly subjectKind: "user" | "organization";
  readonly subjectId: string;
}): Promise<{ readonly jobId: string }> {
  const closing = closeChatSearchErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeChatSearchErasureSubjectsFixture([jobId]);
  });
  return closing;
}

async function expectNoProjection(chatThreadId: string): Promise<void> {
  await expect(
    readChatEventSearchProjectionRowsFixture(chatThreadId),
  ).resolves.toStrictEqual({ indexedSeqId: null, messages: [] });
}

describe("GET /api/cron/project-chat-event-search", () => {
  it("projects only non-empty visible user and assistant messages", async () => {
    const chatThreadId = await createProjectionThread();
    const promptText = `durable prompt ${randomUUID()}`;
    const assistantText = `durable assistant ${randomUUID()}`;
    const errorText = `excluded error ${randomUUID()}`;
    const terminalText = `excluded terminal ${randomUUID()}`;
    const { assistantRunId } = await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText,
      assistantText,
      errorText,
      terminalText,
    });

    const tick = await projectOwnedChatEventSearch([chatThreadId]);
    expect(tick.success).toBeTruthy();
    expect(tick.threads).toBe(1);
    expect(tick.indexedEvents).toBe(2);
    expect(tick.convergence.eligibleThreads).toBe(1);
    expect(tick.convergence.durableCaughtUpThreads).toBe(1);

    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(projection.messages).toStrictEqual([
      {
        seqId: expect.any(Number),
        runId: null,
        role: "user",
        text: promptText,
      },
      {
        seqId: expect.any(Number),
        runId: assistantRunId,
        role: "assistant",
        text: assistantText,
      },
    ]);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().project({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("keeps overlapping projection ticks idempotent", async () => {
    const chatThreadId = await createProjectionThread();
    const assistantText = `overlap assistant ${randomUUID()}`;
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText: `overlap prompt ${randomUUID()}`,
      assistantText,
      errorText: `overlap error ${randomUUID()}`,
      terminalText: `overlap terminal ${randomUUID()}`,
    });

    const ticks = await Promise.all([
      projectOwnedChatEventSearch([chatThreadId]),
      projectOwnedChatEventSearch([chatThreadId]),
    ]);

    expect(
      ticks.reduce((total, tick) => {
        return total + tick.indexedEvents;
      }, 0),
    ).toBe(2);
    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
    expect(
      projection.messages.filter((message) => {
        return message.text === assistantText;
      }),
    ).toHaveLength(1);
  });

  it("does not take a thread lock that conflicts with event writes", async () => {
    const chatThreadId = await createProjectionThread();
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText: `nonblocking prompt ${randomUUID()}`,
      assistantText: `nonblocking assistant ${randomUUID()}`,
      errorText: `nonblocking error ${randomUUID()}`,
      terminalText: `nonblocking terminal ${randomUUID()}`,
    });
    const appendedText = `writer remains live ${randomUUID()}`;
    const heldWriter = await holdChatEventInsertTransactionFixture({
      threadId: chatThreadId,
      content: appendedText,
      signal: context.signal,
    });
    const firstTick = projectOwnedChatEventSearch([chatThreadId]);
    onTestFinished(async () => {
      heldWriter.release();
      await Promise.allSettled([heldWriter.done, firstTick]);
    });

    const projected = await firstTick;
    expect(projected.indexedEvents).toBe(2);

    heldWriter.release();
    await heldWriter.done;
    const caughtUp = await projectOwnedChatEventSearch([chatThreadId]);
    expect(caughtUp.indexedEvents).toBe(1);
    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
    expect(projection.messages).toContainEqual(
      expect.objectContaining({
        seqId: heldWriter.event.seqId,
        role: "assistant",
        text: appendedText,
      }),
    );
  });

  it("defers a thread while an in-flight deletion holds its canonical parent", async () => {
    const { actor, threadId } = await createProjectionFixture();
    const promptText = `deleting prompt ${randomUUID()}`;
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId: threadId,
      promptText,
      assistantText: `deleting assistant ${randomUUID()}`,
      errorText: `deleting error ${randomUUID()}`,
      terminalText: `deleting terminal ${randomUUID()}`,
    });
    const heldDeletion = await holdChatThreadDeleteTransactionFixture({
      threadId,
      signal: context.signal,
    });
    const tick = projectOwnedChatEventSearch([threadId]);
    onTestFinished(async () => {
      heldDeletion.release();
      await Promise.allSettled([heldDeletion.done, tick]);
    });

    // The projector's own identity lock is what waits, so the deletion never
    // races ahead of a projection that could recreate its rows.
    await expect
      .poll(heldDeletion.firstBlockedStatementKind, BLOCKED)
      .toBe("select_for_key_share");
    const projected = await tick;
    expect(projected.success).toBeTruthy();
    expect(projected.threads).toBe(0);
    expect(projected.indexedEvents).toBe(0);
    expect(projected.deferredThreads).toBe(1);
    expect(projected.closedThreads).toBe(0);
    await expectNoProjection(threadId);

    heldDeletion.release();
    await heldDeletion.done;

    const deleted = await chat.requestReadThread(actor, threadId, [404]);
    expect(deleted.status).toBe(404);
    const hidden = await chat.searchChat(actor, promptText);
    expect(hidden.results).toStrictEqual([]);

    // The deletion resolved with no derived rows to repair, and the next tick
    // cannot recreate a message or a watermark for the missing parent.
    const cleanup = await projectOwnedChatEventSearch([threadId]);
    expect(cleanup.orphanedThreads).toBe(0);
    expect(cleanup.deferredThreads).toBe(0);
    await expectNoProjection(threadId);
  });

  it("retries a thread deferred by a bounded identity lock wait", async () => {
    const { threadId } = await createProjectionFixture();
    const marker = `deferred ${randomUUID()}`;
    await seedProjectionContent(threadId, marker);
    const heldThread = await holdChatThreadRowLockFixture({
      threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      heldThread.release();
      await Promise.allSettled([heldThread.done]);
    });

    const deferred = await projectOwnedChatEventSearch([threadId]);
    expect(deferred.deferredThreads).toBe(1);
    expect(deferred.threads).toBe(0);
    expect(deferred.closedThreads).toBe(0);
    await expectNoProjection(threadId);

    heldThread.release();
    await heldThread.done;

    const retried = await projectOwnedChatEventSearch([threadId]);
    expect(retried.deferredThreads).toBe(0);
    expect(retried.threads).toBe(1);
    expect(retried.indexedEvents).toBe(2);
    const projection = await readChatEventSearchProjectionFixture(threadId);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
    expect(projection.messages).toHaveLength(2);
  });

  it("holds thread deletion until the projector transaction commits", async () => {
    const { actor, threadId } = await createProjectionFixture();
    const marker = `commitorder${randomUUID().replaceAll("-", "")}`;
    await seedProjectionContent(threadId, marker);

    const projected = await withChatSearchProjectionCommitBarrierFixture(
      {
        chatThreadId: threadId,
        work: async ({ entered, release }) => {
          const tick = projectOwnedChatEventSearch([threadId]);
          const barrier = await entered;
          // The per-thread budget is finite and visible on the real connection.
          expect(barrier.lockTimeout).toBe("1s");
          expect(barrier.statementTimeout).toBe("5s");
          const deleting = chat.deleteThread(actor, threadId);
          await expect
            .poll(() => {
              return chatSearchBarrierBlockedWaiterCountFixture(barrier.pid);
            }, BLOCKED)
            .toBeGreaterThan(0);
          release();
          const result = await tick;
          await deleting;
          return result;
        },
      },
      context.signal,
    );

    expect(projected.threads).toBe(1);
    expect(projected.indexedEvents).toBe(2);
    // The deletion waited, then removed both the messages and the watermark the
    // projector had just written.
    await expectNoProjection(threadId);
    const hidden = await chat.searchChat(actor, `${marker} prompt`);
    expect(hidden.results).toStrictEqual([]);
    const cleanup = await projectOwnedChatEventSearch([threadId]);
    expect(cleanup.orphanedThreads).toBe(0);
    expect(cleanup.threads).toBe(0);
    await expectNoProjection(threadId);
  });

  it("holds an account closure until the projector transaction commits", async () => {
    const { actor, threadId } = await createProjectionFixture();
    const marker = `closureorder${randomUUID().replaceAll("-", "")}`;
    await seedProjectionContent(threadId, marker);

    const projected = await withChatSearchProjectionCommitBarrierFixture(
      {
        chatThreadId: threadId,
        work: async ({ entered, release }) => {
          const tick = projectOwnedChatEventSearch([threadId]);
          const barrier = await entered;
          const closing = closeSubject({
            subjectKind: "user",
            subjectId: actor.userId,
          });
          await expect
            .poll(() => {
              return chatSearchBarrierBlockedWaiterCountFixture(barrier.pid);
            }, BLOCKED)
            .toBeGreaterThan(0);
          release();
          const result = await tick;
          await closing;
          return result;
        },
      },
      context.signal,
    );

    expect(projected.threads).toBe(1);
    expect(projected.indexedEvents).toBe(2);
    // The admitted transaction completed; already durable rows are historical
    // data for a later purge, not something this producer fence removes.
    const projection = await readChatEventSearchProjectionFixture(threadId);
    expect(projection.messages).toHaveLength(2);

    // After the closure commits the same thread stops producing new rows.
    await insertSearchablePromptFixture({
      chatThreadId: threadId,
      text: `${marker} after closure`,
    });
    const afterClosure = await projectOwnedChatEventSearch([threadId]);
    expect(afterClosure.threads).toBe(0);
    expect(afterClosure.indexedEvents).toBe(0);
    expect(afterClosure.convergence.eligibleThreads).toBe(0);
    const unchanged = await readChatEventSearchProjectionFixture(threadId);
    expect(unchanged.messages).toHaveLength(2);
    expect(unchanged.indexedSeqId).toBe(projection.indexedSeqId);
  });

  it("denies a closure committed after candidate selection", async () => {
    const { actor, threadId } = await createProjectionFixture();
    await seedProjectionContent(threadId, `lateclosure ${randomUUID()}`);
    const heldClosure = await holdChatSearchErasureClosureFixture({
      subject: { subjectKind: "user", subjectId: actor.userId },
      signal: context.signal,
    });
    const tick = projectOwnedChatEventSearch([threadId]);
    onTestFinished(async () => {
      await Promise.allSettled([heldClosure.release(), tick]);
    });

    // Selection cannot see the uncommitted job, so the thread is a candidate
    // and only the in-transaction admission can deny it.
    await expect
      .poll(heldClosure.blockedWaiterCount, BLOCKED)
      .toBeGreaterThan(0);
    await heldClosure.release();

    const denied = await tick;
    expect(denied.closedThreads).toBe(1);
    expect(denied.threads).toBe(0);
    expect(denied.indexedEvents).toBe(0);
    expect(denied.deferredThreads).toBe(0);
    await expectNoProjection(threadId);
  });

  it.each([
    ["thread user", "user"],
    ["organization", "organization"],
  ] as const)(
    "stops projecting a thread whose %s is closed while other owners progress",
    async (_label, subjectKind) => {
      const orgId = `org_${randomUUID()}`;
      const closed = await createProjectionFixture({ orgId });
      const surviving = await createProjectionFixture();
      const marker = `mixed${randomUUID().replaceAll("-", "")}`;
      await seedProjectionContent(closed.threadId, `${marker} closed`);
      await seedProjectionContent(surviving.threadId, `${marker} surviving`);
      await closeSubject(
        subjectKind === "user"
          ? { subjectKind, subjectId: closed.actor.userId }
          : { subjectKind, subjectId: orgId },
      );

      const tick = await projectOwnedChatEventSearch([
        closed.threadId,
        surviving.threadId,
      ]);
      expect(tick.threads).toBe(1);
      expect(tick.indexedEvents).toBe(2);
      // The closed thread leaves the eligible set instead of being reported as
      // outstanding work or silently counted as indexed.
      expect(tick.convergence).toStrictEqual({
        eligibleThreads: 1,
        durableCaughtUpThreads: 1,
      });

      await expectNoProjection(closed.threadId);
      const denied = await chat.searchChat(closed.actor, `${marker} closed`);
      expect(denied.results).toStrictEqual([]);

      const kept = await chat.searchChat(
        surviving.actor,
        `${marker} surviving`,
      );
      expect(
        kept.results.map((result) => {
          return result.chatThreadId;
        }),
      ).toStrictEqual([surviving.threadId, surviving.threadId]);
    },
  );

  it("stops projecting a thread whose distinct Agent owner is closed", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const member = bdd.user({ orgId });
    bdd.acceptAgentStorageWrites();
    const shared = await bdd.createAgent(owner, {
      displayName: `Shared search agent ${randomUUID().slice(0, 8)}`,
      visibility: "public",
    });
    const thread = await chat.createThread(member, {
      agentId: shared.agentId,
      title: `Shared projection ${randomUUID()}`,
    });
    const marker = `agentowner${randomUUID().replaceAll("-", "")}`;
    await seedProjectionContent(thread.id, marker);
    await closeSubject({ subjectKind: "user", subjectId: owner.userId });

    const tick = await projectOwnedChatEventSearch([thread.id]);
    expect(tick.threads).toBe(0);
    expect(tick.indexedEvents).toBe(0);
    expect(tick.convergence.eligibleThreads).toBe(0);
    await expectNoProjection(thread.id);
    // The thread user is a separate open subject and keeps every other thread.
    const denied = await chat.searchChat(member, `${marker} prompt`);
    expect(denied.results).toStrictEqual([]);
  });

  it("re-derives ownership after a transfer instead of reusing candidate labels", async () => {
    const orgId = `org_${randomUUID()}`;
    const previous = await createProjectionFixture({ orgId });
    const next = await createProjectionFixture({ orgId });
    const marker = `transfer${randomUUID().replaceAll("-", "")}`;
    await seedProjectionContent(previous.threadId, `${marker} original`);
    const first = await projectOwnedChatEventSearch([previous.threadId]);
    expect(first.threads).toBe(1);

    await insertSearchablePromptFixture({
      chatThreadId: previous.threadId,
      text: `${marker} transferred`,
    });
    await transferChatSearchThreadFixture({
      chatThreadId: previous.threadId,
      userId: next.actor.userId,
      agentId: next.agentId,
    });

    // The new owner is closed, so the previously selected labels cannot admit
    // the pending content under the old owner.
    const closedNext = await closeSubject({
      subjectKind: "user",
      subjectId: next.actor.userId,
    });
    const denied = await projectOwnedChatEventSearch([previous.threadId]);
    expect(denied.threads).toBe(0);
    expect(denied.indexedEvents).toBe(0);
    const unchanged = await readChatEventSearchProjectionRowsFixture(
      previous.threadId,
    );
    expect(unchanged.messages).toHaveLength(2);

    // Closing the previous owner instead must not stop the current one.
    await removeChatSearchErasureSubjectsFixture([closedNext.jobId]);
    await closeSubject({
      subjectKind: "user",
      subjectId: previous.actor.userId,
    });
    const projected = await projectOwnedChatEventSearch([previous.threadId]);
    expect(projected.threads).toBe(1);
    expect(projected.indexedEvents).toBe(1);

    // The new message belongs to the current owner, and the old owner cannot
    // see content relabelled onto it.
    const current = await chat.searchChat(next.actor, `${marker} transferred`);
    expect(current.results).toHaveLength(1);
    expect(current.results[0]?.chatThreadId).toBe(previous.threadId);
    const stale = await chat.searchChat(
      previous.actor,
      `${marker} transferred`,
    );
    expect(stale.results).toStrictEqual([]);
  });

  it("rolls back when ownership moves while identity locks are acquired", async () => {
    const orgId = `org_${randomUUID()}`;
    const current = await createProjectionFixture({ orgId });
    const nextOwner = bdd.user({ orgId });
    const marker = `ownerrace${randomUUID().replaceAll("-", "")}`;
    await seedProjectionContent(current.threadId, marker);
    await closeSubject({
      subjectKind: "user",
      subjectId: nextOwner.userId,
    });

    const heldAgent = await holdChatSearchAgentRowLockFixture({
      agentId: current.agentId,
      transferOwnerTo: nextOwner.userId,
      signal: context.signal,
    });
    const tick = projectOwnedChatEventSearch([current.threadId]);
    onTestFinished(async () => {
      await Promise.allSettled([heldAgent.release(), tick]);
    });

    // The projector already admitted the previous owner and is waiting on the
    // Agent identity lock when the transfer commits.
    await expect.poll(heldAgent.blockedWaiterCount, BLOCKED).toBeGreaterThan(0);
    await heldAgent.release();

    const denied = await tick;
    expect(denied.closedThreads).toBe(1);
    expect(denied.threads).toBe(0);
    expect(denied.indexedEvents).toBe(0);
    expect(denied.deferredThreads).toBe(0);
    await expectNoProjection(current.threadId);
  });

  it("indexes a later eligible thread behind more than one closed batch", async () => {
    const fixtures = [
      await createProjectionFixture(),
      await createProjectionFixture(),
      await createProjectionFixture(),
      await createProjectionFixture(),
    ];
    const marker = `starvation${randomUUID().replaceAll("-", "")}`;
    for (const fixture of fixtures) {
      await seedProjectionContent(fixture.threadId, marker);
    }
    const ordered = [...fixtures].sort((left, right) => {
      return left.threadId.localeCompare(right.threadId);
    });
    const eligible = ordered.at(-1);
    if (!eligible) {
      throw new Error("Expected an eligible chat search thread");
    }
    for (const fixture of ordered.slice(0, -1)) {
      await closeSubject({
        subjectKind: "user",
        subjectId: fixture.actor.userId,
      });
    }

    // Three closed candidates sort ahead of the eligible thread, so more than
    // one whole batch would be consumed if closure were resolved per candidate.
    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "2");
    const tick = await projectOwnedChatEventSearch(
      ordered.map((fixture) => {
        return fixture.threadId;
      }),
    );

    expect(tick.threads).toBe(1);
    expect(tick.indexedEvents).toBe(2);
    expect(tick.convergence).toStrictEqual({
      eligibleThreads: 1,
      durableCaughtUpThreads: 1,
    });
    const indexed = await readChatEventSearchProjectionFixture(
      eligible.threadId,
    );
    expect(indexed.indexedSeqId).toBe(indexed.lastChatEventSeqId);
    for (const fixture of ordered.slice(0, -1)) {
      await expectNoProjection(fixture.threadId);
    }
  });

  it("removes a later projection that races orphan cleanup", async () => {
    const chatThreadId = randomUUID();
    await insertOrphanedChatEventSearchProjectionFixture({
      chatThreadId,
      text: `projected before cleanup ${randomUUID()}`,
    });
    const heldWatermark = await holdChatEventSearchWatermarkRowLockFixture({
      chatThreadId,
      signal: context.signal,
    });
    const racingProjection = writeChatEventSearchProjectionFixture({
      chatThreadId,
      text: `projected during cleanup ${randomUUID()}`,
    });
    const tasks: Promise<unknown>[] = [racingProjection];
    onTestFinished(async () => {
      heldWatermark.release();
      await Promise.allSettled([heldWatermark.done, ...tasks]);
      await removeChatEventSearchProjectionRowsFixture(chatThreadId);
    });

    await expect.poll(heldWatermark.blockedWaiterCount).toBe(1);
    const cleanup = projectOwnedChatEventSearch([chatThreadId]);
    tasks.push(cleanup);
    await expect.poll(heldWatermark.blockedWaiterCount).toBe(2);
    heldWatermark.release();
    const [, cleaned] = await Promise.all([
      racingProjection,
      cleanup,
      heldWatermark.done,
    ]);

    expect(cleaned.orphanedThreads).toBe(1);
    await expect(
      readChatEventSearchProjectionRowsFixture(chatThreadId),
    ).resolves.toStrictEqual({ indexedSeqId: null, messages: [] });
  }, 60_000);

  it("removes search projection rows synchronously on normal deletion", async () => {
    const actor = bdd.user();
    const agent = await chat.createAgentForChatThread(actor);
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: `Projection cleanup ${randomUUID()}`,
    });
    const promptText = `synchronous cleanup ${randomUUID()}`;
    await insertSearchablePromptFixture({
      chatThreadId: thread.id,
      text: promptText,
    });
    await projectOwnedChatEventSearch([thread.id]);

    await chat.deleteThread(actor, thread.id);

    const hidden = await chat.searchChat(actor, promptText);
    expect(hidden.results).toStrictEqual([]);
    const repair = await projectOwnedChatEventSearch([thread.id]);
    expect(repair.orphanedThreads).toBe(0);
  });

  it("bounds each projection tick to the configured thread batch", async () => {
    const threadIds = [
      await createProjectionThread(),
      await createProjectionThread(),
    ];
    for (const chatThreadId of threadIds) {
      await insertChatSearchProjectionCoverageFixture({
        chatThreadId,
        promptText: `bounded prompt ${randomUUID()}`,
        assistantText: `bounded assistant ${randomUUID()}`,
        errorText: `bounded error ${randomUUID()}`,
        terminalText: `bounded terminal ${randomUUID()}`,
      });
    }
    const [selectedThreadId, deferredThreadId] = [...threadIds].sort();
    if (!selectedThreadId || !deferredThreadId) {
      throw new Error("Expected two bounded projection threads");
    }

    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "1");
    const tick = await projectOwnedChatEventSearch(threadIds);

    expect(tick.threads).toBe(1);
    expect(tick.indexedEvents).toBe(2);
    const selected =
      await readChatEventSearchProjectionFixture(selectedThreadId);
    expect(selected.indexedSeqId).toBe(selected.lastChatEventSeqId);
    expect(selected.messages).toHaveLength(2);
    const deferred =
      await readChatEventSearchProjectionFixture(deferredThreadId);
    expect(deferred.indexedSeqId).toBeNull();
    expect(deferred.messages).toStrictEqual([]);
  });

  it("deletes a later-revoked message by thread and sequence", async () => {
    const chatThreadId = await createProjectionThread();
    const text = `revoked durable prompt ${randomUUID()}`;
    const target = await insertSearchablePromptFixture({ chatThreadId, text });
    await projectOwnedChatEventSearch([chatThreadId]);

    const before = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(before.messages).toStrictEqual([
      {
        seqId: target.seqId,
        runId: null,
        role: "user",
        text,
      },
    ]);

    const replacement = await rejectSearchablePromptFixture({
      chatThreadId,
      eventId: target.id,
      text,
    });
    const tick = await projectOwnedChatEventSearch([chatThreadId]);
    expect(tick.deletedDocs).toBeGreaterThanOrEqual(1);

    const after = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(after.messages).toStrictEqual([
      {
        seqId: replacement.seqId,
        runId: null,
        role: "user",
        text,
      },
    ]);
    expect(after.messages[0]?.seqId).not.toBe(target.seqId);
    expect(after.indexedSeqId).toBe(after.lastChatEventSeqId);
  });
});
