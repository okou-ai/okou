import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { readCanonicalChatEventStorageFixture } from "../../../test-fixtures/chat-events";
import { overrideCanonicalAgentAuthorityFixture } from "../../../test-fixtures/canonical-agent-authority";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import {
  createUnassociatedThreadBoundAgentRunFixture,
  createUnassociatedThreadBoundAgentRunsServiceFixture,
  holdAgentRunPiExecutionSnapshotFixture,
} from "../../../test-fixtures/thread-bound-run-admission";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mailRoutes } from "../mail";
import { expectApiError } from "./helpers/api-bdd";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { chatEventDisplayText } from "./helpers/chat-event";
import { readThreadSessionBinding } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  type ChatRunSendBody,
  okouTokenFromClaim,
  assistantMessages,
  userMessages,
  assistantEvent,
  requireOrgId,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  api,
  chat,
  webhooks,
  chatCallbacks,
  connectors,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  chatEventsClient,
  sessionHeaders,
} = createChatEventsFixture(context);

type FailedMessage = Extract<ChatEvent, { eventType: "run.failed" }>;

describe("CHAT-02: thread run admission invariant", () => {
  it("rejects thread-bound run creation without a queue association at both service boundaries", async () => {
    await expect(
      createUnassociatedThreadBoundAgentRunsServiceFixture(),
    ).rejects.toThrow(
      "Thread-bound agent run requires a queue-first association",
    );

    await expect(
      createUnassociatedThreadBoundAgentRunFixture(),
    ).rejects.toThrow("Thread-bound run requires a queue-first association");

    await expect(
      createUnassociatedThreadBoundAgentRunsServiceFixture(""),
    ).rejects.toThrow(
      "Thread-bound agent run requires a queue-first association",
    );

    await expect(
      createUnassociatedThreadBoundAgentRunFixture(""),
    ).rejects.toThrow("Thread-bound run requires a queue-first association");
  });
});

describe("CHAT-02: web chat send and client ids", () => {
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
    if (first.status !== 201 || first.body.runId === null) {
      throw new Error("Expected the first chat send to create a run");
    }
    expect(first.body.threadId).toBe(clientThreadId);
    expect(first.body.status).toBe("pending");
    const runId = first.body.runId;
    const pendingBinding = await readThreadSessionBinding(
      context,
      clientThreadId,
    );
    expect(pendingBinding.agent_session_run_id).toBe(runId);
    expect(pendingBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(pendingBinding.run_session_id).toBe(pendingBinding.agent_session_id);

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

  it("rejects a request-scoped Agent observation after final ownership changes", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const nextOwner = bdd.user({ orgId });
    const gate = holdAgentRunPiExecutionSnapshotFixture({
      userId: actor.userId,
      orgId,
      signal: context.signal,
    });
    onTestFinished(gate.release);
    const clientThreadId = randomUUID();
    const prompt = "reject stale request-scoped Agent ownership";

    const sent = chat.requestSendEvent(
      actor,
      { agentId, clientThreadId, prompt },
      [409],
    );
    await expect(gate.arrival).resolves.toMatchObject({
      userId: actor.userId,
      orgId,
    });
    // Agent ownership has no production mutation API. This test-only override
    // models the otherwise-unconstructible transfer after request observation
    // but before the transaction-authoritative compute admission recheck.
    await overrideCanonicalAgentAuthorityFixture({
      agentId,
      override: {
        owner: nextOwner.userId,
        displayName: "Transferred request observation Agent",
        visibility: "public",
        updatedAt: nowDate(),
      },
      signal: context.signal,
    });
    gate.release();

    const rejected = await sent;
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe("Run admission is unavailable");
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.filter((run) => {
        return run.prompt === prompt;
      }),
    ).toHaveLength(0);
    // The rejection must claim no input. Queue-first keeps the user's message
    // visible and unclaimed, like every other blocked admission, and releases
    // the queue head through a revocation instead of stranding it.
    const events = await chat.listThreadEvents(actor, clientThreadId);
    const queued = userMessages(events.events).filter((event) => {
      return chatEventDisplayText(event) === prompt;
    });
    expect(queued).toHaveLength(1);
    const queuedEvent = queued[0];
    expect(queuedEvent).toMatchObject({
      eventType: "input.prompt",
      content: null,
    });
    expect(queuedEvent?.runId).toBeUndefined();
    expect(
      events.events.filter((event) => {
        return (
          event.eventType === "control.revoke" &&
          event.revokesEventId === queuedEvent?.id
        );
      }),
    ).toHaveLength(1);
  }, 90_000);

  it("passes request-scoped network body capture into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const captured = await sendChatRun(actor, {
      agentId,
      prompt: "capture this run's network bodies",
      captureNetworkBodies: true,
    });
    const capturedClaim = await claimChatRun(runnerGroup, captured.runId);
    expect(capturedClaim.claim.captureNetworkBodies).toBeTruthy();
    await cancelChatRun(actor, captured.runId);

    const ordinary = await sendChatRun(actor, {
      agentId,
      prompt: "keep ordinary network logging metadata-only",
    });
    const ordinaryClaim = await claimChatRun(runnerGroup, ordinary.runId);
    expect(ordinaryClaim.claim.captureNetworkBodies).toBeUndefined();
    await cancelChatRun(actor, ordinary.runId);
  });
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
    expect(interruptRows[0]).toMatchObject({ id: interruptId, content: null });
    expect(interruptRows[0]).not.toHaveProperty("runId");
    const [storedInterrupt] = await readCanonicalChatEventStorageFixture([
      interruptId,
    ]);
    expect(storedInterrupt).toMatchObject({
      payload: null,
      runId: first.runId,
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

    // The interrupt's client message id is burned for normal sends.
    const reusedInterruptId = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the interrupt client id",
        clientEventId: interruptId,
      },
      [409],
    );
    expectApiError(reusedInterruptId.body);
    expect(reusedInterruptId.body.error.message).toBe(
      "clientEventId is already in use",
    );

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
  it("fails the run and delivers the terminal chat callback when dispatch cannot start", async () => {
    const { actor, agentId } = await entitledChatActor();
    const routeRequests = chatCallbacks.failIfChatCallbackRouteIsFetched();
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
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to still create a run");
    }
    expect(sent.body.status).toBe("failed");
    await flushWaitUntilForTest();

    const run = await api.readRun(actor, sent.body.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("RUNNER_DEFAULT_GROUP");
    await expect(
      readThreadSessionBinding(context, sent.body.threadId),
    ).resolves.toMatchObject({
      agent_session_id: null,
      agent_session_run_id: null,
      run_session_id: null,
    });

    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return (
            message.eventType === "run.failed" &&
            message.runId === sent.body.runId &&
            message.runLifecycleEvent === "failed"
          );
        });
      },
    );
    const failedMarker = assistantMessages(messages.events).find(
      (message): message is FailedMessage => {
        return (
          message.eventType === "run.failed" &&
          message.runId === sent.body.runId &&
          message.runLifecycleEvent === "failed"
        );
      },
    );
    if (!failedMarker) {
      throw new Error("Expected a failed lifecycle marker");
    }
    expect(failedMarker.error).toStrictEqual(expect.any(String));
    expect(userMessages(messages.events)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
        runId: sent.body.runId,
      }),
    );
    expect(
      userMessages(messages.events).some((message) => {
        return (
          message.revokesEventId === messageId &&
          chatEventDisplayText(message) === "fail before worker start"
        );
      }),
    ).toBeTruthy();
    const replay = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "fail before worker start",
        clientEventId: messageId,
      },
      [201],
    );
    expect(replay.body).toMatchObject({
      runId: sent.body.runId,
      threadId: sent.body.threadId,
      status: "failed",
    });
    await flushWaitUntilForTest();
    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).not.toContainEqual(
      expect.objectContaining({ runId: sent.body.runId }),
    );
    await api.requestClaimRunnerJob(true, sent.body.runId, [404]);
    expect(routeRequests()).toBe(0);
  }, 60_000);
});

describe("CHAT-02: admission without spendable credits", () => {
  it("blocks admission with request-branded guidance through visible chat messages", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    const agent = await bdd.createAgent(actor, {
      displayName: "Pro-suspend chat agent",
    });
    if (!actor.orgId) {
      throw new Error("Expected pro-suspend chat actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: true,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const clientEventId = randomUUID();
    const sendBody: ChatRunSendBody = {
      agentId: agent.agentId,
      prompt: "blocked by suspended plan",
      model: "claude-sonnet-5",
      clientEventId,
    };
    const sent = await chat.requestSendEvent(actor, sendBody, [201]);
    if (sent.status !== 201) {
      throw new Error("Expected the blocked send to return 201 without a run");
    }
    expect(sent.body.runId).toBeNull();

    const messages = await chat.listThreadEvents(actor, sent.body.threadId);
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
    expect(chatEventDisplayText(queuedUser)).toBe("blocked by suspended plan");
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
    expect(chatEventDisplayText(blockedUser)).toBe("blocked by suspended plan");
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
    expect(queue.body.queue).toHaveLength(0);
    expect(queue.body.concurrency.active).toBe(0);

    const retry = await chat.requestSendEvent(
      actor,
      { ...sendBody, threadId: sent.body.threadId },
      [201],
    );
    expect(retry.body).toStrictEqual(sent.body);
    const afterRetry = await chat.listThreadEvents(actor, sent.body.threadId);
    expect(afterRetry.events).toHaveLength(3);
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
