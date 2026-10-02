import { randomUUID } from "node:crypto";

import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import type { ApiTestUser } from "./helpers/api-bdd";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  assistantEvent,
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const fixture = createChatEventsFixture(context);
const { bdd, api, chat, chatCallbacks } = fixture;
const CRON_SECRET = "durable-chat-search-projection-secret";

function cronClient() {
  mockEnv("CRON_SECRET", CRON_SECRET);
  return setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
}

/**
 * Runs the production cron tick. It projects every pending thread, so its
 * totals include other suites' threads and are asserted only as lower bounds.
 */
async function projectChatEventSearch() {
  // Sends only enqueue; let their background picks settle the inputs first.
  await flushWaitUntilForTest();
  const response = await accept(
    cronClient().project({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
  return response.body;
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
  await api.ensureOrgModelProvider(actor);
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

    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();
    expect(tick.threads).toBeGreaterThanOrEqual(1);
    expect(tick.indexedEvents).toBeGreaterThanOrEqual(3);
    expect(tick.convergence.durableCaughtUpThreads).toBeGreaterThanOrEqual(1);
    expect(tick.convergence.eligibleThreads).toBeGreaterThanOrEqual(
      tick.convergence.durableCaughtUpThreads,
    );

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
  }, 120_000);

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
      projectChatEventSearch(),
      projectChatEventSearch(),
    ]);

    for (const tick of ticks) {
      expect(tick.success).toBeTruthy();
    }
    const found = await chat.searchChat(actor, promptText);
    expect(
      found.results.map((result) => {
        return [result.chatThreadId, result.matchedMessage.content];
      }),
    ).toStrictEqual([[threadId, promptText]]);
  }, 60_000);

  it("removes search projection rows synchronously on normal deletion", async () => {
    const { actor, agentId } = await promptActor("Projection cleanup");
    const promptText = `synchronous cleanup ${randomUUID()}`;
    const threadId = await sendRejectedPrompt(actor, agentId, promptText);
    await projectChatEventSearch();
    const indexed = await chat.searchChat(actor, promptText);
    expect(
      indexed.results.map((result) => {
        return result.chatThreadId;
      }),
    ).toStrictEqual([threadId]);

    await chat.deleteThread(actor, threadId);

    const hidden = await chat.searchChat(actor, promptText);
    expect(hidden.results).toStrictEqual([]);
  }, 60_000);

  it("bounds each projection tick to the configured thread batch", async () => {
    const { actor, agentId } = await promptActor("Bounded projection");
    const marker = `bounded${randomUUID().replaceAll("-", "")}`;
    const threadIds = [
      await sendRejectedPrompt(actor, agentId, `${marker} first`),
      await sendRejectedPrompt(actor, agentId, `${marker} second`),
    ];

    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "1");
    const bounded = await projectChatEventSearch();
    expect(bounded.success).toBeTruthy();
    expect(bounded.threads).toBeLessThanOrEqual(1);

    // A deferred thread converges on a later tick at the default batch size.
    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", undefined);
    await projectChatEventSearch();
    const found = await chat.searchChat(actor, marker);
    expect(
      found.results
        .map((result) => {
          return result.chatThreadId;
        })
        .sort(),
    ).toStrictEqual([...threadIds].sort());
  }, 60_000);

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
    await projectChatEventSearch();

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
    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();

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
  }, 120_000);
});
