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
} from "../../../test-fixtures/chat-events";
import { withChatSearchStatementFailureFixture } from "../../../test-fixtures/chat-search-statement-failure";
import { settleIncludingAbort } from "../../utils";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const CRON_SECRET = "durable-chat-search-projection-secret";

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
    rethrowErrors: true,
  })(testChatEventSearchProjectionContract);
  const response = await accept(
    client.project({
      body: { chat_thread_ids: [...chatThreadIds] },
    }),
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

  it("projects without waiting for an in-flight thread deletion", async () => {
    const actor = bdd.user();
    const agent = await chat.createAgentForChatThread(actor);
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: `Projection deletion ${randomUUID()}`,
    });
    const promptText = `deleting prompt ${randomUUID()}`;
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId: thread.id,
      promptText,
      assistantText: `deleting assistant ${randomUUID()}`,
      errorText: `deleting error ${randomUUID()}`,
      terminalText: `deleting terminal ${randomUUID()}`,
    });
    const heldDeletion = await holdChatThreadDeleteTransactionFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    const tick = projectOwnedChatEventSearch([thread.id]);
    onTestFinished(async () => {
      heldDeletion.release();
      await Promise.all([heldDeletion.done, tick]);
    });

    const projected = await tick;
    expect(projected.success).toBeTruthy();
    expect(projected.threads).toBe(1);
    await expect(heldDeletion.firstBlockedStatementKind()).resolves.toBeNull();

    heldDeletion.release();
    await heldDeletion.done;

    const deleted = await chat.requestReadThread(actor, thread.id, [404]);
    expect(deleted.status).toBe(404);
    const hidden = await chat.searchChat(actor, promptText);
    expect(hidden.results).toStrictEqual([]);

    const cleanup = await projectOwnedChatEventSearch([thread.id]);
    expect(cleanup.orphanedThreads).toBe(1);
    const clean = await projectOwnedChatEventSearch([thread.id]);
    expect(clean.orphanedThreads).toBe(0);
  });

  it("propagates server cancellation and rolls back the interrupted projection", async () => {
    const { threadId } = await createProjectionFixture();
    await seedProjectionContent(threadId, `cancel ${randomUUID()}`);
    const result = await withChatSearchStatementFailureFixture(
      threadId,
      "cancel",
      async () => {
        return await settleIncludingAbort(
          projectOwnedChatEventSearch([threadId]),
        );
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        cause: {
          code: "57014",
          message: "canceling statement due to user request",
        },
      },
    });
    await expectNoProjection(threadId);
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
