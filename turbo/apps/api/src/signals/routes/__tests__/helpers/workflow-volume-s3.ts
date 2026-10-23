import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { TestContext } from "../../../../__tests__/test-context";

function s3BodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected an S3 object body");
}

function missingS3Object(key: string): Error {
  return Object.assign(new Error(`Missing S3 object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

export function installWorkflowVolumeS3Fixture(
  context: TestContext,
  objects = new Map<string, Buffer>(),
) {
  const writes: { readonly key: string; readonly body: Buffer }[] = [];
  let beforeNextArchiveWrite:
    ((key: string, body: Buffer) => void | Promise<void>) | undefined;

  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = s3BodyBuffer(command.input.Body);
      if (key.endsWith("/archive.tar.gz") && beforeNextArchiveWrite) {
        const callback = beforeNextArchiveWrite;
        beforeNextArchiveWrite = undefined;
        await callback(key, body);
      }
      objects.set(key, body);
      writes.push({ key, body });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = objects.get(key);
      if (!body) {
        throw missingS3Object(key);
      }
      return { ContentLength: body.length };
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = objects.get(key);
      if (!body) {
        throw missingS3Object(key);
      }
      return { Body: Readable.from([body]), ContentLength: body.length };
    }
    return {};
  });

  return {
    objects,
    writes,
    clearWrites(): void {
      writes.length = 0;
    },
    beforeNextArchiveWrite(
      callback: (key: string, body: Buffer) => void | Promise<void>,
    ): void {
      beforeNextArchiveWrite = callback;
    },
  };
}
