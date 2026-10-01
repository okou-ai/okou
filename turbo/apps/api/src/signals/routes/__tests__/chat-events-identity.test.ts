import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { verifyOkouToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
  userMessages,
  type PromptMessage,
  type RunnerClaim,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  chatEventsClient,
  chatThreadsClient,
  readThreadProjection,
  requestSendEventWithBearer,
} = createChatEventsFixture(context);

const cu = createComputerUseBddApi(context);

async function entitledNativeChatActor(): Promise<
  Awaited<ReturnType<typeof entitledChatActor>>
> {
  const fixture = await entitledChatActor();
  await api.updateOrgModelPolicies(fixture.actor, [
    {
      model: "claude-fable-5-1",
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: fixture.providerId,
    },
  ]);
  return fixture;
}

function expectRunAppContext(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly claim: RunnerClaim;
  readonly appUrl: string;
}): void {
  if (!args.actor.orgId) {
    throw new Error("Expected an organization-scoped chat actor");
  }
  expect(args.claim.platformEnvironment.OKOU_APP_URL).toBe(args.appUrl);
  const token = args.claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the run context to contain an Okou token");
  }
  expect(verifyOkouToken(token)).toMatchObject({
    runId: args.runId,
  });
}

async function readThreadComputerUseHostId(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  return (await readThreadProjection(actor, threadId)).computerUseHostId;
}

describe("CHAT-02: default assistant identity", () => {
  it("keeps the default name as Okou through queued runs without renaming custom agents", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const { actor, runnerGroup } = await entitledNativeChatActor();
    bdd.acceptAgentStorageWrites();
    const onboarding = await bdd.readOnboardingStatus(actor);
    const defaultAgentId = onboarding.defaultAgentId;
    if (!defaultAgentId) {
      throw new Error("Expected the system default agent to exist");
    }

    const anchor = await sendChatRun(actor, {
      agentId: defaultAgentId,
      prompt: "start an Okou run",
    });
    const anchorRun = await api.readRun(actor, anchor.runId);
    expect(anchorRun.appendSystemPrompt).toContain("Your name is Okou.");

    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
    expectRunAppContext({
      actor,
      runId: anchor.runId,
      claim: anchorClaim.claim,
      appUrl: "https://app.okou.ai",
    });
    const queuedEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId: defaultAgentId,
        threadId: anchor.threadId,
        prompt: "continue the Okou run",
        clientEventId: queuedEventId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the Okou follow-up to enter the chat queue");
    }
    expect(queued.body.runId).toBeNull();

    const rawQueuedEvent = (
      await chat.listThreadEventRows(actor, anchor.threadId)
    ).find((event) => {
      return event.id === queuedEventId;
    });
    if (!rawQueuedEvent) {
      throw new Error("Expected the queued Okou event in Raw Events");
    }
    expect(rawQueuedEvent).toMatchObject({
      contextType: "web",
      contextId: "0bdfae9e-63be-43dd-8193-a96e07787c20",
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const promotedMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(promotedMessages.events).find((message) => {
      return message.revokesEventId === queuedEventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued Okou message to auto-send");
    }
    const promotedRun = await api.readRun(actor, promoted.runId);
    expect(promotedRun.appendSystemPrompt).toContain("Your name is Okou.");
    const promotedClaim = await claimChatRun(runnerGroup, promoted.runId);
    expectRunAppContext({
      actor,
      runId: promoted.runId,
      claim: promotedClaim.claim,
      appUrl: "https://app.okou.ai",
    });
    await cancelChatRun(actor, promoted.runId);

    mockEnv("APP_URL", "https://preview.example.test");
    const customAgent = await bdd.createAgent(actor, {
      displayName: "Nova",
      visibility: "private",
    });
    const customRun = await sendChatRun(actor, {
      agentId: customAgent.agentId,
      prompt: "keep my custom name",
    });
    const customPrompt = (await api.readRun(actor, customRun.runId))
      .appendSystemPrompt;
    expect(customPrompt).toContain("Your name is Nova.");
    expect(customPrompt).not.toContain("Your name is Okou.");
    const customClaim = await claimChatRun(runnerGroup, customRun.runId);
    expectRunAppContext({
      actor,
      runId: customRun.runId,
      claim: customClaim.claim,
      appUrl: "https://preview.example.test",
    });

    await cancelChatRun(actor, customRun.runId);
  }, 90_000);
});

describe("CHAT-02: run-scoped agent-token chat launches", () => {
  it("preserves the caller's run annotation on immediate and queued handoffs", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const caller = await sendChatRun(actor, {
      agentId,
      prompt: "launch chat work from this run",
    });
    const okouToken = api.okouTokenForRunWithCapabilities(actor, caller.runId, [
      "chat-thread:read",
      "chat-thread:write",
      "chat-event:read",
      "chat-event:write",
    ]);

    const createdThread = await accept(
      chatThreadsClient().create({
        headers: { authorization: `Bearer ${okouToken}` },
        body: { agentId, title: "Run-scoped handoff" },
      }),
      [201],
    );
    const immediateEventId = randomUUID();
    const immediateSend = await requestSendEventWithBearer(
      okouToken,
      {
        agentId,
        clientEventId: immediateEventId,
        threadId: createdThread.body.id,
        prompt: "immediate run-scoped handoff",
      },
      [201],
    );
    if (immediateSend.status !== 201) {
      throw new Error("Expected the run-scoped handoff request to succeed");
    }
    expect(immediateSend.body.runId).toBeNull();
    // The idle thread's background pick launches the handoff.
    await flushWaitUntilForTest();
    const launchedMessages = await waitForThreadMessages(
      actor,
      createdThread.body.id,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === immediateEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const immediateRunId = userMessages(launchedMessages.events).find(
      (message) => {
        return message.revokesEventId === immediateEventId;
      },
    )?.runId;
    if (immediateRunId === undefined) {
      throw new Error("Expected the run-scoped handoff to launch");
    }

    await expect(api.readRun(actor, immediateRunId)).resolves.toMatchObject({
      runId: immediateRunId,
      prompt: "immediate run-scoped handoff",
    });
    expect(userMessages(launchedMessages.events)).toContainEqual(
      expect.objectContaining({
        revokesEventId: immediateEventId,
        userMessage: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "source",
              kind: "agent",
              runId: caller.runId,
            }),
          ]),
        }),
      }),
    );

    const queuedEventId = randomUUID();
    const queued = await requestSendEventWithBearer(
      okouToken,
      {
        agentId,
        clientEventId: queuedEventId,
        threadId: createdThread.body.id,
        prompt: "queued run-scoped handoff",
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued run-scoped request to succeed");
    }
    expect(queued.body.runId).toBeNull();

    await cancelChatRun(actor, immediateRunId);
    await flushWaitUntilForTest();
    const promotedMessages = await waitForThreadMessages(
      actor,
      createdThread.body.id,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(promotedMessages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedEventId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the queued run-scoped handoff to promote");
    }

    await expect(api.readRun(actor, promoted.runId)).resolves.toMatchObject({
      runId: promoted.runId,
      prompt: "queued run-scoped handoff",
    });
    expect(promoted.userMessage.parts).toContainEqual(
      expect.objectContaining({
        type: "source",
        kind: "agent",
        runId: caller.runId,
      }),
    );

    await cancelChatRun(actor, promoted.runId);
    await cancelChatRun(actor, caller.runId);
  }, 90_000);
});

describe("CHAT-02/FILE-03: computer-use host grants", () => {
  it("grants computer-use capability only for a selected host", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { hostId, hostToken } = await cu.startComputerUseHost(actor);

    // The thread's sticky host is not exposed by any read route, so the
    // grant is observed through the run token issued to each claim: a
    // granted token can create write commands on the host, while an
    // ungranted token cannot. Chat messaging remains available independently.
    const plain = await sendChatRun(actor, {
      agentId,
      prompt: "no computer use selected",
    });
    const plainClaim = await claimChatRun(runnerGroup, plain.runId);
    const plainToken = okouTokenFromClaim(plainClaim.claim);
    const deniedCommand = await cu.requestCreateComputerUseWriteCommand(
      { bearer: plainToken },
      [403],
    );
    expect(deniedCommand.status).toBe(403);
    const nestedEventId = randomUUID();
    const nestedSend = await requestSendEventWithBearer(
      plainToken,
      {
        agentId,
        clientEventId: nestedEventId,
        threadId: plain.threadId,
        prompt: "run tokens can send chat messages",
      },
      [201],
    );
    expect(nestedSend.status).toBe(201);
    expect(nestedSend.body).toMatchObject({ runId: null });
    const recalled = await accept(
      chatEventsClient().send({
        headers: { authorization: `Bearer ${plainToken}` },
        body: {
          agentId,
          threadId: plain.threadId,
          revokesEventId: nestedEventId,
          clientEventId: randomUUID(),
        },
      }),
      [201],
    );
    expect(recalled.body.runId).toBeNull();
    await cancelChatRun(actor, plain.runId);

    // Selecting an online host pins it to the thread and grants the run
    // token computer-use write access on that host.
    const granted = await sendChatRun(actor, {
      agentId,
      prompt: "open the remote browser",
      computerUseHostId: hostId,
    });
    const grantedRun = await api.readRun(actor, granted.runId);
    expect(grantedRun.appendSystemPrompt).toContain("# Computer Use");
    expect(grantedRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on BDD Desktop.",
    );
    expect(grantedRun.appendSystemPrompt).not.toContain(hostId);
    const grantedClaim = await claimChatRun(runnerGroup, granted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(grantedClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, granted.runId, grantedClaim.sandboxHeaders);

    // Follow-up sends without the field stay granted via the sticky host.
    const sticky = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "keep using the same host",
    });
    const stickyClaim = await claimChatRun(runnerGroup, sticky.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(stickyClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, sticky.runId, stickyClaim.sandboxHeaders);

    // An explicit null clears the sticky host: the next run on the same
    // thread is no longer granted.
    const cleared = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "drop the host",
      computerUseHostId: null,
    });
    const clearedClaim = await claimChatRun(runnerGroup, cleared.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(clearedClaim.claim) },
      [403],
    );
    await cancelChatRun(actor, cleared.runId, clearedClaim.sandboxHeaders);

    mockNow(now() + 91_000);
    const staleGranted = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "use the computer after it went offline",
      computerUseHostId: hostId,
    });
    const staleRun = await api.readRun(actor, staleGranted.runId);
    expect(staleRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on BDD Desktop.",
    );
    clearMockNow();
    const staleClaim = await claimChatRun(runnerGroup, staleGranted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(staleClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, staleGranted.runId);
  }, 120_000);

  it("rejects unusable computer-use host selections", async () => {
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use guard agent",
    });

    const unknownHost = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unknown host",
        computerUseHostId: randomUUID(),
      },
      [404],
    );
    expectApiError(unknownHost.body);
    expect(unknownHost.body.error.message).toBe("Computer-use host not found");

    // Installation-backed hosts stop as temporary offline devices, so thread
    // bindings survive and reconnect to the same host id on the next start.
    const installationId = randomUUID();
    const installed = await cu.startComputerUseHost(actor, { installationId });
    const installedPinned = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin the durable host before stopping it",
        computerUseHostId: installed.hostId,
      },
      [201],
    );
    if (installedPinned.status !== 201) {
      throw new Error("Expected the installed-host pin send to be accepted");
    }
    await cu.stopComputerUseHost(installed.hostToken);
    await expect(
      readThreadComputerUseHostId(actor, installedPinned.body.threadId),
    ).resolves.toBe(installed.hostId);
    const stoppedInstalledHost = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: installedPinned.body.threadId,
        prompt: "use a stopped durable host",
        computerUseHostId: installed.hostId,
      },
      [201],
    );
    expect(stoppedInstalledHost.body).toMatchObject({
      threadId: installedPinned.body.threadId,
    });
    const reconnected = await cu.startComputerUseHost(actor, {
      installationId,
    });
    expect(reconnected.hostId).toBe(installed.hostId);

    // A valid sticky host remains usable for later non-explicit sends.
    const survivor = await cu.startComputerUseHost(actor);
    const survivorThread = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin a host for a later sticky send",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    if (survivorThread.status !== 201) {
      throw new Error("Expected the survivor send to be accepted");
    }

    // A host that stopped heartbeating goes stale-offline (status still
    // online, not revoked), but explicit selections are still accepted so the
    // run can use the host if it reconnects while running.
    mockNow(now() + 91_000);
    const offlineHostSend = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stale host",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    expect(offlineHostSend.body).toMatchObject({ runId: null });

    // The sticky-host fallthrough also tolerates a stale host instead of
    // failing: a send without the field on the pinned thread is accepted.
    const staleStickySend = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: survivorThread.body.threadId,
        prompt: "send while the sticky host is stale",
      },
      [201],
    );
    clearMockNow();
    expect(staleStickySend.body).toMatchObject({
      threadId: survivorThread.body.threadId,
    });
  }, 90_000);
});
