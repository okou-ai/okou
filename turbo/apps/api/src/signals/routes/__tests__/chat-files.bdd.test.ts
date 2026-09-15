import { randomUUID } from "node:crypto";

import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createChatFilesBddApi,
  persistedAttachment,
} from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";

/*
helper gap:
- CHAT-02 signed assistant callback, integration-message, and event-consumer
  ingestion still need a visible API helper that creates a run and exposes the
  callback signing material without reading agent_run_callbacks.
- CHAT-03 non-empty run artifacts and Google Drive status live in
  chat-threads.bdd.test.ts.
- FILE-01 raw hosted-content download does not have an exported typed contract;
  this file covers typed upload and host APIs instead of using DB or untyped
  route fallbacks.
- CHAIN-CHAT callback-signing branches are blocked by the CHAT-02 callback
  signing gap; the run-to-artifact path is covered through public run and
  sandbox upload APIs in chat-threads.bdd.test.ts.
*/

const context = testContext();
const bdd = createBddApi(context);
const api = createChatFilesBddApi(context);

describe("CHAT-01 chat thread lifecycle", () => {
  it("creates, mutates, searches, and deletes a thread through visible APIs", async () => {
    const actor = bdd.user();
    const agent = await api.createAgentForChatThread(actor);
    const created = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Launch notes",
    });

    expect(created.title).toBe("Launch notes");

    let detail = await api.readThread(actor, created.id);
    expect(detail).toStrictEqual({
      lastReadAt: expect.any(String),
      cancellationRecoveryPending: false,
    });
    await expect(api.readThreadDraft(actor, created.id)).resolves.toStrictEqual(
      {
        draftUserMessage: null,
        draftAttachments: null,
      },
    );

    await api.patchThread(actor, created.id, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "follow up on " },
          {
            type: "chat_thread",
            threadId: created.id,
            titleSnapshot: "Launch notes",
          },
        ],
      },
      draftAttachments: [
        persistedAttachment(
          randomUUID(),
          "brief.txt",
          "text/plain",
          "follow up on the launch".length,
        ),
      ],
    });
    const draft = await api.readThreadDraft(actor, created.id);
    expect(draft.draftUserMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: "follow up on " },
        {
          type: "chat_thread",
          threadId: created.id,
          titleSnapshot: "Launch notes",
        },
      ],
    });
    expect(draft.draftAttachments).toHaveLength(1);
    await expect(api.listThreadDrafts(actor)).resolves.toContain(created.id);

    await api.patchThread(actor, created.id, {
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(api.readThreadDraft(actor, created.id)).resolves.toStrictEqual(
      {
        draftUserMessage: null,
        draftAttachments: null,
      },
    );
    await expect(api.listThreadDrafts(actor)).resolves.not.toContain(
      created.id,
    );

    await api.renameThread(actor, created.id, "Renamed launch notes");
    detail = await api.readThread(actor, created.id);
    expect(detail.lastReadAt).toStrictEqual(expect.any(String));

    await api.pinThread(actor, created.id);
    await api.unpinThread(actor, created.id);

    const markedRead = await api.markThreadRead(actor, created.id);
    expect(markedRead).toStrictEqual({
      lastReadAt: expect.any(String),
      unreads: [],
    });

    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const markedUnread = await api.markThreadUnread(actor, created.id);
    expect(markedUnread).toStrictEqual({
      lastReadAt: null,
      unreads: [],
    });
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user-org:${actor.userId}:${actor.orgId}`],
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: created.id,
        agentId: agent.agentId,
        lastReadAt: null,
      },
    );
    detail = await api.readThread(actor, created.id);
    expect(detail.lastReadAt).toBeNull();

    await api.updateThreadModelSelection(actor, created.id, null);
    detail = await api.readThread(actor, created.id);
    expect(detail).not.toHaveProperty("selectedModel");

    const messages = await api.listThreadEvents(actor, created.id);
    expect(messages.events).toStrictEqual([]);

    const artifacts = await api.listThreadArtifacts(actor, created.id);
    expect(artifacts.runs).toStrictEqual([]);

    const search = await api.searchChat(actor, "launch");
    expect(search.results).toStrictEqual([]);

    await api.deleteThread(actor, created.id);
    const deletedRead = await api.requestReadThread(actor, created.id, [404]);
    expectApiError(deletedRead.body);
    expect(deletedRead.body.error.code).toBe("NOT_FOUND");
  });

  it("hides owned threads from peer users and other organizations", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const outsider = bdd.user();
    const agent = await api.createAgentForChatThread(owner);
    const thread = await api.createThread(owner, {
      agentId: agent.agentId,
      title: "Private planning",
    });

    await expect(api.readThread(owner, thread.id)).resolves.toHaveProperty(
      "lastReadAt",
    );

    const peerRead = await api.requestReadThread(peer, thread.id, [404]);
    expectApiError(peerRead.body);
    expect(peerRead.body.error.code).toBe("NOT_FOUND");
    const peerDraftRead = await api.requestReadThreadDraft(
      peer,
      thread.id,
      [404],
    );
    expectApiError(peerDraftRead.body);
    expect(peerDraftRead.body.error.code).toBe("NOT_FOUND");
    await api.patchThread(owner, thread.id, {
      draftAttachments: null,
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "private draft" }],
      },
    });
    await expect(api.readThreadDraft(owner, thread.id)).resolves.toMatchObject({
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "private draft" }],
      },
    });
    await expect(api.listThreadDrafts(peer)).resolves.not.toContain(thread.id);

    const outsiderRead = await api.requestReadThread(
      outsider,
      thread.id,
      [404],
    );
    expectApiError(outsiderRead.body);
    expect(outsiderRead.body.error.code).toBe("NOT_FOUND");

    const peerEvents = await api.requestThreadEvents(peer, {}, [200]);
    expect(peerEvents.status).toBe(200);
    if (peerEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      peerEvents.body.events.some((event) => {
        return event.chatThreadId === thread.id;
      }),
    ).toBeFalsy();
  });

  it("given an owned thread, when mutation routes are chained, then only owner-visible state changes", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const agent = await bdd.createAgent(owner, {
      displayName: "Pinned launch plan agent",
    });
    const thread = await api.createThread(owner, {
      agentId: agent.agentId,
      title: "Owner launch plan",
    });

    await api.renameThread(owner, thread.id, "Pinned launch plan");
    await api.updateThreadModelSelection(owner, thread.id, "gpt-5.6-luna");
    await api.pinThread(owner, thread.id);
    const readEmpty = await api.markThreadRead(owner, thread.id);

    expect(readEmpty).toStrictEqual({
      lastReadAt: expect.any(String),
      unreads: [],
    });

    let detail = await api.readThread(owner, thread.id);
    expect(detail.lastReadAt).toStrictEqual(expect.any(String));
    const ownerEvents = await api.requestThreadEvents(owner, {}, [200]);
    expect(ownerEvents.status).toBe(200);
    if (ownerEvents.status !== 200) {
      throw new Error("Expected owner chat thread events to load");
    }
    expect(ownerEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: thread.id,
        selectedModel: "gpt-5.6-luna",
      }),
    );
    expect(detail.lastReadAt).toStrictEqual(expect.any(String));

    const peerRename = await api.requestRenameThread(
      peer,
      thread.id,
      "Peer rewrite",
      [404],
    );
    expectApiError(peerRename.body);
    expect(peerRename.body.error.code).toBe("NOT_FOUND");

    const peerModelSelection = await api.requestUpdateThreadModelSelection(
      peer,
      thread.id,
      null,
      [404],
    );
    expectApiError(peerModelSelection.body);
    expect(peerModelSelection.body.error.code).toBe("NOT_FOUND");

    const peerUnpin = await api.requestUnpinThread(peer, thread.id, [404]);
    expectApiError(peerUnpin.body);
    expect(peerUnpin.body.error.code).toBe("NOT_FOUND");

    const peerPin = await api.requestPinThread(peer, thread.id, [404]);
    expectApiError(peerPin.body);
    expect(peerPin.body.error.code).toBe("NOT_FOUND");

    const peerMarkRead = await api.requestMarkThreadRead(
      peer,
      thread.id,
      [404],
    );
    expectApiError(peerMarkRead.body);
    expect(peerMarkRead.body.error.code).toBe("NOT_FOUND");

    const peerMarkUnread = await api.requestMarkThreadUnread(
      peer,
      thread.id,
      [404],
    );
    expectApiError(peerMarkUnread.body);
    expect(peerMarkUnread.body.error.code).toBe("NOT_FOUND");

    detail = await api.readThread(owner, thread.id);
    expect(detail.lastReadAt).toStrictEqual(expect.any(String));
    expect(detail).not.toHaveProperty("selectedModel");

    await api.unpinThread(owner, thread.id);
    await api.updateThreadModelSelection(owner, thread.id, null);

    detail = await api.readThread(owner, thread.id);
    expect(detail.lastReadAt).toStrictEqual(expect.any(String));
    const clearedEvents = await api.requestThreadEvents(owner, {}, [200]);
    expect(clearedEvents.status).toBe(200);
    if (clearedEvents.status !== 200) {
      throw new Error("Expected cleared chat thread events to load");
    }
    expect(clearedEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: thread.id,
        selectedModel: null,
      }),
    );
    expect(detail).not.toHaveProperty("selectedModel");
  });
});

describe("CHAT-02 chat messages and visible validation", () => {
  it("sends chat messages through API-visible no-credit, recall, and interrupt branches", async () => {
    const actor = bdd.user();
    const peer = bdd.user({ orgId: actor.orgId });
    const agent = await bdd.createAgent(actor, {
      displayName: "No-credit chat branch agent",
    });
    const uploadId = randomUUID();
    const clientEventId = randomUUID();
    api.mockCompletedUploadObject(actor, uploadId, "launch-plan.txt", 24);
    const expectedUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Build a launch-plan presentation" },
        {
          type: "file",
          fileId: uploadId,
          filenameSnapshot: "launch-plan.txt",
          contentType: "text/plain",
        },
      ],
    };
    const sent = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Build a launch-plan presentation",
        userMessage: expectedUserMessage,
        hasTextContent: false,
        clientEventId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error(
        "Expected chat send to create visible no-credit messages",
      );
    }
    expect(sent.body.runId).toBeNull();
    expect(sent.body.threadId).toStrictEqual(expect.any(String));

    const threadId = sent.body.threadId;
    await expect(api.readThreadDraft(actor, threadId)).resolves.toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });

    const messages = await api.listThreadEvents(actor, threadId);
    expect(messages.events).toHaveLength(3);

    const queuedMessage = messages.events.find((message) => {
      return (
        message.eventType === "input.prompt" && message.id === clientEventId
      );
    });
    const rejectedUserMessage = messages.events.find((message) => {
      return (
        message.eventType === "input.rejected" &&
        message.revokesEventId === clientEventId
      );
    });
    const assistantMessage = messages.events.find((message) => {
      return message.eventType === "output.error";
    });

    expect(queuedMessage).toMatchObject({
      eventType: "input.prompt",
      content: null,
      userMessage: expectedUserMessage,
    });
    expect(queuedMessage).not.toHaveProperty("error");
    expect(rejectedUserMessage).toMatchObject({
      eventType: "input.rejected",
      content: null,
      userMessage: expectedUserMessage,
      error: "insufficient_credits",
      revokesEventId: clientEventId,
    });
    expect(rejectedUserMessage).not.toHaveProperty("automationId");
    expect(rejectedUserMessage).not.toHaveProperty("triggerBrief");
    expect(assistantMessage?.content).toContain("Insufficient credits");
    expect(assistantMessage?.error).toBe("insufficient_credits");

    const retried = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        prompt: "Retry the same client message",
        clientEventId,
      },
      [201],
    );
    expect(retried.body).toMatchObject({
      runId: null,
      threadId,
      createdAt: expect.any(String),
    });

    const afterRetry = await api.listThreadEvents(actor, threadId);
    expect(afterRetry.events).toHaveLength(3);

    const secondThread = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Duplicate client message id",
    });
    const duplicateAcrossThreads = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: secondThread.id,
        prompt: "Reuse the client message id in another thread",
        clientEventId,
      },
      [409],
    );
    expectApiError(duplicateAcrossThreads.body);
    expect(duplicateAcrossThreads.body.error.code).toBe("CONFLICT");
    expect(duplicateAcrossThreads.body.error.message).toBe(
      "clientEventId is already in use",
    );

    if (!rejectedUserMessage) {
      throw new Error("Expected the no-credit send to create a user message");
    }

    const unavailableFollowup = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        prompt: "Use a stale recommended follow-up",
        revokesEventId: rejectedUserMessage.id,
      },
      [400],
    );
    expectApiError(unavailableFollowup.body);
    expect(unavailableFollowup.body.error.code).toBe("BAD_REQUEST");
    expect(unavailableFollowup.body.error.message).toBe(
      "Recommended follow-up is no longer available",
    );

    const peerRecall = await api.requestSendEvent(
      peer,
      {
        agentId: agent.agentId,
        threadId,
        revokesEventId: rejectedUserMessage.id,
      },
      [404],
    );
    expectApiError(peerRecall.body);
    expect(peerRecall.body.error.code).toBe("NOT_FOUND");

    const recalled = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        revokesEventId: rejectedUserMessage.id,
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected chat recall to create a visible message");
    }
    expect(recalled.body).toMatchObject({
      runId: null,
      threadId,
      createdAt: expect.any(String),
    });

    const afterRecall = await api.listThreadEvents(actor, threadId);
    expect(
      afterRecall.events.some((message) => {
        return message.revokesEventId === rejectedUserMessage.id;
      }),
    ).toBeTruthy();

    const repeatedRecall = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        revokesEventId: rejectedUserMessage.id,
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId,
      createdAt: expect.any(String),
    });
    const afterRepeatedRecall = await api.listThreadEvents(actor, threadId);
    expect(
      afterRepeatedRecall.events.filter((message) => {
        return message.revokesEventId === rejectedUserMessage.id;
      }),
    ).toHaveLength(1);

    const interrupted = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        interruptsRunId: randomUUID(),
      },
      [400],
    );
    expectApiError(interrupted.body);
    expect(interrupted.body.error.code).toBe("BAD_REQUEST");
    expect(interrupted.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );
  });

  it("rejects invalid generation template and reused client thread ids through the send API", async () => {
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "Client-thread retry branch agent",
    });

    const invalidTemplate = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Use an unknown template",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Use an unknown template" },
            {
              type: "template",
              titleSnapshot: "Missing presentation template",
              template: {
                type: "presentation",
                selection: {
                  templateId: "template:html-ppt-missing",
                },
              },
            },
          ],
        },
      },
      [400],
    );
    expectApiError(invalidTemplate.body);
    expect(invalidTemplate.body.error.code).toBe("BAD_REQUEST");
    expect(invalidTemplate.body.error.message).toBe(
      "Unknown generation template",
    );

    const clientThreadId = randomUUID();
    const first = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "First client-thread send",
        clientThreadId,
      },
      [201],
    );
    if (first.status !== 201) {
      throw new Error("Expected first client-thread send to create the thread");
    }
    expect(first.body.threadId).toBe(clientThreadId);

    const retry = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Retry without an associated run",
        clientThreadId,
      },
      [400],
    );
    expectApiError(retry.body);
    expect(retry.body.error.code).toBe("BAD_REQUEST");
    expect(retry.body.error.message).toBe("Client thread id is already in use");

    const otherAgent = await bdd.createAgent(actor, {
      displayName: "Client-thread mismatch branch agent",
    });
    const reusedClientThreadForOtherAgent = await api.requestSendEvent(
      actor,
      {
        agentId: otherAgent.agentId,
        prompt: "Reuse a client thread id for another agent",
        clientThreadId,
      },
      [404],
    );
    expectApiError(reusedClientThreadForOtherAgent.body);
    expect(reusedClientThreadForOtherAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const ownerThread = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Owner-only send target",
    });
    const peerSendToOwnerThread = await api.requestSendEvent(
      peer,
      {
        agentId: agent.agentId,
        threadId: ownerThread.id,
        prompt: "Post into another user's thread",
      },
      [404],
    );
    expectApiError(peerSendToOwnerThread.body);
    expect(peerSendToOwnerThread.body.error.code).toBe("NOT_FOUND");

    const modelSelected = await api.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Persist the model selected at send time",
        model: "gpt-5.6-luna",
      },
      [201],
    );
    if (modelSelected.status !== 201) {
      throw new Error("Expected model-selected chat send to create a thread");
    }
    const modelSelectedThread = await api.readThread(
      actor,
      modelSelected.body.threadId,
    );
    expect(modelSelectedThread).not.toHaveProperty("selectedModel");
    const modelSelectedEvents = await api.requestThreadEvents(actor, {}, [200]);
    expect(modelSelectedEvents.status).toBe(200);
    if (modelSelectedEvents.status !== 200) {
      throw new Error("Expected model-selected thread events to load");
    }
    expect(modelSelectedEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: modelSelected.body.threadId,
        selectedModel: "gpt-5.6-luna",
      }),
    );
  });

  it("lists visible events and rejects invalid send requests without hidden fixtures", async () => {
    const actor = bdd.user();
    const peer = bdd.user({ orgId: actor.orgId });
    const agent = await api.createAgentForChatThread(actor);
    const thread = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Message validation",
    });

    const initialMessages = await api.listThreadEvents(actor, thread.id);
    expect(initialMessages.events).toStrictEqual([]);

    const unauthenticated = await api.requestSendEvent(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingAgent = await api.requestSendEvent(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.code).toBe("NOT_FOUND");

    const blankPrompt = await api.requestSendEvent(
      actor,
      { agentId: randomUUID(), prompt: "" },
      [400],
    );
    expectApiError(blankPrompt.body);
    expect(blankPrompt.body.error.code).toBe("BAD_REQUEST");

    const privateAgent = await bdd.createAgent(actor, {
      displayName: "Private chat send agent",
      visibility: "private",
    });
    const forbiddenPrivateAgent = await api.requestSendEvent(
      peer,
      {
        agentId: privateAgent.agentId,
        prompt: "Run someone else's private agent",
      },
      [403],
    );
    expectApiError(forbiddenPrivateAgent.body);
    expect(forbiddenPrivateAgent.body.error.code).toBe("FORBIDDEN");
    expect(forbiddenPrivateAgent.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  });

  it("given an empty chat thread, when event rows are requested, then only the owner sees zero rows", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const agent = await api.createAgentForChatThread(owner);
    const thread = await api.createThread(owner, {
      agentId: agent.agentId,
      title: "Empty message boundary",
    });

    const ownerMessages = await api.listThreadEvents(owner, thread.id, {
      limit: 1,
    });
    expect(ownerMessages).toStrictEqual({
      events: [],
    });

    const peerMessages = await api.requestListThreadEvents(
      peer,
      thread.id,
      { limit: 1 },
      [404],
    );
    expectApiError(peerMessages.body);
    expect(peerMessages.body.error.code).toBe("NOT_FOUND");

    const missingMessages = await api.requestListThreadEvents(
      owner,
      randomUUID(),
      {},
      [404],
    );
    expectApiError(missingMessages.body);
    expect(missingMessages.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CHAT-03 artifacts", () => {
  it("exposes empty artifact state through the list API", async () => {
    const actor = bdd.user();
    const agent = await api.createAgentForChatThread(actor);
    const thread = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Artifacts",
    });

    const artifacts = await api.listThreadArtifacts(actor, thread.id);
    expect(artifacts.runs).toStrictEqual([]);

    const missingArtifacts = await api.requestListThreadArtifacts(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(missingArtifacts.body);
    expect(missingArtifacts.body.error.code).toBe("NOT_FOUND");
  });
});

describe("FILE-01 uploads, storage, and host APIs", () => {
  it("prepares and completes an upload through S3 boundary state", async () => {
    const actor = bdd.user();

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/upload?sig=test",
    );
    api.mockEmptyObjectStorage();
    const prepared = await api.prepareUpload(actor, {
      filename: "notes.txt",
      contentType: "Text/Plain; Charset=UTF-8",
      size: 12,
    });
    expect(prepared).toMatchObject({
      filename: "notes.txt",
      contentType: "text/plain; charset=utf-8",
      size: 12,
    });
    expect("uploadUrl" in prepared ? prepared.uploadUrl : "").toMatch(
      /^https?:\/\//,
    );
    expect(prepared.url).toMatch(/^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.txt$/u);
    expect(prepared.url).not.toContain(actor.userId);

    api.mockCompletedUploadObject(actor, prepared.id, "notes.txt", 12);
    const completed = await api.completeUpload(actor, {
      id: prepared.id,
      contentType: prepared.contentType,
    });
    expect(completed).toMatchObject({
      id: prepared.id,
      filename: "notes.txt",
      contentType: "text/plain; charset=utf-8",
      size: 12,
    });

    const otherActor = bdd.user();
    const crossUserComplete = await api.requestCompleteUpload(
      otherActor,
      { id: prepared.id },
      [404],
    );
    expectApiError(crossUserComplete.body);
    expect(crossUserComplete.body.error.code).toBe("NOT_FOUND");

    const generic = await api.prepareUpload(actor, {
      filename: "capture.custom",
      contentType: "application/x-custom",
      size: 10,
    });
    expect(generic).toMatchObject({
      filename: "capture.custom",
      contentType: "application/octet-stream",
      size: 10,
    });
  });

  it("prepares and completes a hosted-site deployment through host APIs", async () => {
    const actor = bdd.user();
    const site = `bdd-site-${randomUUID().slice(0, 8)}`;

    const prepared = await api.prepareHostedSite(actor, {
      site,
      slugSuffix: "release-01",
      artifactKind: "hosted-site",
      spaFallback: true,
      files: [
        hostedTextFile("/index.html", "<main>BDD hosted site</main>"),
        hostedTextFile(
          "/assets/app.js",
          "console.log('bdd');",
          "application/javascript",
        ),
      ],
    });
    expect(prepared).toMatchObject({
      publicSlug: site,
      aliasUrl: prepared.url,
      deploymentVersion: 1,
      artifactUrl: expect.stringContaining(`dpl-${prepared.deploymentId}.`),
    });
    expect(prepared.uploads).toHaveLength(2);

    const otherActor = bdd.user();
    const crossOrgComplete = await api.requestCompleteHostedSite(
      otherActor,
      prepared.deploymentId,
      [404],
    );
    expectApiError(crossOrgComplete.body);
    expect(crossOrgComplete.body.error.code).toBe("NOT_FOUND");

    api.mockObjectStorageObjectsExist();
    const completed = await api.completeHostedSite(
      actor,
      prepared.deploymentId,
    );
    expect(completed).toMatchObject({
      siteId: prepared.siteId,
      deploymentId: prepared.deploymentId,
      publicSlug: prepared.publicSlug,
      url: prepared.url,
      status: "ready",
      deploymentVersion: 1,
      artifactUrl: prepared.artifactUrl,
      aliasUrl: prepared.url,
      isActive: true,
      activeDeploymentVersion: 1,
    });

    const invalid = await api.requestPrepareHostedSite(
      actor,
      {
        site: `bdd-invalid-${randomUUID().slice(0, 8)}`,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [hostedTextFile("/about.html", "<main>missing index</main>")],
      },
      [400],
    );
    expectApiError(invalid.body);
    expect(invalid.body.error.message).toContain("must include /index.html");
  });
});
