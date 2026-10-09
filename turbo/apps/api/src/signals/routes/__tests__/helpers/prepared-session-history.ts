import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { TestContext } from "../../../../__tests__/test-context";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

export function captureSessionStorageMocks(context: TestContext) {
  const send = context.mocks.s3.send.getMockImplementation();
  const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
  return () => {
    if (send) {
      context.mocks.s3.send.mockImplementation(send);
    } else {
      context.mocks.s3.send.mockReset();
    }
    if (sign) {
      context.mocks.s3.getSignedUrl.mockImplementation(sign);
    } else {
      context.mocks.s3.getSignedUrl.mockReset();
    }
  };
}

/** Supply external bytes only at the object key authorized for this claimed Run. */
export async function prepareSessionHistoryBytes(
  context: TestContext,
  runId: string,
  headers: { readonly authorization: string },
  bytes: Buffer,
  retainStorageEnvironment: (restore: () => void) => void,
) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
  if (!sign) {
    throw new Error("Expected the external object-storage signer");
  }
  let authorized: { bucket: string; key: string } | undefined;
  context.mocks.s3.getSignedUrl.mockImplementation((...args) => {
    const command = args[1];
    if (
      command instanceof PutObjectCommand &&
      command.input.Bucket &&
      command.input.Key === `blobs/${hash}.blob`
    ) {
      authorized = { bucket: command.input.Bucket, key: command.input.Key };
    }
    return sign(...args);
  });
  retainStorageEnvironment(captureSessionStorageMocks(context));
  const prepared = await createWebhookCallbackApi(
    context,
  ).requestAgentSessionHistoryPrepare(
    {
      runId,
      hash,
      rawSize: bytes.length,
      encodedSize: bytes.length,
      encoding: "identity",
    },
    headers,
    [200],
  );
  if (
    prepared.status !== 200 ||
    prepared.body.existing ||
    !prepared.body.presignedUrl ||
    !authorized
  ) {
    throw new Error("Expected the actual new history upload authorization");
  }
  const upload = authorized;
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.getSignedUrl.mockImplementation(sign);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof HeadObjectCommand ||
        command instanceof GetObjectCommand) &&
      command.input.Bucket === upload.bucket &&
      command.input.Key === upload.key
    ) {
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
          transformToByteArray: () => {
            return Promise.resolve(bytes);
          },
        },
      });
    }
    if (!fallback) {
      throw new Error("Expected the external object-storage adapter");
    }
    return fallback(command);
  });
  retainStorageEnvironment(captureSessionStorageMocks(context));
  return hash;
}
