import { randomUUID } from "node:crypto";
import type {
  UserMessageDocument,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import {
  holdChatEventQueueItemFixture,
  holdOrgAdmissionLockFixture,
  replayPendingChatInputQueueEventFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { readAgentRunState$ } from "./helpers/agent-run-callback";
import { expectApiError } from "./helpers/api-bdd";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readRunAutonomyBudgetFixture,
  readThreadSessionBinding,
  setRunAutonomyBudgetFixture,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
  type PromptMessage,
  okouTokenFromClaim,
  userMessages,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  runStateStore,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunUserMessage,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  upsertOrgModelProvider,
  requestSendEventWithBearer,
} = createChatEventsFixture(context);

describe("CHAT-02: shared user message queue", () => {
  it("dispatches idle-thread sends by appending a run-associated replacement", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const messageId = randomUUID();
    const referencedThreadId = randomUUID();
    const userMessage: UserMessageDocument = {
      version: 1,
      parts: [
        { type: "text", text: "queue-first " },
        {
          type: "chat_thread",
          threadId: referencedThreadId,
          titleSnapshot: "direct dispatch",
        },
        { type: "model", selectedModel: "gpt-5.6-sol" },
      ],
    };
    const apiStartedAt = now();
    const sent = await withMockNowForTest(apiStartedAt, async () => {
      return await chat.requestSendEvent(
        actor,
        {
          agentId,
          prompt: "queue-first direct dispatch",
          userMessage,
          clientEventId: messageId,
        },
        [201],
      );
    });
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected an idle-thread queue-first send to dispatch");
    }
    const runId = sent.body.runId;

    // The queued row stays immutable. Claiming appends the run-associated
    // replacement and links it back to the queued row.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId && message.runId === runId
          );
        });
      },
    );
    const rows = userMessages(messages.events);
    expect(rows).toHaveLength(2);
    const claimed = rows.find((message) => {
      return message.revokesEventId === messageId;
    });
    expect(claimed).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts.filter((part) => {
            return part.type !== "model";
          }),
          {
            type: "model",
            selectedModel: "claude-sonnet-5",
          },
        ],
      },
      runId,
      revokesEventId: messageId,
    });
    expect(claimed?.id).not.toBe(messageId);
    const queued = rows.find((message) => {
      return message.id === messageId;
    });
    if (!queued) {
      throw new Error("Expected the queued message");
    }
    expect(queued).toMatchObject({
      id: messageId,
      content: null,
      userMessage,
    });
    expect(queued.runId).toBeUndefined();

    const replay = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "queue-first direct dispatch",
        clientEventId: messageId,
      },
      [201],
    );
    expect(replay.body).toStrictEqual(sent.body);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${sent.body.threadId}`;
        });
      })
      .toBe(true);

    const claimedRun = await claimChatRun(runnerGroup, runId);
    expect(claimedRun.claim.apiStartTime).toBe(apiStartedAt);
    expect(claimedRun.claim.prompt).toBe(
      `queue-first [direct dispatch](/chats/${referencedThreadId})`,
    );

    await cancelChatRun(actor, runId);
  }, 90_000);

  it("persists user-forwarded run provenance across chat threads", async () => {
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "source content selected for forwarding",
    });
    await setRunAutonomyBudgetFixture(context, source.runId, 0);
    const targetThread = await chat.createThread(actor, { agentId });
    const forwardedEventId = randomUUID();
    const forwarded = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: targetThread.id,
        clientEventId: forwardedEventId,
        prompt: "Forwarded content:\n\n> deployment window is fifteen minutes",
        sourceRunId: source.runId,
      },
      [201],
    );
    if (forwarded.status !== 201 || !forwarded.body.runId) {
      throw new Error("Expected the forwarded prompt to launch a run");
    }
    const forwardedRunId = forwarded.body.runId;

    const targetMessages = await waitForThreadMessages(
      actor,
      targetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === forwardedEventId;
        });
      },
    );
    const forwardedInput = userMessages(targetMessages.events).find(
      (event): event is PromptMessage => {
        return (
          event.eventType === "input.prompt" && event.id === forwardedEventId
        );
      },
    );
    expect(forwardedInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "New thread",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });

    const forwardedRun = await api.readRun(actor, forwardedRunId);
    const forwardedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: forwardedRunId,
      },
      context.signal,
    );
    expect(forwardedState.agent_run).toMatchObject({ triggerSource: "web" });
    const forwardedSystemPrompt = forwardedRun.appendSystemPrompt ?? "";
    expect(forwardedSystemPrompt).toContain("# This Run's Trigger");
    expect(forwardedSystemPrompt).toContain(
      "was sent by a person who forwarded selected content",
    );
    expect(forwardedSystemPrompt).not.toContain(
      "A person did not type it here.",
    );
    expect(forwardedSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(forwardedSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    await expect(
      readRunAutonomyBudgetFixture(context, source.runId),
    ).resolves.toBe(0);
    await expect(
      readRunAutonomyBudgetFixture(context, forwardedRunId),
    ).resolves.toBe(10);

    const unknownSource = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: targetThread.id,
        clientEventId: randomUUID(),
        prompt: "forwarded with unknown provenance",
        sourceRunId: randomUUID(),
      },
      [400],
    );
    expect(unknownSource).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Forward source run not found",
        },
      },
    });

    await cancelChatRun(actor, forwardedRunId);
    await cancelChatRun(actor, source.runId);
  }, 90_000);

  it("persists agent-run provenance for messages sent across chat threads", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const firstTargetThread = await chat.createThread(actor, { agentId });
    const secondTargetThread = await chat.createThread(actor, { agentId });

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate work to other chat threads",
    });
    const { claim: sourceClaim, sandboxHeaders: sourceSandboxHeaders } =
      await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim);

    const firstEventId = randomUUID();
    const firstSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: firstEventId,
        threadId: firstTargetThread.id,
        prompt: "first delegated prompt",
      },
      [201],
    );
    if (firstSend.status !== 201) {
      throw new Error("Expected the first delegated prompt to be accepted");
    }
    if (!firstSend.body.runId) {
      throw new Error("Expected the first delegated prompt to launch a run");
    }
    const firstTargetRunId = firstSend.body.runId;
    await expect(
      readRunAutonomyBudgetFixture(context, source.runId),
    ).resolves.toBe(10);
    await expect(
      readRunAutonomyBudgetFixture(context, firstTargetRunId),
    ).resolves.toBe(9);
    const firstTargetRun = await api.readRun(actor, firstTargetRunId);
    const firstTargetSystemPrompt = firstTargetRun.appendSystemPrompt ?? "";
    expect(firstTargetSystemPrompt).toContain("# This Run's Trigger");
    expect(firstTargetSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(firstTargetSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    expect(firstTargetSystemPrompt).toContain(`SOURCE_AGENT_ID: ${agentId}`);
    expect(firstTargetSystemPrompt).toContain(
      "SOURCE_THREAD_TITLE: New thread",
    );
    expect(firstTargetSystemPrompt).toContain(
      `okou chat messages --thread-id ${source.threadId}`,
    );
    expect(firstTargetSystemPrompt).toContain(
      `okou search "${source.runId}" --source agent-session`,
    );
    const sourceRun = await api.readRun(actor, source.runId);
    expect(sourceRun.appendSystemPrompt ?? "").not.toContain(
      "# This Run's Trigger",
    );
    const firstMessages = await waitForThreadMessages(
      actor,
      firstTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === firstEventId;
        });
      },
    );
    const firstInput = userMessages(firstMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === firstEventId;
      },
    );
    expect(firstInput).toMatchObject({
      eventType: "input.prompt",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "first delegated prompt" },
          {
            type: "source",
            kind: "agent",
            runId: source.runId,
            threadId: source.threadId,
            agentId,
            titleSnapshot: "New thread",
            href: `/chats/${source.threadId}#run-${source.runId}`,
          },
        ],
      },
    });
    expect(firstInput?.runId).toBeUndefined();
    await chat.renameThread(actor, source.threadId, "Delegation source");
    const secondEventId = randomUUID();
    const secondSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: secondEventId,
        threadId: secondTargetThread.id,
        prompt: "second delegated prompt",
      },
      [201],
    );
    if (secondSend.status !== 201) {
      throw new Error("Expected the second delegated prompt to be accepted");
    }
    if (!secondSend.body.runId) {
      throw new Error("Expected the second delegated prompt to queue a run");
    }
    const secondTargetRunId = secondSend.body.runId;
    expect(secondSend.body.status).toBe("queued");
    await expect(
      readRunAutonomyBudgetFixture(context, secondTargetRunId),
    ).resolves.toBe(9);
    const secondMessages = await waitForThreadMessages(
      actor,
      secondTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === secondEventId;
        });
      },
    );
    const secondInput = userMessages(secondMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === secondEventId;
      },
    );
    expect(secondInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "Delegation source",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });

    await chat.renameThread(actor, source.threadId, "now");
    const nowTargetThread = await chat.createThread(actor, { agentId });
    const nowEventId = randomUUID();
    const nowSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: nowEventId,
        threadId: nowTargetThread.id,
        prompt: "delegated prompt from a placeholder thread title",
      },
      [201],
    );
    if (nowSend.status !== 201) {
      throw new Error("Expected the placeholder-title prompt to be accepted");
    }
    if (!nowSend.body.runId) {
      throw new Error("Expected the placeholder-title prompt to queue a run");
    }
    const nowTargetRunId = nowSend.body.runId;
    const nowMessages = await waitForThreadMessages(
      actor,
      nowTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === nowEventId;
        });
      },
    );
    const nowInput = userMessages(nowMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === nowEventId;
      },
    );
    expect(nowInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "New thread",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });
    const forgedTargetThread = await chat.createThread(actor, { agentId });
    const forgedEventId = randomUUID();
    const forged = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: forgedEventId,
        threadId: forgedTargetThread.id,
        prompt: "forged provenance",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "forged provenance" },
            {
              type: "source",
              kind: "agent",
              runId: randomUUID(),
              threadId: randomUUID(),
              agentId: randomUUID(),
              titleSnapshot: "Forged source",
              href: `/chats/${randomUUID()}#run-${randomUUID()}`,
            },
          ],
        },
      },
      [400],
    );
    expect(forged).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Agent source annotations are server-managed",
        },
      },
    });
    const messagesAfterForgedSend = await chat.listThreadEvents(
      actor,
      forgedTargetThread.id,
    );
    expect(messagesAfterForgedSend.events).not.toContainEqual(
      expect.objectContaining({ id: forgedEventId }),
    );

    await cancelChatRun(actor, nowTargetRunId);
    await cancelChatRun(actor, secondTargetRunId);
    await cancelChatRun(actor, firstTargetRunId);
    await cancelChatRun(actor, source.runId, sourceSandboxHeaders);
  }, 90_000);

  it("keeps Web context and tools for agent prompts sent into existing threads", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate into existing chat threads",
    });
    const { claim: sourceClaim, sandboxHeaders: sourceSandboxHeaders } =
      await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim);

    const rotatedAnchorPrompt = "prior Web round before an agent rotation";
    const rotatedAnchor = await sendChatRun(actor, {
      agentId,
      prompt: rotatedAnchorPrompt,
      model: "claude-sonnet-5",
    });
    const rotatedAnchorClaim = await claimChatRun(
      runnerGroup,
      rotatedAnchor.runId,
    );
    const originalBinding = await readThreadSessionBinding(
      context,
      rotatedAnchor.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the Web anchor to bind a session");
    }

    const { providerId: codexProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "agent-web-semantics-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);
    await chat.updateThreadModelSelection(
      actor,
      rotatedAnchor.threadId,
      "gpt-5.6-terra",
    );

    const rotatedEventId = randomUUID();
    const rotatedQueued = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: rotatedEventId,
        threadId: rotatedAnchor.threadId,
        prompt: "agent prompt after the Web session rotates",
      },
      [201],
    );
    if (rotatedQueued.status !== 201) {
      throw new Error("Expected the rotated agent prompt to queue");
    }
    expect(rotatedQueued.body.runId).toBeNull();

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(
      rotatedAnchor.runId,
      rotatedAnchorClaim.sandboxHeaders,
    );
    const rotatedMessages = await waitForThreadMessages(
      actor,
      rotatedAnchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === rotatedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const rotatedRunId = userMessages(rotatedMessages.events).find(
      (message) => {
        return message.revokesEventId === rotatedEventId;
      },
    )?.runId;
    if (!rotatedRunId) {
      throw new Error("Expected the rotated agent prompt to be promoted");
    }
    const rotatedRun = await api.readRun(actor, rotatedRunId);
    const rotatedSystemPrompt = rotatedRun.appendSystemPrompt ?? "";
    const rotatedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: rotatedRunId,
      },
      context.signal,
    );
    expect(rotatedState.agent_run).toMatchObject({ triggerSource: "agent" });
    expect(rotatedSystemPrompt).toContain("# Web Chat Run Context");
    expect(rotatedSystemPrompt).toContain("# This Run's Trigger");
    expect(rotatedSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(rotatedSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    expect(rotatedSystemPrompt).toContain(rotatedAnchorPrompt);
    expect(rotatedSystemPrompt).not.toContain("# Incomplete Rounds Context");
    expect(rotatedSystemPrompt).toContain("Web chat files: use");
    expect(rotatedSystemPrompt).toContain(
      "Cross-integration messages from web chat",
    );
    expect(rotatedSystemPrompt).toContain(
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    );
    const rotatedBinding = await readThreadSessionBinding(
      context,
      rotatedAnchor.threadId,
    );
    expect(rotatedBinding.agent_session_id).not.toBe(
      originalBinding.agent_session_id,
    );
    const rotatedClaim = await claimChatRun(runnerGroup, rotatedRunId);
    expect(rotatedClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, rotatedRunId, rotatedClaim.sandboxHeaders);

    const incompletePrompt = "failed Web round before an agent retry";
    const incomplete = await sendChatRun(actor, {
      agentId,
      prompt: incompletePrompt,
    });
    const incompleteClaim = await claimChatRun(runnerGroup, incomplete.runId);
    const incompleteEventId = randomUUID();
    const incompleteQueued = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: incompleteEventId,
        threadId: incomplete.threadId,
        prompt: "agent prompt after an incomplete Web round",
      },
      [201],
    );
    if (incompleteQueued.status !== 201) {
      throw new Error("Expected the incomplete agent prompt to queue");
    }
    expect(incompleteQueued.body.runId).toBeNull();

    await failChatRun(
      incomplete.runId,
      incompleteClaim.sandboxHeaders,
      "expected incomplete Web round",
    );
    const incompleteMessages = await waitForThreadMessages(
      actor,
      incomplete.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === incompleteEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const incompleteRunId = userMessages(incompleteMessages.events).find(
      (message) => {
        return message.revokesEventId === incompleteEventId;
      },
    )?.runId;
    if (!incompleteRunId) {
      throw new Error("Expected the incomplete agent prompt to be promoted");
    }
    const incompleteRun = await api.readRun(actor, incompleteRunId);
    const incompleteSystemPrompt = incompleteRun.appendSystemPrompt ?? "";
    const incompleteState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: incompleteRunId,
      },
      context.signal,
    );
    expect(incompleteState.agent_run).toMatchObject({ triggerSource: "agent" });
    expect(incompleteSystemPrompt).toContain("# Web Chat Run Context");
    expect(incompleteSystemPrompt).toContain(incompletePrompt);
    expect(incompleteSystemPrompt).not.toContain("# Incomplete Rounds Context");
    expect(incompleteSystemPrompt).toContain("Web chat files: use");
    const promotedIncompleteClaim = await claimChatRun(
      runnerGroup,
      incompleteRunId,
    );
    expect(promotedIncompleteClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(
      actor,
      incompleteRunId,
      promotedIncompleteClaim.sandboxHeaders,
    );
    await cancelChatRun(actor, source.runId, sourceSandboxHeaders);
  }, 90_000);

  it("blocks cross-thread delegation from a zero-budget run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const target = await chat.createThread(actor, { agentId });
    const blockedTarget = await chat.createThread(actor, { agentId });
    const root = await sendChatRun(actor, {
      agentId,
      prompt: "start bounded delegation",
    });
    const rootClaim = await claimChatRun(runnerGroup, root.runId);
    await setRunAutonomyBudgetFixture(context, root.runId, 1);

    const delegated = await requestSendEventWithBearer(
      okouTokenFromClaim(rootClaim.claim),
      {
        agentId,
        clientEventId: randomUUID(),
        threadId: target.id,
        prompt: "last allowed delegation",
      },
      [201],
    );
    if (delegated.status !== 201 || delegated.body.runId === null) {
      throw new Error("Expected the last allowed delegation to create a run");
    }
    await expect(
      readRunAutonomyBudgetFixture(context, delegated.body.runId),
    ).resolves.toBe(0);

    await completeChatRunOk(root.runId, rootClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const delegatedClaim = await claimChatRun(
      runnerGroup,
      delegated.body.runId,
    );

    const blockedEventId = randomUUID();
    const blocked = await requestSendEventWithBearer(
      okouTokenFromClaim(delegatedClaim.claim),
      {
        agentId,
        clientEventId: blockedEventId,
        threadId: blockedTarget.id,
        prompt: "delegation beyond the limit",
      },
      [409],
    );
    expect(blocked).toMatchObject({
      status: 409,
      body: {
        error: { code: "AUTONOMY_BUDGET_EXHAUSTED" },
      },
    });
    const targetMessages = await chat.listThreadEvents(actor, blockedTarget.id);
    expect(targetMessages.events).not.toContainEqual(
      expect.objectContaining({ id: blockedEventId }),
    );

    await completeChatRunOk(
      delegated.body.runId,
      delegatedClaim.sandboxHeaders,
    );
    await flushWaitUntilForTest();
  }, 90_000);

  it("derives real-agent preview mode when queued messages are claimed", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const actorWithOrg = { ...actor, orgId: actor.orgId };
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "preview override queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const previewMessageId = randomUUID();
    const previewFileId = randomUUID();
    chat.mockCompletedUploadObject(
      actor,
      previewFileId,
      "preview-notes.txt",
      18,
    );
    const previewQueued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued real-agent preview run",
        clientEventId: previewMessageId,
        realAgentInPreview: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: previewFileId,
              filenameSnapshot: "preview-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "queued real-agent preview run" },
          ],
        },
      },
      [201],
    );
    expect(previewQueued.body).toMatchObject({ runId: null });
    const replayedPreviewMessageId = randomUUID();
    await replayPendingChatInputQueueEventFixture({
      eventId: previewMessageId,
      replacementId: replayedPreviewMessageId,
    });
    const mockMessageId = randomUUID();
    const mockQueued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued preview mock run",
        clientEventId: mockMessageId,
        realAgentInPreview: true,
      },
      [201],
    );
    expect(mockQueued.body).toMatchObject({ runId: null });
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: true,
    });

    // Terminal callbacks and the cleanup safety sweep use the same queued
    // auto-send builder; finishing the anchor guarantees that builder owns both.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const previewMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === replayedPreviewMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const previewRunId = userMessages(previewMessages.events).find(
      (message) => {
        return message.revokesEventId === replayedPreviewMessageId;
      },
    )?.runId;
    if (!previewRunId) {
      throw new Error("Expected the preview override message to auto-send");
    }

    const previewClaim = await claimChatRun(runnerGroup, previewRunId);
    expect(previewClaim.claim.prompt).toContain(
      "queued real-agent preview run",
    );
    expect(previewClaim.claim.prompt).toContain(`[ID] ${previewFileId}`);
    expect(previewClaim.claim.realAgentInPreview).toBeTruthy();
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });
    await cancelChatRun(actor, previewRunId, previewClaim.sandboxHeaders);

    const mockMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === mockMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const mockRunId = userMessages(mockMessages.events).find((message) => {
      return message.revokesEventId === mockMessageId;
    })?.runId;
    if (!mockRunId) {
      throw new Error("Expected the default preview message to auto-send");
    }

    const mockClaim = await claimChatRun(runnerGroup, mockRunId);
    expect(mockClaim.claim.prompt).toBe("queued preview mock run");
    expect(mockClaim.claim.realAgentInPreview).toBeUndefined();
    await cancelChatRun(actor, mockRunId);
  }, 90_000);

  it("projects additional info and inline templates into queued web launch material", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "inline-template queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const queuedMessageId = randomUUID();
    const queuedUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "additional_info",
          text: "Create an image.\nAspect ratio: 1:1.",
        },
        { type: "text", text: "Restyle with " },
        {
          type: "template",
          titleSnapshot: style.title,
          template: {
            type: "illustration",
            selection: { illustrationStyleId: style.illustrationStyleId },
          },
        },
        { type: "text", text: " at claim" },
      ],
    };
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued inline template projection",
        userMessage: queuedUserMessage,
        clientEventId: queuedMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    // The terminal callback acknowledges before it drains the queue, and it
    // reports the template usage only after the auto-sent run is already
    // visible. Settle that background work so the assertions below observe the
    // finished dispatch instead of a half-built one.
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const queuedRunId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    })?.runId;
    if (!queuedRunId) {
      throw new Error("Expected the queued template message to auto-send");
    }

    const run = await api.readRun(actor, queuedRunId);
    const inlineMarker = `[Template #1: ${style.title} (illustration)]`;
    expect(run.prompt).toBe(
      `Create an image.\nAspect ratio: 1:1.\n\nRestyle with ${inlineMarker} at claim`,
    );
    const webPrompt = [
      "# Current Integration\nYou are currently running inside: Web",
      "You are communicating with the user through the web chat UI.",
    ].join("\n\n");
    expect(run.appendSystemPrompt).toContain(webPrompt);
    expect(run.appendSystemPrompt).toContain("# This Chat Thread");
    expect(run.appendSystemPrompt).toContain(
      `- CHAT_THREAD_ID: ${anchor.threadId}`,
    );
    expect(run.appendSystemPrompt).toContain("# Inline Templates");
    expect(run.appendSystemPrompt).toContain(style.illustrationStyleId);

    const queuedClaim = await claimChatRun(runnerGroup, queuedRunId);
    expect(queuedClaim.claim.prompt).toBe(run.prompt);
    expect(queuedClaim.claim.appendSystemPrompt).toBe(run.appendSystemPrompt);
    await cancelChatRun(actor, queuedRunId, queuedClaim.sandboxHeaders);
  }, 90_000);

  it("appends a claimed queued message after messages that are still queued", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "multiple queue order anchor",
    });

    const firstId = randomUUID();
    const firstPrompt = "first queued transcript message";
    const first = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: firstPrompt,
        clientEventId: firstId,
      },
      [201],
    );
    expect(first.body).toMatchObject({ runId: null });

    const secondId = randomUUID();
    const secondPrompt = "second queued transcript message";
    const second = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: secondPrompt,
        clientEventId: secondId,
      },
      [201],
    );
    expect(second.body).toMatchObject({ runId: null });

    await cancelChatRun(actor, anchor.runId);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === firstId && message.runId !== undefined
          );
        });
      },
    );
    const users = userMessages(messages.events);
    const firstOriginal = users.find((message) => {
      return message.id === firstId;
    });
    const firstClaimed = users.find((message) => {
      return message.revokesEventId === firstId;
    });
    if (!firstOriginal || !firstClaimed?.runId) {
      throw new Error("Expected the first queued message to be claimed");
    }
    expect(Date.parse(firstClaimed.createdAt)).toBeGreaterThan(
      Date.parse(firstOriginal.createdAt),
    );

    const replacedIds = new Set(
      users.flatMap((message) => {
        return message.revokesEventId ? [message.revokesEventId] : [];
      }),
    );
    const visibleQueuedPrompts = users
      .filter((message) => {
        return (
          !replacedIds.has(message.id) &&
          (chatEventDisplayText(message) === firstPrompt ||
            chatEventDisplayText(message) === secondPrompt)
        );
      })
      .map((message) => {
        return chatEventDisplayText(message);
      });
    expect(visibleQueuedPrompts).toStrictEqual([secondPrompt, firstPrompt]);

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: secondId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    await cancelChatRun(actor, firstClaimed.runId);
  }, 90_000);

  it("dispatches an idle send while thread-list publication is pending", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const publicationStarted = createDeferredPromise<void>(context.signal);
    const releasePublication = createDeferredPromise<void>(context.signal);
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "threadListChanged") {
        if (!publicationStarted.settled()) {
          publicationStarted.resolve(undefined);
        }
        return releasePublication.promise;
      }
      return Promise.resolve(undefined);
    });

    const prompt = "dispatch while thread list publication is pending";
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt,
        clientEventId: randomUUID(),
      },
      [201],
    );
    let sendSettled = false;
    const sendOutcome = send.then(
      (value) => {
        sendSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        sendSettled = true;
        return { ok: false as const, error };
      },
    );
    onTestFinished(async () => {
      if (!releasePublication.settled()) {
        releasePublication.resolve(undefined);
      }
      await sendOutcome;
    });

    await publicationStarted.promise;
    await expect
      .poll(() => {
        return sendSettled;
      })
      .toBeTruthy();
    expect(releasePublication.settled()).toBeFalsy();
    const outcome = await sendOutcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    const sent = outcome.value;
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the pending publication not to gate dispatch");
    }
    await waitForRunUserMessage(
      actor,
      sent.body.threadId,
      sent.body.runId,
      prompt,
    );

    await expect
      .poll(async () => {
        const runList = await api.listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          limit: 100,
        });
        return runList.runs.some((run) => {
          return run.prompt === prompt;
        });
      })
      .toBe(true);

    const threadListPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic]) => {
        return topic === "threadListChanged";
      },
    );
    expect(threadListPublishes).toHaveLength(1);
    releasePublication.resolve(undefined);
    await cancelChatRun(actor, sent.body.runId);
  }, 90_000);

  it("keeps a queued send drainable when thread-list publication fails", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "thread list publication failure anchor",
    });
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some(([topic]) => {
          return topic === "threadListChanged";
        });
      })
      .toBe(true);
    context.mocks.ably.publish.mockClear();

    let failedThreadListPublish = false;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "threadListChanged" && !failedThreadListPublish) {
        failedThreadListPublish = true;
        return Promise.reject(new Error("thread list publication failed"));
      }
      return Promise.resolve(undefined);
    });

    const queuedMessageId = randomUUID();
    const queuedBody = {
      agentId,
      threadId: anchor.threadId,
      prompt: "queued send survives thread list publication failure",
      clientEventId: queuedMessageId,
    };
    const queued = await chat.requestSendEvent(actor, queuedBody, [201]);
    expect(queued.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    expect(failedThreadListPublish).toBeTruthy();

    const retried = await chat.requestSendEvent(actor, queuedBody, [201]);
    expect(retried.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    const threadListPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic]) => {
        return topic === "threadListChanged";
      },
    );
    expect(threadListPublishes).toHaveLength(1);

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to remain drainable");
    }
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("serializes a terminal drain against an inline queue-first send", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "terminal drain race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    await webhooks.requestAgentEvents(
      {
        runId: anchor.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "terminal callback race complete" },
              ],
            },
          },
        ],
      },
      anchorClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    const terminalPrompt = "terminal drain owns the queue head";
    const terminalMessageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: terminalPrompt,
        clientEventId: terminalMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    // The terminal drain owns the existing queue head and reaches final run
    // admission before the inline send joins the same boundary.
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const inlinePrompt = "inline send waits behind the terminal drain";
    const inlineMessageId = randomUUID();
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: inlinePrompt,
        clientEventId: inlineMessageId,
      },
      [201],
    );
    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(actor, anchor.threadId);
        return messages.events.some((message) => {
          return message.id === inlineMessageId;
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.transitiveWaiterCount).toBe(2);
    admissionLock.release();

    const sent = await send;
    await admissionLock.done;
    await flushWaitUntilForTest();
    expect(sent.body).toMatchObject({ runId: null });

    const messages = await chat.listThreadEvents(actor, anchor.threadId);
    const claimed = userMessages(messages.events).filter((message) => {
      return (
        message.revokesEventId === terminalMessageId &&
        message.runId !== undefined
      );
    });
    expect(claimed).toHaveLength(1);
    const claimedRunId = claimed[0]?.runId;
    if (!claimedRunId) {
      throw new Error("Expected the terminal drain to own the queue head");
    }
    const inline = userMessages(messages.events).find((message) => {
      return message.id === inlineMessageId;
    });
    if (!inline) {
      throw new Error("Expected the inline queued message");
    }
    expect(inline.runId).toBeUndefined();

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    const candidates = runList.runs.filter((run) => {
      return run.prompt === terminalPrompt || run.prompt === inlinePrompt;
    });
    expect(candidates).toStrictEqual([
      expect.objectContaining({
        id: claimedRunId,
        prompt: terminalPrompt,
        status: expect.stringMatching(/^(queued|pending|running)$/),
      }),
    ]);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: inlineMessageId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({ runId: null });
    await cancelChatRun(actor, claimedRunId);
  }, 90_000);

  it("preserves an appended claim when recall races the queue drain", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "recall claim race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const messageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "recall races the appended claim",
        clientEventId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Pin the completion-triggered queue-first drain at run admission, then
    // make the claim and recall queue behind the exact message row in a
    // test-owned order.
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    const eventQueueLock = await holdChatEventQueueItemFixture({
      threadId: anchor.threadId,
      eventId: messageId,
      signal: context.signal,
    });

    onTestFinished(async () => {
      admissionLock.release();
      eventQueueLock.release();
      await Promise.all([admissionLock.done, eventQueueLock.done]);
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "recall claim race complete"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await expect.poll(admissionLock.waiterCount).toBe(1);
    admissionLock.release();
    await admissionLock.done;
    await expect.poll(eventQueueLock.directBlockedWaiterCount).toBe(1);

    const recall = Promise.allSettled([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          revokesEventId: messageId,
          clientEventId: randomUUID(),
        },
        [400],
      ),
    ]);
    await expect.poll(eventQueueLock.blockedWaiterCount).toBe(2);
    eventQueueLock.release();

    const [recallResult] = await recall;
    if (recallResult.status === "rejected") {
      throw recallResult.reason;
    }
    const recalled = recallResult.value;
    expectApiError(recalled.body);
    expect(recalled.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );
    await eventQueueLock.done;
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queue drain to append a claimed message");
    }
    const original = userMessages(messages.events).find((message) => {
      return message.id === messageId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(claimed.content).toBeNull();
    expect(chatEventDisplayText(claimed)).toBe(
      "recall races the appended claim",
    );

    await cancelChatRun(actor, claimed.runId);
  }, 90_000);

  it("lets recall win before an atomic queue-first drain", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "recall-first queue race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const prompt = "recall wins the atomic queue-first race";
    const messageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientEventId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });

    // Stage the completion-triggered queue-first drain at org admission, then
    // let recall append before it can claim the queued message.
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "recall-first queue race complete"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: messageId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });

    admissionLock.release();
    await admissionLock.done;
    await flushWaitUntilForTest();

    const messages = await chat.listThreadEvents(actor, anchor.threadId);
    expect(userMessages(messages.events)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
      }),
    );
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === messageId && message.runId;
      }),
    ).toHaveLength(0);

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runList.runs.filter((run) => {
        return run.prompt === prompt;
      }),
    ).toHaveLength(0);

    const recalledEvent = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId && !message.runId;
    });
    if (recalledEvent === undefined) {
      throw new Error("Expected the winning recall event");
    }
    const probeEventId = randomUUID();
    const probe = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "append after the lost queue claim",
        clientEventId: probeEventId,
      },
      [201],
    );
    if (probe.status !== 201) {
      throw new Error("Expected the post-race probe event to be accepted");
    }
    const afterProbe = await chat.listThreadEvents(actor, anchor.threadId);
    const probeEvent = userMessages(afterProbe.events).find((message) => {
      return message.id === probeEventId;
    });
    if (probeEvent === undefined) {
      throw new Error("Expected the post-race probe event");
    }
    expect(probeEvent.seqId).toBe(recalledEvent.seqId + 1);
    if (probe.body.runId !== null) {
      await cancelChatRun(actor, probe.body.runId);
    }
  }, 90_000);

  it("appends replacements on auto-send and keeps queued recalls idempotent", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor run",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first waits for the anchor",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // A second queued message can be recalled before dispatch.
    const recalledId = randomUUID();
    const toRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first message to recall",
        clientEventId: recalledId,
      },
      [201],
    );
    expect(toRecall.body).toMatchObject({ runId: null });
    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({ runId: null });

    // A repeated recall stays idempotent.
    const repeatedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({ runId: null });

    // Completing the anchor auto-sends the queued message by appending a
    // run-associated replacement while preserving the queued row.
    context.mocks.ably.publish.mockClear();
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to append a replacement");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe(
      "queue-first waits for the anchor",
    );
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(Date.parse(promoted.createdAt)).toBeGreaterThan(
      Date.parse(original.createdAt),
    );
    const appended = await chat.listThreadEvents(actor, anchor.threadId, {
      sinceEventId: original.id,
      sinceSeqId: original.seqId,
    });
    expect(appended.events).toContainEqual(
      expect.objectContaining({
        id: promoted.id,
        revokesEventId: queuedId,
        runId: promoted.runId,
      }),
    );
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${anchor.threadId}`;
        });
      })
      .toBe(true);

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queue-first waits for the anchor");
    expect(followUp.appendSystemPrompt ?? "").not.toContain(
      "queue-first message to recall",
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("auto-fires queued messages after cancellation recovery completes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor to cancel",
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first fires after cancel",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Cancellation is public immediately, but a claimed run keeps the thread
    // barrier until the runner reports cancellation recovery.
    await api.requestCancelRun(actor, anchor.runId, [200]);
    await waitForRunStatus(actor, anchor.runId, "cancelled");
    const beforeRecovery = await chat.listThreadEvents(actor, anchor.threadId);
    expect(
      userMessages(beforeRecovery.events).filter((message) => {
        return (
          message.revokesEventId === queuedId && message.runId !== undefined
        );
      }),
    ).toHaveLength(0);

    await failChatRun(anchor.runId, sandboxHeaders, "Run cancelled");
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string" &&
            message.runId !== anchor.runId
          );
        });
      },
    );
    const fired = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!fired?.runId) {
      throw new Error("Expected the queued message to fire after cancel");
    }
    expect(fired.content).toBeNull();
    expect(chatEventDisplayText(fired)).toBe("queue-first fires after cancel");
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, fired.runId);
    expect(followUp.prompt).toContain("queue-first fires after cancel");
    await cancelChatRun(actor, fired.runId);
  }, 90_000);
});
