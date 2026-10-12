import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { expect } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Native Codex publishes its own JSONL format, never a retyped Pi session. */
export async function completePublicCodexHistory(
  context: TestContext,
  run: { readonly runId: string; readonly threadId: string },
  headers: { readonly authorization: string },
  content: string,
) {
  const timestamp = "2026-09-02T00:00:00.000Z";
  const records = [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: run.threadId,
        timestamp,
        cwd: "/home/user/workspace",
        originator: "codex_cli_rs",
        source: "cli",
        model_provider: "openai",
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "completed safely" }],
      },
    },
  ];
  const raw = Buffer.from(
    records
      .map((record) => {
        return JSON.stringify(record);
      })
      .join("\n") + "\n",
    "utf8",
  );
  return await completePublicHistory(context, run, headers, raw, "codex");
}

async function completePublicHistory(
  context: TestContext,
  run: { readonly runId: string; readonly threadId: string },
  headers: { readonly authorization: string },
  raw: Buffer,
  cliAgentType: "pi" | "codex",
) {
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
  await webhooks.requestAgentSessionHistoryPrepare(
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
      completion: {
        cliAgentType,
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
