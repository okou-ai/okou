import { randomUUID } from "node:crypto";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";
import { mcpGetChatStatusOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-status";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  clearMockMonotonicNow,
  mockMonotonicNow,
  now,
} from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { mcpServerRoutes } from "../mcp-server";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import {
  completeRunWithoutCallbacksFixture,
  setQueuedUserMessageCreatedAtFixture,
  timeoutRunWithoutCallbacksFixture,
} from "../../../test-fixtures/chat-events";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  deleteFakeChatEventObject,
  installFakeChatEventR2,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import {
  resource,
  defaultScopes,
  expectSubstantialCompactSuccess,
  requestBody,
  protocolHeaders,
  createMcpServerTestApi,
} from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const {
  fixture,
  callTool,
  getMessages,
  getStatus,
  sendMessage,
  cancelRun,
  waitForInputRunId,
  waitForRejectedInput,
} = createMcpServerTestApi(context);
const {
  messageFixture,
  snapshotMessages,
  threadFixture,
  nativeRunnerChatActor,
} = createMcpServerFixtures(context);

describe("MCP chat status", () => {
  it("reports an empty thread without changing its unread or message state", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const before = await f.chat.readThread(f.actor, thread.id);
    const status = await getStatus(f.auth.token(), {
      threadId: thread.id,
    });
    expect(status).toMatchObject({
      threadId: thread.id,
      lifecycle: { phase: "idle", outcome: null, output: "none" },
      messages: null,
      wait: null,
      messagePage: null,
      retryAfterMs: null,
    });
    expect(Number.isNaN(Date.parse(status.observedAt))).toBeFalsy();
    await expect(f.chat.readThread(f.actor, thread.id)).resolves.toStrictEqual(
      before,
    );
  });

  it("tracks an original launch through running, partial output and materialized completion", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "PRIVATE_STATUS_PROMPT: summarize the findings",
    });
    const runId = await waitForInputRunId(token, sent.inputRef);
    onTestFinished(async () => {
      await f.api.requestCancelRun(actor.actor, runId, [200, 400, 404]);
    });
    const args = { inputRef: sent.inputRef };
    const pending = await getStatus(token, args);
    expect(pending).toMatchObject({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      messages: {
        tool: "get_chat_messages",
        arguments: { threadId: thread.id, runId, limit: 20 },
      },
    });
    expect(pending.retryAfterMs).toBeGreaterThan(0);
    expect(JSON.stringify(pending)).not.toContain("PRIVATE_STATUS_PROMPT");
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    await expect(getStatus(token, args)).resolves.toMatchObject({
      lifecycle: { phase: "running", outcome: null, output: "pending" },
    });
    await f.webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "A readable intermediate result." },
              ],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    const partial = await getStatus(token, args);
    expect(partial).toMatchObject({
      lifecycle: { phase: "running", outcome: null, output: "partial" },
    });
    await f.completeChatRunOk(runId, claimed.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    const readyResult = await callTool(token, "get_chat_status", args);
    expectSubstantialCompactSuccess(readyResult);
    const ready = mcpGetChatStatusOutputSchema.parse(
      readyResult.structuredContent,
    );
    expect(ready).toMatchObject({
      lifecycle: {
        phase: "settled",
        outcome: "completed",
        output: "ready",
      },
      retryAfterMs: null,
    });
    if (!ready.messages) {
      throw new Error("Expected a message retrieval handoff");
    }
    const messagesResult = await callTool(
      token,
      "get_chat_messages",
      ready.messages.arguments,
    );
    expectSubstantialCompactSuccess(messagesResult);
    const messages = mcpGetChatMessagesOutputSchema.parse(
      messagesResult.structuredContent,
    );
    expect(
      new Set(
        messages.messages.map((message) => {
          return message.role;
        }),
      ),
    ).toStrictEqual(new Set(["user", "assistant"]));
    expect(
      messages.messages.filter((message) => {
        return message.role === "assistant";
      }),
    ).toMatchObject([{ text: "A readable intermediate result." }]);
    const waited = await getStatus(token, { ...args, waitMs: 60_000 });
    expect(waited.wait).toStrictEqual({
      requestedMs: 60_000,
      effectiveMs: 8000,
      elapsedMs: expect.any(Number),
      observations: 1,
      outcome: "ready",
      returnReason: "output_ready",
    });
    expect(waited.messagePage).toStrictEqual(messages);
    await expect(
      getStatus(token, { threadId: thread.id }),
    ).resolves.toMatchObject({
      lifecycle: {
        phase: "settled",
        outcome: "completed",
        output: "ready",
      },
      messages: {
        arguments: { threadId: thread.id, runId, limit: 20 },
      },
      wait: null,
      messagePage: null,
    });
    const visibleInputRef = messages.messages.find((message) => {
      return message.role === "user";
    })?.ref;
    const invalidRefs = [
      { ...sent.inputRef, eventId: randomUUID() },
      { ...sent.inputRef, seqId: sent.inputRef.seqId + 1 },
      visibleInputRef,
    ];
    for (const inputRef of invalidRefs) {
      if (!inputRef) {
        throw new Error("Expected a visible replacement reference");
      }
      await expect(getStatus(token, { inputRef })).resolves.toMatchObject({
        lifecycle: {
          phase: "unavailable",
          outcome: null,
          output: "unavailable",
        },
        messages: null,
      });
    }
    await expect(
      getStatus(token, {
        inputRef: {
          ...sent.inputRef,
          threadId: thread.id.toUpperCase(),
          eventId: sent.inputRef.eventId.toUpperCase(),
        },
      }),
    ).resolves.toMatchObject({
      threadId: thread.id,
      lifecycle: {
        phase: "settled",
        outcome: "completed",
        output: "ready",
      },
      messages: {
        arguments: { threadId: thread.id, runId, limit: 20 },
      },
    });
  });

  it("rereads after a bounded delay and returns ready content from the fresh snapshot", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Wait for the canonical result",
    });
    const runId = await waitForInputRunId(token, sent.inputRef);
    onTestFinished(async () => {
      context.mocks.signalTimers.delay.mockReset();
      await f.api.requestCancelRun(actor.actor, runId, [200, 400, 404]);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    await f.webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [{ type: "text", text: "Bounded wait result" }],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    context.mocks.signalTimers.delay.mockImplementationOnce(
      async (_ms, options) => {
        options?.signal?.throwIfAborted();
        await f.completeChatRunOk(runId, claimed.sandboxHeaders, {
          lastEventSequence: 0,
        });
        await flushWaitUntilForTest();
      },
    );

    const status = await getStatus(token, {
      inputRef: sent.inputRef,
      waitMs: 5000,
    });

    expect(status).toMatchObject({
      lifecycle: {
        phase: "settled",
        outcome: "completed",
        output: "ready",
      },
      wait: {
        requestedMs: 5000,
        effectiveMs: 5000,
        observations: 2,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            text: "Bounded wait result",
          }),
        ]),
      },
      retryAfterMs: null,
    });
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledOnce();
  });

  it("returns a fresh deadline status and exposes output that arrives later", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Finish after the bounded wait",
    });
    const runId = await waitForInputRunId(token, sent.inputRef);
    onTestFinished(async () => {
      context.mocks.signalTimers.delay.mockReset();
      await f.api.requestCancelRun(actor.actor, runId, [200, 400, 404]);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    let monotonicMs = 1000;
    mockMonotonicNow(monotonicMs);
    onTestFinished(() => {
      clearMockMonotonicNow();
    });
    context.mocks.signalTimers.delay.mockImplementation(
      (milliseconds, options) => {
        options?.signal?.throwIfAborted();
        monotonicMs += milliseconds;
        mockMonotonicNow(monotonicMs);
        return Promise.resolve();
      },
    );

    const deadline = await getStatus(token, {
      inputRef: sent.inputRef,
      waitMs: 5000,
    });

    expect(deadline).toMatchObject({
      lifecycle: { phase: "running", outcome: null, output: "pending" },
      wait: {
        requestedMs: 5000,
        effectiveMs: 5000,
        elapsedMs: 5000,
        observations: 4,
        outcome: "deadline",
        returnReason: "application_deadline",
      },
      messagePage: null,
      retryAfterMs: 2000,
    });
    expect(
      context.mocks.signalTimers.delay.mock.calls.map(([milliseconds]) => {
        return milliseconds;
      }),
    ).toStrictEqual([2000, 2000, 1000]);

    clearMockMonotonicNow();
    await f.webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: { content: [{ type: "text", text: "Late result" }] },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await f.completeChatRunOk(runId, claimed.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    const late = await getStatus(token, {
      inputRef: sent.inputRef,
      waitMs: 5000,
    });
    expect(late.wait).toMatchObject({
      observations: 1,
      outcome: "ready",
      returnReason: "output_ready",
    });
    expect(late.messagePage?.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Late result" }),
    );
  });

  it("returns current status when principal wait capacity is full and reuses released slots", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Keep bounded waiters pending",
    });
    const runId = await waitForInputRunId(token, sent.inputRef);
    onTestFinished(async () => {
      context.mocks.signalTimers.delay.mockReset();
      await f.api.requestCancelRun(actor.actor, runId, [200, 400, 404]);
    });
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let heldWaiters = 0;
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      options?.signal?.throwIfAborted();
      if (heldWaiters < 2) {
        heldWaiters += 1;
        if (heldWaiters === 2) {
          entered.resolve();
        }
        return release.promise;
      }
      return Promise.resolve();
    });
    const args = {
      inputRef: sent.inputRef,
      waitMs: 8000,
    };

    const first = getStatus(token, args);
    const second = getStatus(token, args);
    await entered.promise;
    const exhausted = await getStatus(token, args);
    expect(exhausted.wait).toMatchObject({
      observations: 1,
      outcome: "status",
      returnReason: "waiter_limit",
    });
    expect(exhausted.lifecycle.output).toBe("pending");

    release.resolve();
    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      expect.objectContaining({
        wait: expect.objectContaining({
          outcome: "status",
          returnReason: "observation_limit",
        }),
      }),
      expect.objectContaining({
        wait: expect.objectContaining({
          outcome: "status",
          returnReason: "observation_limit",
        }),
      }),
    ]);
    await expect(getStatus(token, args)).resolves.toMatchObject({
      wait: {
        outcome: "status",
        returnReason: "observation_limit",
      },
    });
  });

  it("cancels only a disconnected waiter and releases its admission slot", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Keep running after the waiter disconnects",
    });
    const runId = await waitForInputRunId(token, sent.inputRef);
    const controller = new AbortController();
    onTestFinished(async () => {
      controller.abort();
      context.mocks.signalTimers.delay.mockReset();
      await f.api.requestCancelRun(actor.actor, runId, [200, 400, 404]);
    });
    const delayStarted = createDeferredPromise<void>(context.signal);
    const delayAborted = createDeferredPromise<void>(context.signal);
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      const waitSignal = options?.signal;
      if (!waitSignal) {
        throw new Error("Expected the waiter delay to own a signal");
      }
      const held = createDeferredPromise<void>(waitSignal);
      waitSignal.addEventListener(
        "abort",
        () => {
          delayAborted.resolve();
        },
        { once: true },
      );
      delayStarted.resolve();
      return held.promise;
    });
    const app = createAppWithRoutes({
      routes: mcpServerRoutes,
      signal: context.signal,
    });
    const pending = settleIncludingAbort(
      (async () => {
        const response = await app.request(
          new Request(resource, {
            method: "POST",
            headers: {
              ...protocolHeaders(token, "tools/call", true, "get_chat_status"),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(
              requestBody("tools/call", true, {
                name: "get_chat_status",
                arguments: {
                  inputRef: sent.inputRef,
                  waitMs: 8000,
                },
              }),
            ),
            signal: controller.signal,
          }),
        );
        return { status: response.status, body: await response.text() };
      })(),
    );

    await delayStarted.promise;
    controller.abort(new DOMException("Caller disconnected", "AbortError"));
    await delayAborted.promise;
    await pending;
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    const after = await getStatus(token, {
      inputRef: sent.inputRef,
      waitMs: 8000,
    });
    expect(after.wait?.returnReason).toBe("observation_limit");
    await expect(f.api.readRun(actor.actor, runId)).resolves.toMatchObject({
      status: expect.not.stringMatching(/cancel/u),
    });
  });

  it("keeps cancellation recovery separate from readable partial and late output", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Cancel after partial progress",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: { content: [{ type: "text", text: "Partial progress" }] },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    const token = auth.token({ scope: defaultScopes });
    await cancelRun(token, sent.runId);
    await flushWaitUntilForTest();
    const recovering = await getStatus(token, { threadId: sent.threadId });
    expect(recovering).toMatchObject({
      lifecycle: {
        phase: "finalizing",
        outcome: "cancelled",
        output: "partial",
      },
    });
    expect(recovering.retryAfterMs).toBeGreaterThan(0);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [{ type: "text", text: "Recovered final progress" }],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await f.completeChatRunOk(sent.runId, claimed.sandboxHeaders, {
      lastEventSequence: 1,
    });
    await flushWaitUntilForTest();
    const recovered = await getStatus(token, { threadId: sent.threadId });
    expect(recovered).toMatchObject({
      lifecycle: {
        phase: "settled",
        outcome: "cancelled",
        output: "ready",
      },
      retryAfterMs: null,
    });
    if (!recovered.messages) {
      throw new Error("Expected recovered output retrieval instructions");
    }
    expect(
      (await getMessages(token, recovered.messages.arguments)).messages.filter(
        (message) => {
          return message.role === "assistant";
        },
      ),
    ).toHaveLength(2);
  });

  it("reports failed runs without inventing assistant messages from terminal errors", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Fail before producing output",
    });
    const runId = await waitForInputRunId(token, sent.inputRef);
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    await f.failChatRun(runId, claimed.sandboxHeaders, "PRIVATE_RAW_ERROR");
    await flushWaitUntilForTest();
    const status = await getStatus(token, {
      inputRef: sent.inputRef,
      waitMs: 8000,
    });
    expect(status).toMatchObject({
      lifecycle: { phase: "settled", outcome: "failed", output: "none" },
      wait: {
        observations: 1,
        outcome: "status",
        returnReason: "non_retryable_state",
      },
      messagePage: null,
      retryAfterMs: null,
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE_RAW_ERROR");
  });

  it("reports completed runs with confirmed no output", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Complete without assistant output",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await f.completeChatRunOk(sent.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    await expect(
      getStatus(auth.token(), { threadId: sent.threadId }),
    ).resolves.toMatchObject({
      lifecycle: {
        phase: "settled",
        outcome: "completed",
        output: "none",
      },
      retryAfterMs: null,
    });
  });

  it("identifies a queued launch and preserves its association after original-input retention", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const active = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Finish before the queued launch",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    const token = auth.token({ scope: defaultScopes });
    const submitted = await sendMessage(token, {
      threadId: active.threadId,
      requestId: randomUUID(),
      text: "Start a new run when the previous one completes",
    });
    const args = { inputRef: submitted.inputRef };
    await expect(getStatus(token, args)).resolves.toMatchObject({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      messages: null,
    });
    await f.completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    const launched = await getStatus(token, args);
    if (!launched.messages) {
      throw new Error("Expected the queued input to start its own run");
    }
    const nextRunId = launched.messages.arguments.runId;
    onTestFinished(async () => {
      await f.api.requestCancelRun(actor.actor, nextRunId, [200, 400, 404]);
    });
    expect(nextRunId).not.toBe(active.runId);
    expect(launched).toMatchObject({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      messages: {
        arguments: { threadId: active.threadId, runId: nextRunId, limit: 20 },
      },
    });
    // Infrastructure exception: the retention cutoff uses the database clock;
    // public requests cannot backdate this original submission by 31 days.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: submitted.inputRef.eventId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(active.threadId);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [active.threadId] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const archived = await getStatus(token, args);
    expect(archived.lifecycle).toStrictEqual(launched.lifecycle);
    expect(archived.messages).toStrictEqual(launched.messages);
  });

  it.each(["completed", "timeout"] as const)(
    "keeps %s output pending or partial until its canonical terminal marker exists",
    async (status) => {
      const auth = await fixture();
      const f = createChatEventsFixture(context);
      const actor = await nativeRunnerChatActor(f, auth);
      const sent = await f.sendChatRun(actor.actor, {
        agentId: actor.agentId,
        prompt: "Observe a delayed terminal callback",
      });
      const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
      // Infrastructure exception: a successful public completion schedules its
      // callback. Only a process crash can leave the committed terminal run
      // without that dispatch; the existing scoped fixture recreates this gap.
      if (status === "completed") {
        await completeRunWithoutCallbacksFixture({ runId: sent.runId });
      } else {
        await timeoutRunWithoutCallbacksFixture({ runId: sent.runId });
      }
      const token = auth.token();
      await expect(
        getStatus(token, { threadId: sent.threadId }),
      ).resolves.toMatchObject({
        lifecycle: { phase: "finalizing", outcome: status, output: "pending" },
        retryAfterMs: expect.any(Number),
      });
      await f.webhooks.requestAgentEvents(
        {
          runId: sent.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 0,
              message: {
                content: [{ type: "text", text: "Late canonical output" }],
              },
            },
          ],
        },
        claimed.sandboxHeaders,
        [200],
      );
      const observed = await getStatus(token, { threadId: sent.threadId });
      // Timeout fencing discards late output; an ordinary completed run can
      // materialize it, but neither case invents the missing terminal marker.
      expect(observed.lifecycle).toStrictEqual({
        phase: "finalizing",
        outcome: status,
        output: status === "completed" ? "partial" : "pending",
      });
      expect(observed.retryAfterMs).toBeGreaterThan(0);
    },
  );

  it("resolves archived original inputs and rejects an incomplete archive", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Retain my original input reference",
    });
    await waitForRejectedInput(token, sent.inputRef);
    const args = { inputRef: sent.inputRef };
    const before = await getStatus(token, args);
    // Infrastructure exception: public sends cannot backdate acceptance past
    // the database-clock retention cutoff. Archive, retention and all status
    // assertions still execute their real HTTP endpoints.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: sent.inputRef.eventId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(thread.id);
    const archive = puts.at(-1);
    if (!archive) {
      throw new Error("Expected the canonical archive");
    }
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const after = await getStatus(token, args);
    expect(after.lifecycle).toStrictEqual(before.lifecycle);
    expect(after.messages).toStrictEqual(before.messages);
    expect(after.retryAfterMs).toBe(before.retryAfterMs);
    await deleteFakeChatEventObject(archive.key);
    const failure = await callTool(token, "get_chat_status", args);
    expect(failure.isError).toBeTruthy();
    expect(failure.content[0]?.text).toContain("could not be read completely");
  });

  it("rejects malformed canonical status selectors without mutation", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token();
    const before = await f.chat.readThread(f.actor, thread.id);
    const inputRef = {
      threadId: thread.id,
      eventId: randomUUID(),
      seqId: 1,
    };
    for (const args of [
      { threadId: thread.id, inputRef },
      { threadId: thread.id, waitMs: 0 },
      {
        inputRef: {
          threadId: "not-a-uuid",
          eventId: randomUUID(),
          seqId: 1,
        },
      },
      {
        inputRef: { threadId: thread.id, eventId: randomUUID(), seqId: 0 },
      },
      { threadId: "not-a-uuid" },
    ]) {
      expect(
        (await callTool(token, "get_chat_status", args)).isError,
      ).toBeTruthy();
    }
    await expect(f.chat.readThread(f.actor, thread.id)).resolves.toStrictEqual(
      before,
    );
  });
});
