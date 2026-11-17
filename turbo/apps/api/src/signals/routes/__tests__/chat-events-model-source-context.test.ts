import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const {
  chat,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  cancelChatRun,
  requestSendEventRaw,
} = createChatEventsFixture(context);

describe("chat send authorization, validation and cancellation", () => {
  it("launches an uppercase client UUID and accepts its lowercase retry as the same input", async () => {
    const owner = await publicChatActor(context);
    const clientEventId = randomUUID().toUpperCase();
    const canonicalId = clientEventId.toLowerCase();
    const input = {
      agentId: owner.agentId,
      clientEventId,
      prompt: "Use the same input identity across preparation and retry",
    };
    const sent = await owner.run(() => {
      return chat.requestSendEvent(owner.actor, input, [201]);
    });
    if (sent.status !== 201) {
      throw new Error("Expected the input to be accepted");
    }
    await flushWaitUntilForTest();
    const messages = await chat.listThreadEvents(
      owner.actor,
      sent.body.threadId,
    );
    const launched = userMessages(messages.events).find((message) => {
      return message.revokesEventId === canonicalId;
    });
    if (!launched?.runId) {
      throw new Error("Expected the uppercase UUID input to launch a Run");
    }
    const runId = launched.runId;
    const execution = await owner.runExecution(runId);
    await owner.run(() => {
      return chat.requestSendEvent(
        owner.actor,
        {
          ...input,
          threadId: sent.body.threadId,
          clientEventId: canonicalId,
        },
        [201],
      );
    });
    await flushWaitUntilForTest();
    const retried = await chat.listThreadEvents(
      owner.actor,
      sent.body.threadId,
    );
    expect(
      userMessages(retried.events).filter((message) => {
        return message.revokesEventId === canonicalId;
      }),
    ).toMatchObject([{ runId }]);
    await owner.run(() => {
      return cancelChatRun(owner.actor, runId, execution.sandboxHeaders);
    });
  });

  it("rejects invalid model settings before resolving unavailable attachments", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    const before = await chat.listThreadEvents(actor, thread.id);
    const fileId = randomUUID();
    context.mocks.s3.send.mockRejectedValue(
      new Error("attachment unavailable"),
    );
    const rejected = await requestSendEventRaw(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Reject before attachment preparation",
      runOptions: { reasoningEffort: "xhigh" },
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "missing.txt",
            contentType: "text/plain",
          },
        ],
      },
      hasTextContent: true,
    });
    expect(rejected).toStrictEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Reasoning effort is not supported by the selected model",
        },
      },
    });
    await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).toStrictEqual(before.events);
  });

  it("does not enqueue when the caller aborts during attachment lookup", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, { agentId });
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    const before = await chat.listThreadEvents(actor, thread.id);
    const controller = new AbortController();
    const error = new Error("client disconnected during attachment lookup");
    error.name = "AbortError";
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        controller.abort(error);
      }
      return Promise.resolve({ Contents: [] });
    });
    const rejected = await requestSendEventRaw(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "abort before enqueue",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: randomUUID(),
              filenameSnapshot: "aborted.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "abort before enqueue" },
          ],
        },
      },
      controller.signal,
    );
    expect(controller.signal.aborted).toBeTruthy();
    expect(rejected).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
    const after = await chat.listThreadEvents(actor, thread.id);
    expect(after.events).toStrictEqual(before.events);
  });

  it("rejects an unknown model without changing thread events", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "early preload rejection anchor",
    });
    const execution = await runExecution(first.runId);
    await cancelChatRun(actor, first.runId, execution.sandboxHeaders);
    await flushWaitUntilForTest();
    const before = await chat.listThreadEvents(actor, first.threadId);
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        clientEventId: randomUUID(),
        model: "missing-preload-rejection-model",
        prompt: "must not enqueue",
      },
      [400],
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: 'Unknown model "missing-preload-rejection-model"',
      },
    });
    // Await only work scheduled by the rejected public request.
    await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
    const after = await chat.listThreadEvents(actor, first.threadId);
    expect(after.events).toStrictEqual(before.events);
  });
});
