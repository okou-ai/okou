import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { expect } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Publish bytes for the actual native session through authenticated callbacks. */
export async function completePublicPiHistory(
  context: TestContext,
  run: { readonly runId: string; readonly threadId: string },
  headers: { readonly authorization: string },
  content: string,
) {
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: run.threadId,
    timestamp: "2026-09-02T00:00:00.000Z",
  });
  session.appendMessage({ role: "user", content, timestamp: 1 });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "completed safely" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-luna",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const raw = Buffer.from(session.toJsonl(), "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  let preparedKey: string | undefined;
  const presign = context.mocks.s3.getSignedUrl.getMockImplementation();
  const transport = context.mocks.s3.send.getMockImplementation();
  if (!presign || !transport) {
    throw new Error("Expected configured object storage transport");
  }
  context.mocks.s3.getSignedUrl.mockImplementation(
    (client, command, options) => {
      if (command instanceof PutObjectCommand) {
        preparedKey = command.input.Key;
      }
      return presign(client, command, options);
    },
  );
  const webhooks = createWebhookCallbackApi(context);
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: run.runId,
      hash,
      rawSize: raw.length,
      encodedSize: raw.length,
      encoding: "identity",
    },
    headers,
    [200],
  );
  if (presign) {
    context.mocks.s3.getSignedUrl.mockImplementation(presign);
  }
  const objectKey = preparedKey;
  if (!objectKey) {
    throw new Error("Expected the actual history object key");
  }
  context.sessionHistoryBlobs.set(objectKey, raw);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key === objectKey
    ) {
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator]() {
            yield raw;
          },
        },
        ContentLength: raw.length,
      });
    }
    return transport(command);
  });
  await webhooks.requestAgentEvents(
    {
      runId: run.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 1,
          message: { content: [{ type: "text", text: "completed safely" }] },
        },
        { type: "result", sequenceNumber: 2, result: "completed safely" },
      ],
    },
    headers,
    [200],
  );
  const result = await webhooks.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 0,
      lastEventSequence: 2,
      checkpoint: {
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: hash,
      },
    },
    headers,
    [200],
  );
  expect(result.status).toBe(200);
  await flushWaitUntilForTest();
  return { hash, objectKey };
}
