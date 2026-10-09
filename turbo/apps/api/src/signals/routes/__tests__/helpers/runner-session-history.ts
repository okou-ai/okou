import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { expect } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Serve matching external S3 bytes only at the real Runner prepare's authorized key. */
export async function prepareRunnerSessionHistory(
  context: TestContext,
  runId: string,
  headers: { readonly authorization: string },
  history: string,
): Promise<string> {
  const bytes = Buffer.from(history);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const presign = context.mocks.s3.getSignedUrl.getMockImplementation();
  const transport = context.mocks.s3.send.getMockImplementation();
  if (!presign || !transport) {
    throw new Error("Expected a configured external S3 transport");
  }
  let preparedKey: string | undefined;
  context.mocks.s3.getSignedUrl.mockImplementation(
    (client, command, options) => {
      if (command instanceof PutObjectCommand) {
        preparedKey = command.input.Key;
      }
      return presign(client, command, options);
    },
  );
  const prepared = await createWebhookCallbackApi(context)
    .requestAgentSessionHistoryPrepare(
      {
        runId,
        hash,
        rawSize: bytes.length,
        encodedSize: bytes.length,
        encoding: "identity",
      },
      headers,
      [200],
    )
    .finally(() => {
      context.mocks.s3.getSignedUrl.mockImplementation(presign);
    });
  if (prepared.status !== 200) {
    throw new Error("Expected authorized session history prepare to succeed");
  }
  expect(prepared.body.existing).toBeFalsy();
  expect(prepared.body.presignedUrl).toBeTruthy();
  if (!preparedKey) {
    throw new Error("Expected the authorized history object key");
  }
  const key = preparedKey;
  context.mocks.s3.send.mockImplementation((command) => {
    if (command instanceof GetObjectCommand && command.input.Key === key) {
      return Promise.resolve({
        Body: Readable.from([bytes]),
        ContentLength: bytes.length,
      });
    }
    return transport(command);
  });
  return hash;
}
