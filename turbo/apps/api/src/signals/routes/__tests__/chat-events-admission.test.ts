import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { userPreferencesRoutes } from "../user-preferences";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { clearAllDetached } from "../../utils";
import { mailRoutes } from "../mail";
import { expectApiError } from "./helpers/api-bdd";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createPublicChatAdmissionFixture } from "./helpers/public-chat-admission-fixture";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  type ChatRunSendBody,
  okouTokenFromClaim,
  assistantMessages,
  userMessages,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const reads = createRunReadsApi(context);
const {
  bdd,
  api,
  chat,
  webhooks,
  chatCallbacks,
  connectors,
  entitledChatActor: createEntitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  chatEventsClient,
  sessionHeaders,
} = createChatEventsFixture(context);

// These sends observe claimable native Runner runs; Sonnet's Pi route can
// finish API-first before the Runner claim, cancel, and callback steps run.
async function entitledChatActor() {
  const result = await createEntitledChatActor();
  await api.ensurePersonalSubscriptionModel(result.actor, {
    model: "claude-fable-5-1",
  });
  return result;
}

describe("CHAT-02: on-demand member memory initialization", () => {
  it("initializes an existing member's memory from preferences before the member's first run", async () => {
    const { actor: owner } = await entitledChatActor();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const preferences = setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    );
    const storages = createStoragesBddApi(context);
    // An existing member with preferences but no memory, as before on-demand
    // initialization: the read reports it without writing anything.
    await accept(
      preferences.update({
        headers: sessionHeaders(member),
        body: { timezone: "Asia/Tokyo", locale: "ja-JP" },
      }),
      [200],
    );
    const before = await accept(
      preferences.get({ headers: sessionHeaders(member) }),
      [200],
    );
    expect(before.body.memoryInitialized).toBeFalsy();
    await expect(
      accept(preferences.get({ headers: sessionHeaders(member) }), [200]),
    ).resolves.toMatchObject({ body: { memoryInitialized: false } });

    const initialized = await accept(
      preferences.initialize({
        headers: sessionHeaders(member),
        body: { timezone: "America/Los_Angeles", locale: "en-US" },
      }),
      [200],
    );
    expect(initialized.body).toMatchObject({
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
      memoryInitialized: true,
    });
    const memory = await storages.downloadStorage(member, {
      name: "memory",
      owner: "user",
    });

    const agent = await bdd.createAgent(member, {
      displayName: "Member memory agent",
      visibility: "private",
    });
    // The owner's preferred model is the owner's own; the member selects the
    // organization's configured model explicitly.
    const launched = await sendChatRun(member, {
      agentId: agent.agentId,
      model: "claude-fable-5-1",
      prompt: "run after on-demand memory initialization",
    });
    expect(launched.runId).toStrictEqual(expect.any(String));
    await cancelChatRun(member, launched.runId);

    // Repeating initialization keeps the existing memory unchanged.
    await accept(
      preferences.initialize({
        headers: sessionHeaders(member),
        body: { timezone: "America/Los_Angeles", locale: "en-US" },
      }),
      [200],
    );
    await expect(
      storages.downloadStorage(member, { name: "memory", owner: "user" }),
    ).resolves.toStrictEqual(memory);
  });
});

describe("CHAT-02: web chat send and client ids", () => {
  it("keeps one input and one launch when the first web send races its retry", async () => {
    const { actor, agentId } = await entitledChatActor();
    const clientThreadId = randomUUID();
    const clientEventId = randomUUID();
    const body = {
      agentId,
      prompt: "concurrent first input",
      clientThreadId,
      clientEventId,
      model: await chat.getDefaultCreateThreadModel(actor),
    };
    const responses = await Promise.all([
      chat.requestSendEvent(actor, body, [201]),
      chat.requestSendEvent(actor, body, [201]),
    ]);
    for (const response of responses) {
      expect(response.body).toMatchObject({
        threadId: clientThreadId,
        runId: null,
      });
    }
    const messages = await waitForThreadMessages(
      actor,
      clientThreadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === clientEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const inputs = userMessages(messages.events);
    expect(
      inputs.filter((message) => {
        return message.id === clientEventId;
      }),
    ).toHaveLength(1);
    const launches = inputs.filter((message) => {
      return (
        message.revokesEventId === clientEventId && message.runId !== undefined
      );
    });
    expect(launches).toHaveLength(1);
    const runId = launches[0]?.runId;
    if (!runId) {
      throw new Error("Expected one picked run for the raced input");
    }
    expect((await api.readRun(actor, runId)).prompt).toBe(body.prompt);
    await cancelChatRun(actor, runId);
  });

  it("creates a web chat run with client-provided ids", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const clientThreadId = randomUUID();
    const clientEventId = randomUUID();
    const prompt = "hello from bdd web chat";
    const model = await chat.getDefaultCreateThreadModel(actor);
    const first = await accept(
      chatEventsClient().send({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          prompt,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
          hasTextContent: true,
          clientThreadId,
          clientEventId,
          model,
        },
      }),
      [201],
    );
    expect(first.body).toStrictEqual({
      runId: null,
      threadId: clientThreadId,
      createdAt: expect.any(String),
    });

    // A client cannot inject MCP provenance on a new input or on a retry of
    // an already accepted event. The retry must be rejected before replay.
    for (const forgedEventId of [randomUUID(), clientEventId]) {
      const forged = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: clientThreadId,
          clientEventId: forgedEventId,
          prompt,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: prompt },
              {
                type: "source",
                kind: "mcp",
                clientId: "https://claude.ai/oauth/claude-code-client-metadata",
                clientName: "Claude Code",
              },
            ],
          },
          hasTextContent: true,
        },
        [400],
      );
      expect(forged.body).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "MCP source annotations are server-managed",
        },
      });
    }
    const launched = await waitForThreadMessages(
      actor,
      clientThreadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === clientEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const runId = userMessages(launched.events).find((message) => {
      return message.revokesEventId === clientEventId;
    })?.runId;
    if (runId === undefined) {
      throw new Error("Expected the picked input to launch a run");
    }

    const run = await api.readRun(actor, runId);
    expect(run.prompt).toBe(prompt);
    expect(run.appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(run.appendSystemPrompt).not.toContain("# Artifact Template Context");

    const messages = await waitForThreadMessages(
      actor,
      clientThreadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === clientEventId && message.runId === runId
          );
        });
      },
    );
    const userRows = userMessages(messages.events);
    expect(userRows).toHaveLength(2);
    expect(userRows).toContainEqual(
      expect.objectContaining({
        id: clientEventId,
        content: null,
      }),
    );
    expect(userRows).toContainEqual(
      expect.objectContaining({
        content: null,
        runId,
        revokesEventId: clientEventId,
      }),
    );
    const original = userRows.find((message) => {
      return message.id === clientEventId;
    });
    expect(original).toMatchObject({
      id: clientEventId,
      threadId: clientThreadId,
      eventType: "input.prompt",
      content: null,
    });
    expect(original?.runId).toBeUndefined();
    expect(original).not.toHaveProperty("revokesEventId");

    await expect(chat.readThread(actor, clientThreadId)).resolves.toStrictEqual(
      {
        lastReadAt: null,
        cancellationRecoveryPending: false,
      },
    );

    // A pre-created client thread with no runs cannot be sent into.
    const emptyClientThreadId = randomUUID();
    const created = await chat.createThread(actor, {
      agentId,
      title: "Pre-created client thread",
      clientThreadId: emptyClientThreadId,
    });
    expect(created.id).toBe(emptyClientThreadId);
    const emptyThreadSend = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "send into the pre-created thread",
        clientThreadId: emptyClientThreadId,
      },
      [400],
    );
    expectApiError(emptyThreadSend.body);
    expect(emptyThreadSend.body.error.message).toBe(
      "Client thread id is already in use",
    );
  }, 90_000);

  it("rejects unauthenticated, unknown-agent, and foreign private-agent sends", async () => {
    const unauthenticated = await chat.requestSendEvent(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Private chat-send guard agent",
      visibility: "private",
    });

    const unknownAgent = await chat.requestSendEvent(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(unknownAgent.body);
    expect(unknownAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const forbidden = await chat.requestSendEvent(
      peer,
      { agentId: agent.agentId, prompt: "hello" },
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  }, 30_000);

  it("rejects an existing-thread send naming another agent than the thread's", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const threadAgent = await bdd.createAgent(actor, {
      displayName: "Thread owner agent",
    });
    const otherAgent = await bdd.createAgent(actor, {
      displayName: "Other agent in the same org",
    });
    const thread = await chat.createThread(actor, {
      agentId: threadAgent.agentId,
      title: "Agent mismatch thread",
    });

    const mismatched = await chat.requestSendEvent(
      actor,
      {
        agentId: otherAgent.agentId,
        threadId: thread.id,
        prompt: "send through the wrong agent",
      },
      [404],
    );
    expectApiError(mismatched.body);
    expect(mismatched.body.error.message).toBe("Chat thread not found");
    const events = await chat.listThreadEvents(actor, thread.id);
    expect(events.events).toStrictEqual([]);
  }, 30_000);
});

describe("CHAT-02: interrupting active chat runs", () => {
  it("interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "long task to interrupt",
    });
    await api.heartbeatRunner(runnerGroup);
    const firstClaim = await api.claimRunnerJob(first.runId);
    context.mocks.ably.publish.mockClear();

    const peer = bdd.user({ orgId: actor.orgId });
    const foreignInterrupt = await chat.requestSendEvent(
      peer,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId.toUpperCase(),
        clientEventId: randomUUID(),
      },
      [404],
    );
    expectApiError(foreignInterrupt.body);
    expect(foreignInterrupt.body.error.message).toBe("Chat thread not found");

    const interruptId = randomUUID();
    const interrupted = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId.toUpperCase(),
        clientEventId: interruptId,
      },
      [201],
    );
    if (interrupted.status !== 201) {
      throw new Error("Expected the interrupt send to be accepted");
    }
    expect(interrupted.body.runId).toBeNull();
    await waitForRunStatus(actor, first.runId, "cancelled");
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: first.runId,
      mode: "cooperative",
    });
    await webhooks.requestAgentComplete(
      { runId: first.runId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return (
              message.eventType === "control.interrupt" &&
              message.interruptsRunId === first.runId
            );
          }) &&
          assistantMessages(items).some((message) => {
            return (
              message.eventType === "run.cancelled" &&
              message.runId === first.runId &&
              message.runLifecycleEvent === "cancelled"
            );
          })
        );
      },
    );
    const interruptRows = userMessages(messages.events).filter((message) => {
      return (
        message.eventType === "control.interrupt" &&
        message.interruptsRunId === first.runId
      );
    });
    expect(interruptRows).toHaveLength(1);
    expect(interruptRows[0]).toMatchObject({
      id: interruptId,
      content: null,
      eventType: "control.interrupt",
      interruptsRunId: first.runId,
    });
    expect(
      assistantMessages(messages.events).filter((message) => {
        return (
          message.eventType === "run.cancelled" &&
          message.runId === first.runId &&
          message.runLifecycleEvent === "cancelled"
        );
      }),
    ).toHaveLength(1);
    expect(
      assistantMessages(messages.events).filter((message) => {
        return (
          message.runId === first.runId &&
          isChatRunTerminalEventType(message.eventType)
        );
      }),
    ).toHaveLength(1);

    // Replaying the interrupt (same or fresh client id) stays idempotent.
    const replayedInterrupt = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: interruptId,
      },
      [201],
    );
    expect(replayedInterrupt.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId.toUpperCase(),
        clientEventId: randomUUID(),
      },
      [201],
    );
    const afterReplays = await chat.listThreadEvents(actor, first.threadId);
    expect(
      userMessages(afterReplays.events).filter((message) => {
        return (
          message.eventType === "control.interrupt" &&
          message.interruptsRunId === first.runId
        );
      }),
    ).toHaveLength(1);

    // A run that went terminal without an interrupt row cannot be interrupted.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "cancelled through the cancel api",
    });
    await cancelChatRun(actor, second.runId);
    const lateInterrupt = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: second.runId,
        clientEventId: randomUUID(),
      },
      [400],
    );
    expectApiError(lateInterrupt.body);
    expect(lateInterrupt.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );

    // The interrupt's client message id is burned for normal sends: the
    // conflicting send is accepted as a duplicate and enqueues nothing.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the interrupt client id",
        clientEventId: interruptId,
      },
      [201],
    );
    const afterReuse = await chat.listThreadEvents(actor, first.threadId);
    expect(
      afterReuse.events.filter((message) => {
        return JSON.stringify(message).includes(
          "reuse the interrupt client id",
        );
      }),
    ).toStrictEqual([]);

    // Neither cancelled round saved native history, so the next run replays
    // both rounds in a fresh session.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "resume after interruptions",
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain("RUN_STATUS: cancelled");
    expect(appended).toContain("User: long task to interrupt");
    expect(appended).toContain("User: cancelled through the cancel api");
    expect(appended).not.toContain("# Incomplete Rounds Context");
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: dispatch failure", () => {
  it("rejects the picked input and releases the lease when run preparation cannot configure dispatch", async () => {
    const { actor, agentId } = await entitledChatActor();
    const routeRequests = chatCallbacks.failIfChatCallbackRouteIsFetched();
    const runnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const messageId = randomUUID();

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "fail before worker start",
        clientEventId: messageId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the send to be accepted");
    }
    expect(sent.body).toStrictEqual({
      runId: null,
      threadId: sent.body.threadId,
      createdAt: expect.any(String),
    });
    const threadId = sent.body.threadId;

    // The original failure still propagates; the picked input ends rejected
    // instead of staying at the queue head, and the lease is released.
    await expect(clearAllDetached()).rejects.toThrow(
      "No executor configured: set RUNNER_DEFAULT_GROUP",
    );
    const messages = await chat.listThreadEvents(actor, threadId);
    expect(messages.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: messageId,
        error: "internal_error",
      }),
    );
    expect(messages.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "internal_error",
      }),
    );
    expect(
      messages.events.some((message) => {
        return message.runId !== undefined;
      }),
    ).toBeFalsy();
    const runs = await reads.requestListLogs(actor, { limit: 100 }, [200]);
    expect(runs.body.data).toStrictEqual([]);
    expect(routeRequests()).toBe(0);

    // The lease was released: the next input on the thread is picked
    // immediately, without waiting for lease expiry.
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
    const next = await sendChatRun(actor, {
      agentId,
      threadId,
      prompt: "send again after the rejection",
    });
    expect(next.runId).toStrictEqual(expect.any(String));
    await cancelChatRun(actor, next.runId);
  });
});

describe("CHAT-02: admission without spendable credits", () => {
  it("blocks admission with request-branded guidance through visible chat messages", async () => {
    const fixture = createPublicChatAdmissionFixture(context);
    await fixture.run(async () => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const actor = fixture.actor;
      bdd.acceptAgentStorageWrites();
      fixture.captureStorageMocks();
      const completed = await bdd.completeOnboarding(actor);
      expect(completed.status).toBe(200);
      const agent = await bdd.createAgent(actor, {
        displayName: "Suspended chat agent",
      });
      fixture.registerAgent(agent.agentId);
      await fixture.activateWithoutCredits();
      await fixture.suspend(0);

      const clientEventId = randomUUID();
      const sendBody: ChatRunSendBody = {
        agentId: agent.agentId,
        prompt: "blocked by suspended plan",
        model: "okou-1.0",
        clientEventId,
      };
      const sent = await chat.requestSendEvent(actor, sendBody, [201]);
      if (sent.status !== 201) {
        throw new Error(
          "Expected the blocked send to return 201 without a run",
        );
      }
      expect(sent.body).toStrictEqual({
        runId: null,
        threadId: sent.body.threadId,
        createdAt: expect.any(String),
      });

      // The pick rejects the input in the background.
      const messages = await waitForThreadMessages(
        actor,
        sent.body.threadId,
        (items) => {
          return assistantMessages(items).some((message) => {
            return message.eventType === "output.error";
          });
        },
      );
      const blockedUsers = userMessages(messages.events);
      expect(blockedUsers).toHaveLength(2);
      const queuedUser = blockedUsers.find((message) => {
        return (
          message.eventType === "input.prompt" && message.id === clientEventId
        );
      });
      if (!queuedUser) {
        throw new Error("Expected the original queued user message");
      }
      expect(queuedUser).toMatchObject({
        content: null,
      });
      expect(chatEventDisplayText(queuedUser)).toBe(
        "blocked by suspended plan",
      );
      expect(queuedUser.runId).toBeUndefined();
      const blockedUser = blockedUsers.find((message) => {
        return (
          message.eventType === "input.rejected" &&
          message.revokesEventId === clientEventId
        );
      });
      if (!blockedUser) {
        throw new Error("Expected an insufficient-credits replacement message");
      }
      expect(blockedUser).toMatchObject({
        content: null,
        error: "insufficient_credits",
        revokesEventId: clientEventId,
      });
      expect(chatEventDisplayText(blockedUser)).toBe(
        "blocked by suspended plan",
      );
      expect(blockedUser.runId).toBeUndefined();
      const guidance = assistantMessages(messages.events).find((message) => {
        return message.eventType === "output.error";
      });
      if (!guidance) {
        throw new Error("Expected insufficient-credits assistant guidance");
      }
      expect(guidance.content).toContain("Buy more credits");
      expect(guidance.content).toContain("https://app.okou.ai/?settings=usage");
      expect(guidance.error).toBe("insufficient_credits");

      const appended = await chat.listThreadEvents(actor, sent.body.threadId, {
        sinceEventId: queuedUser.id,
        sinceSeqId: queuedUser.seqId,
      });
      expect(appended.events).toStrictEqual([
        expect.objectContaining({
          id: blockedUser.id,
          revokesEventId: clientEventId,
          error: "insufficient_credits",
        }),
        expect.objectContaining({
          id: guidance.id,
          error: "insufficient_credits",
        }),
      ]);

      const queue = await api.readRunQueue(actor);
      expect(queue.body.concurrency.active).toBe(0);

      const retry = await chat.requestSendEvent(
        actor,
        { ...sendBody, threadId: sent.body.threadId },
        [201],
      );
      if (retry.status !== 201) {
        throw new Error("Expected the retried send to be accepted");
      }
      // The retry is accepted as a duplicate at request time and stores nothing.
      expect(retry.body).toStrictEqual({
        runId: null,
        threadId: sent.body.threadId,
        createdAt: expect.any(String),
      });
      expect(Date.parse(retry.body.createdAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(sent.body.createdAt ?? ""),
      );
      const afterRetry = await chat.listThreadEvents(actor, sent.body.threadId);
      expect(afterRetry.events).toHaveLength(3);
    });
  }, 60_000);

  it("settles a send right after cancelling a pending run with one rejection", async () => {
    const fixture = createPublicChatAdmissionFixture(context);
    await fixture.run(async () => {
      const { actor, agentId } = await fixture.createPaidNativeActor();
      const pending = await sendChatRun(actor, {
        agentId,
        prompt: "never started",
      });
      fixture.registerRun(pending.runId);
      await fixture.suspend(20_000);
      // The cancel's slot hand-off is left running: it may pick and reject the
      // next send's input before the send's own background pick does.
      await cancelChatRun(actor, pending.runId);

      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: pending.threadId,
          prompt: "sent right after the cancel",
          clientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the send to settle as a rejection");
      }
      expect(sent.body.runId).toBeNull();

      await waitForThreadMessages(actor, pending.threadId, (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.rejected" &&
            message.revokesEventId === clientEventId
          );
        });
      });
      await flushWaitUntilForTest();
      const settled = await chat.listThreadEvents(actor, pending.threadId);
      expect(
        userMessages(settled.events).filter((message) => {
          return (
            message.eventType === "input.rejected" &&
            message.revokesEventId === clientEventId
          );
        }),
      ).toStrictEqual([
        expect.objectContaining({ error: "insufficient_credits" }),
      ]);
    });
  }, 60_000);
});

describe("CHAT-02: Okou Mail link delivery", () => {
  it("delivers a linked Gmail draft exactly once through the agent reply", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockGmailConnectorOAuth({
      accessToken: "gmail-agent-reply-token",
      email: "sender@example.com",
    });
    const oauth = await connectors.startOauth(actor, "gmail", "oauth");
    const oauthState = new URL(oauth.authorizationUrl).searchParams.get(
      "state",
    );
    if (!oauthState) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "gmail-agent-reply-code",
      state: oauthState,
    });
    await api.enableAgentConnectors(actor, agentId, ["gmail"]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Create a Gmail draft and let me review it",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const gmailDraftId = "r-agent-reply-draft";
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/:draftId",
        ({ params, request }) => {
          expect(params.draftId).toBe(gmailDraftId);
          expect(request.headers.get("authorization")).toBe(
            "Bearer gmail-agent-reply-token",
          );
          expect(new URL(request.url).searchParams.get("format")).toBe("full");
          return HttpResponse.json({
            id: gmailDraftId,
            message: {
              id: "gmail-agent-reply-message",
              threadId: "gmail-agent-reply-thread",
              payload: {
                partId: "",
                mimeType: "text/plain",
                filename: "",
                headers: [
                  { name: "From", value: "Sender <sender@example.com>" },
                  { name: "To", value: "recipient@example.com" },
                  { name: "Subject", value: "Review this draft" },
                ],
                body: { size: 9, data: "TWFpbCBib2R5" },
              },
            },
          });
        },
      ),
    );

    const linked = await accept(
      setupApp({ context, routes: mailRoutes })(mailContract).linkDraft({
        headers: {
          authorization: `Bearer ${okouTokenFromClaim(claim)}`,
        },
        body: {
          threadId: run.threadId,
          agentId,
          gmailDraftId,
        },
      }),
      [200],
    );
    const beforeReply = await chat.listThreadEvents(actor, run.threadId);
    expect(
      assistantMessages(beforeReply.events).filter((message) => {
        return message.content?.includes(linked.body.mailDraftUrl);
      }),
    ).toHaveLength(0);

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, linked.body.mailDraftUrl),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    const completed = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return assistantMessages(messages).some((message) => {
          return message.content === linked.body.mailDraftUrl;
        });
      },
    );
    expect(
      assistantMessages(completed.events).filter((message) => {
        return message.content?.includes(linked.body.mailDraftUrl);
      }),
    ).toStrictEqual([
      expect.objectContaining({
        content: linked.body.mailDraftUrl,
        runId: run.runId,
      }),
    ]);
  });
});

describe("CHAT-02: network body capture", () => {
  it("carries a send's network body capture into the run the pick launches", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();

    const captured = await sendChatRun(actor, {
      agentId,
      prompt: "capture this run's network bodies",
      captureNetworkBodies: true,
    });
    const capturedClaim = await claimChatRun(runnerGroup, captured.runId);
    expect(capturedClaim.claim.captureNetworkBodies).toBeTruthy();
    await cancelChatRun(actor, captured.runId, capturedClaim.sandboxHeaders);

    const plain = await sendChatRun(actor, {
      agentId,
      prompt: "do not capture network bodies",
    });
    const plainClaim = await claimChatRun(runnerGroup, plain.runId);
    expect(plainClaim.claim.captureNetworkBodies).toBeFalsy();
    await cancelChatRun(actor, plain.runId, plainClaim.sandboxHeaders);
  });
});
