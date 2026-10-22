import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
  type PromptMessage,
  requireOrgId,
  userMessages,
} from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const {
  bdd,
  api,
  chat,
  configureSubscriptionPiModel,
  waitForThreadMessages,
  cancelChatRun,
  requestSendEventWithBearer,
  mockPiObjectStore,
  completeSandboxFirstPiRun,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function expectAgentTokenThreadOwnershipBoundaries(args: {
  readonly own: Awaited<ReturnType<typeof publicChatActor>>["run"];
  readonly agentId: string;
  readonly orgId: string;
  readonly sourceToken: string;
}): Promise<void> {
  const crossUser = bdd.user({ orgId: args.orgId });
  const crossUserThread = await args.own(() => {
    return chat.createThread(crossUser, { agentId: args.agentId });
  });
  const crossUserSend = await args.own(() => {
    return requestSendEventWithBearer(
      args.sourceToken,
      {
        agentId: args.agentId,
        threadId: crossUserThread.id,
        prompt: "reject cross-user delegated chat admission",
      },
      [404],
    );
  });
  expect(crossUserSend.status).toBe(404);

  const crossOrg = await publicChatActor(context);
  const crossOrgThread = await crossOrg.run(() => {
    return chat.createThread(crossOrg.actor, { agentId: crossOrg.agentId });
  });
  const crossOrgSend = await crossOrg.run(() => {
    return requestSendEventWithBearer(
      args.sourceToken,
      {
        agentId: crossOrg.agentId,
        threadId: crossOrgThread.id,
        prompt: "reject cross-org delegated chat admission",
      },
      [404],
    );
  });
  expect(crossOrgSend.status).toBe(404);

  const unownedThreadSend = await args.own(() => {
    return requestSendEventWithBearer(
      args.sourceToken,
      {
        agentId: args.agentId,
        threadId: randomUUID(),
        prompt: "reject unowned-thread delegated chat admission",
      },
      [404],
    );
  });
  expect(unownedThreadSend.status).toBe(404);
}

async function expectAgentChatProvenance(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly delegatedEventId: string;
  readonly delegatedRunId: string;
  readonly orgId: string;
  readonly source: { readonly runId: string; readonly threadId: string };
  readonly targetThreadId: string;
}): Promise<void> {
  const delegatedMessages = await waitForThreadMessages(
    args.actor,
    args.targetThreadId,
    (events) => {
      return userMessages(events).some((event) => {
        return event.id === args.delegatedEventId;
      });
    },
  );
  const delegatedInput = userMessages(delegatedMessages.events).find(
    (event): event is PromptMessage => {
      return (
        event.eventType === "input.prompt" && event.id === args.delegatedEventId
      );
    },
  );
  expect(delegatedInput?.userMessage.parts).toContainEqual({
    type: "source",
    kind: "agent",
    runId: args.source.runId,
    threadId: args.source.threadId,
    agentId: args.agentId,
    titleSnapshot: "New thread",
    href: `/chats/${args.source.threadId}#run-${args.source.runId}`,
  });
}

describe("CHAT-02: model-first routing", () => {
  it("preserves delegated Pi provenance and rejects foreign thread writes", async () => {
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
      requestSendEventWithBearer,
    } = await publicChatActor(context);
    await own(async () => {
      return await api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const orgId = requireOrgId(actor);
    await own(async () => {
      return await bdd.updateAgentMetadata(actor, agentId, {
        visibility: "public",
      });
    });
    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate a non-interactive Pi turn",
      model: "claude-fable-5-1",
    });
    const sourceClaim = await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim.claim);
    const targetThread = await own(async () => {
      return await chat.createThread(actor, { agentId });
    });

    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    });
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();

    const delegatedEventId = randomUUID();
    const delegatedPrompt = "learn this stable preference from delegated work";
    const delegated = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: delegatedEventId,
        threadId: targetThread.id,
        prompt: delegatedPrompt,
        model: "gpt-6-luna",
      },
      [201],
    );
    expect(delegated.status).toBe(201);
    if (delegated.status !== 201) {
      throw new Error("Expected the delegated Pi prompt to be accepted");
    }
    expect(delegated.body).toStrictEqual({
      threadId: targetThread.id,
      createdAt: expect.any(String),
    });
    // The background pick launches the delegated input on its thread.
    const delegatedMessages = await waitForThreadMessages(
      actor,
      targetThread.id,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === delegatedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const delegatedRunId = userMessages(delegatedMessages.events).find(
      (message) => {
        return message.revokesEventId === delegatedEventId;
      },
    )?.runId;
    if (delegatedRunId === undefined) {
      throw new Error("Expected the delegated Pi prompt to launch a run");
    }
    const delegatedRun = { runId: delegatedRunId, threadId: targetThread.id };
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: "delegated chat admission answer",
        historyObjects,
        claim: await claimChatRun(runnerGroup, delegatedRunId),
        prompt: delegatedPrompt,
        run: delegatedRun,
      });
    });
    await expectAgentChatProvenance({
      actor,
      agentId,
      delegatedEventId,
      delegatedRunId,
      orgId,
      source,
      targetThreadId: targetThread.id,
    });
    await expectAgentTokenThreadOwnershipBoundaries({
      own,
      agentId,
      orgId,
      sourceToken,
    });

    await own(async () => {
      return await cancelChatRun(
        actor,
        source.runId,
        sourceClaim.sandboxHeaders,
      );
    });
  }, 90_000);
});
