import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { postConcurrencyEntitlementsInvoicePaid } from "./helpers/stripe-billing-webhook";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  cancelChatRun,
} = createChatEventsFixture(context);

describe("chat concurrency capacity prefetch", () => {
  it("keeps the captured subscription limit while live occupancy queues and releases fresh picks", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, customerId } = await entitledNativeChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const at = now();
    const periodEnd = at + 3_600_000;
    await postConcurrencyEntitlementsInvoicePaid(context.signal, {
      orgId: actor.orgId,
      userId: actor.userId,
      customerId,
      subscriptionId: `sub_${randomUUID()}`,
      lines: [
        { slots: 1, startsAt: new Date(at), expiresAt: new Date(periodEnd) },
      ],
    });
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "hold the base slot",
    });
    const fileId = randomUUID();
    const filename = "capacity-snapshot.txt";
    const key = buildArtifactKeyV2(fileId, filename);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const originalSend = context.mocks.s3.send.getMockImplementation();
    if (!originalSend) {
      throw new Error("Expected the fixture's S3 implementation");
    }
    context.mocks.s3.send.mockImplementation(async (request: unknown) => {
      if (request instanceof HeadObjectCommand && request.input.Key === key) {
        entered.resolve(undefined);
        await release.promise;
        return {
          ContentLength: 42,
          ContentType: "text/plain",
          LastModified: new Date(at),
          Metadata: {
            "artifact-id": fileId,
            filename: encodeURIComponent(filename),
            "user-id": encodeURIComponent(actor.userId),
          },
        };
      }
      return await originalSend(request);
    });
    const sending = sendChatRun(actor, {
      agentId,
      prompt: "use the captured paid slot",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: "use the captured paid slot" },
        ],
      },
    });
    await entered.promise;
    // The external attachment response follows context creation. Crossing the
    // paid-through grace boundary proves pick consumes that context's cutoff,
    // rather than issuing a live subscription read. No SQL/log assertions.
    mockNow(periodEnd + 86_400_001);
    release.resolve(undefined);
    const captured = await sending;
    expect((await api.readRun(actor, captured.runId)).prompt).toBe(
      `[Web file] ${filename} (text/plain)\n   [ID] ${fileId}\n\nuse the captured paid slot`,
    );

    // A new context observes the expired subscription: the base limit is one.
    // Both active runs still count, including the one admitted by the snapshot.
    const eventId = randomUUID();
    const waiting = await sendWaitingChatInput(actor, {
      agentId,
      prompt: "wait for live occupancy to fall below the fresh limit",
      clientEventId: eventId,
    });
    const hasRun = async () => {
      return userMessages(
        (await chat.listThreadEvents(actor, waiting.threadId)).events,
      ).some((event) => {
        return (
          event.revokesEventId === eventId && typeof event.runId === "string"
        );
      });
    };
    await expect(hasRun()).resolves.toBeFalsy();
    await cancelChatRun(actor, captured.runId);
    await expect(hasRun()).resolves.toBeFalsy();
    await cancelChatRun(actor, blocker.runId);
    const promoted = await waiting.launchedRun();
    expect((await api.readRun(actor, promoted.runId)).prompt).toBe(
      "wait for live occupancy to fall below the fresh limit",
    );
    expect(promoted.runId).not.toBe(captured.runId);
    expect(promoted.runId).not.toBe(blocker.runId);
    await cancelChatRun(actor, promoted.runId);
  });
});
