import { randomUUID } from "node:crypto";

import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  insertChatSearchProjectionCoverageFixture,
  readChatEventSearchProjectionFixture,
  readChatEventSearchProjectionRowsFixture,
} from "../../../test-fixtures/chat-event-search";
import {
  holdChatEventInsertTransactionFixture,
  holdChatThreadDeleteTransactionFixture,
} from "../../../test-fixtures/chat-events";
import { withChatSearchStatementFailureFixture } from "../../../test-fixtures/chat-search-statement-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import type { ApiTestUser } from "./helpers/api-bdd";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  assistantEvent,
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const fixture = createChatEventsFixture(context);
const { bdd, chat, chatCallbacks } = fixture;
const CRON_SECRET = "durable-chat-search-projection-secret";

function cronClient() {
  mockEnv("CRON_SECRET", CRON_SECRET);
  return setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
}

/**
 * Runs the production projector scoped to this test's own threads, so its
 * counters describe exactly those threads in the shared database.
 */
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

/**
 * A send from an organization without credits is accepted, then rejected by
 * its background pick; the rejected input stays a visible user message.
 */
async function sendRejectedPrompt(
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
): Promise<string> {
  const sent = await chat.requestSendEvent(actor, { agentId, prompt }, [201]);
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected a no-credit send without a run");
  }
  await flushWaitUntilForTest();
  return sent.body.threadId;
}

async function promptActor(displayName: string) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  // Rejected prompts use the unconfigured Auto workspace's no-credit boundary.
  const agent = await bdd.createAgent(actor, { displayName });
  return { actor, agentId: agent.agentId };
}

describe("GET /api/cron/project-chat-event-search", () => {
  it("projects only non-empty visible user and assistant messages", async () => {
    const { actor, agentId, runnerGroup } =
      await fixture.entitledNativeChatActor();
    const promptText = `durable prompt ${randomUUID()}`;
    const assistantText = `durable assistant ${randomUUID()}`;

    const run = await fixture.sendChatRun(actor, {
      agentId,
      prompt: promptText,
    });
    const { sandboxHeaders } = await fixture.claimChatRun(
      runnerGroup,
      run.runId,
    );
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, assistantText)]);
    await fixture.completeChatRunOk(run.runId, sandboxHeaders);

    const failing = await fixture.sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: `durable follow-up ${randomUUID()}`,
    });
    const failingClaim = await fixture.claimChatRun(runnerGroup, failing.runId);
    await fixture.failChatRun(
      failing.runId,
      failingClaim.sandboxHeaders,
      `excluded error ${randomUUID()}`,
    );
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, run.threadId);
    const failure = events.find((event) => {
      return event.eventType === "run.failed" && event.runId === failing.runId;
    });
    if (!failure) {
      throw new Error("Expected the failed run's lifecycle event");
    }
    const failureText = chatEventDisplayText(failure);
    if (!failureText?.trim()) {
      throw new Error("Expected the failed run to show its error");
    }

    const tick = await projectOwnedChatEventSearch([run.threadId]);
    expect(tick.success).toBeTruthy();
    expect(tick.threads).toBe(1);
    // Both prompts and the assistant reply; error and lifecycle rows are skipped.
    expect(tick.indexedEvents).toBe(3);
    expect(tick.convergence.eligibleThreads).toBe(1);
    expect(tick.convergence.durableCaughtUpThreads).toBe(1);

    const prompt = await chat.searchChat(actor, promptText);
    expect(prompt.results).toStrictEqual([
      expect.objectContaining({
        chatThreadId: run.threadId,
        matchedMessage: expect.objectContaining({
          chatThreadId: run.threadId,
          role: "user",
          content: promptText,
          runId: run.runId,
        }),
      }),
    ]);
    const assistant = await chat.searchChat(actor, assistantText);
    expect(assistant.results).toStrictEqual([
      expect.objectContaining({
        chatThreadId: run.threadId,
        matchedMessage: expect.objectContaining({
          chatThreadId: run.threadId,
          role: "assistant",
          content: assistantText,
          runId: run.runId,
        }),
      }),
    ]);
    // Error and terminal lifecycle rows stay out of the index.
    const failed = await chat.searchChat(actor, failureText);
    expect(failed.results).toStrictEqual([]);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().project({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("keeps overlapping projection ticks idempotent", async () => {
    const { actor, agentId } = await promptActor("Overlapping projection");
    const promptText = `overlap prompt ${randomUUID()}`;
    const threadId = await sendRejectedPrompt(actor, agentId, promptText);

    const ticks = await Promise.all([
      projectOwnedChatEventSearch([threadId]),
      projectOwnedChatEventSearch([threadId]),
    ]);

    expect(
      ticks.reduce((total, tick) => {
        return total + tick.indexedEvents;
      }, 0),
    ).toBe(1);
    const found = await chat.searchChat(actor, promptText);
    expect(
      found.results.map((result) => {
        return [result.chatThreadId, result.matchedMessage.content];
      }),
    ).toStrictEqual([[threadId, promptText]]);
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

  it("removes search projection rows synchronously on normal deletion", async () => {
    const { actor, agentId } = await promptActor("Projection cleanup");
    const promptText = `synchronous cleanup ${randomUUID()}`;
    const threadId = await sendRejectedPrompt(actor, agentId, promptText);
    await projectOwnedChatEventSearch([threadId]);
    const indexed = await chat.searchChat(actor, promptText);
    expect(
      indexed.results.map((result) => {
        return result.chatThreadId;
      }),
    ).toStrictEqual([threadId]);

    await chat.deleteThread(actor, threadId);

    const hidden = await chat.searchChat(actor, promptText);
    expect(hidden.results).toStrictEqual([]);
    const repair = await projectOwnedChatEventSearch([threadId]);
    expect(repair.orphanedThreads).toBe(0);
  });

  it("bounds each projection tick to the configured thread batch", async () => {
    const { actor, agentId } = await promptActor("Bounded projection");
    const marker = `bounded${randomUUID().replaceAll("-", "")}`;
    const threadIds = [
      await sendRejectedPrompt(actor, agentId, `${marker} first`),
      await sendRejectedPrompt(actor, agentId, `${marker} second`),
    ];

    const [selectedThreadId, deferredThreadId] = [...threadIds].sort();
    if (!selectedThreadId || !deferredThreadId) {
      throw new Error("Expected two bounded projection threads");
    }

    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "1");
    const bounded = await projectOwnedChatEventSearch(threadIds);
    expect(bounded.threads).toBe(1);
    expect(bounded.indexedEvents).toBe(1);
    const selected = await chat.searchChat(actor, marker);
    expect(
      selected.results.map((result) => {
        return result.chatThreadId;
      }),
    ).toStrictEqual([selectedThreadId]);

    // The deferred thread converges on the next bounded tick.
    const next = await projectOwnedChatEventSearch(threadIds);
    expect(next.threads).toBe(1);
    expect(next.indexedEvents).toBe(1);
    const found = await chat.searchChat(actor, marker);
    expect(
      found.results
        .map((result) => {
          return result.chatThreadId;
        })
        .sort(),
    ).toStrictEqual([selectedThreadId, deferredThreadId]);
  });

  it("deletes a later-revoked message by thread and sequence", async () => {
    const { actor, agentId, runnerGroup } =
      await fixture.entitledNativeChatActor();
    const blocking = await fixture.sendChatRun(actor, {
      agentId,
      prompt: `hold the thread ${randomUUID()}`,
    });
    const { sandboxHeaders } = await fixture.claimChatRun(
      runnerGroup,
      blocking.runId,
    );
    // While a run is active the next message waits in the thread unclaimed.
    const text = `revoked durable prompt ${randomUUID()}`;
    const clientEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      { agentId, threadId: blocking.threadId, prompt: text, clientEventId },
      [201],
    );
    if (queued.status !== 201 || queued.body.runId !== null) {
      throw new Error("Expected the chat send to queue while a run is active");
    }
    await flushWaitUntilForTest();
    await projectOwnedChatEventSearch([blocking.threadId]);

    const before = await chat.searchChat(actor, text);
    expect(before.results).toStrictEqual([
      expect.objectContaining({
        chatThreadId: blocking.threadId,
        matchedMessage: expect.objectContaining({
          role: "user",
          content: text,
          runId: null,
        }),
      }),
    ]);
    const queuedSeqId = before.results[0]?.matchedMessage.seqId;

    // Finishing the blocking run claims the queued message, replacing it with
    // a launched prompt that revokes the indexed one.
    await fixture.completeChatRunOk(blocking.runId, sandboxHeaders);
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, blocking.threadId);
    const launched = userMessages(events).find((message) => {
      return (
        message.revokesEventId === clientEventId && message.runId !== undefined
      );
    });
    if (launched?.runId === undefined) {
      throw new Error("Expected the queued message to launch a run");
    }
    const tick = await projectOwnedChatEventSearch([blocking.threadId]);
    expect(tick.deletedDocs).toBeGreaterThanOrEqual(1);

    const after = await chat.searchChat(actor, text);
    expect(after.results).toStrictEqual([
      expect.objectContaining({
        chatThreadId: blocking.threadId,
        matchedMessage: expect.objectContaining({
          role: "user",
          content: text,
          runId: launched.runId,
        }),
      }),
    ]);
    expect(after.results[0]?.matchedMessage.seqId).not.toBe(queuedSeqId);
    await fixture.cancelChatRun(actor, launched.runId);
  });
});
