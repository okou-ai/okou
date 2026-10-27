import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  UploadPartCommand,
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
  const uploads = new Map<
    string,
    { readonly key: string; readonly parts: Map<number, Buffer> }
  >();
  let beforeNextArchiveWrite:
    ((key: string, body: Buffer) => void | Promise<void>) | undefined;
  let afterNextArchiveWrite:
    ((key: string, body: Buffer) => void | Promise<void>) | undefined;
  let beforeNextDelete:
    ((keys: readonly string[]) => void | Promise<void>) | undefined;

  async function multipart(command: unknown) {
    if (command instanceof CreateMultipartUploadCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const uploadId = randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const upload = uploads.get(command.input.UploadId ?? "");
      if (!upload || command.input.PartNumber === undefined) {
        throw Object.assign(new Error("Multipart upload was aborted"), {
          name: "NoSuchUpload",
        });
      }
      upload.parts.set(
        command.input.PartNumber,
        s3BodyBuffer(command.input.Body),
      );
      return { ETag: "fixture-etag" };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const uploadId = command.input.UploadId ?? "";
      const upload = uploads.get(uploadId);
      if (!upload) {
        throw Object.assign(new Error("Multipart upload was aborted"), {
          name: "NoSuchUpload",
        });
      }
      const body = Buffer.concat(
        [...upload.parts.entries()]
          .sort(([a], [b]) => {
            return a - b;
          })
          .map(([, part]) => {
            return part;
          }),
      );
      if (beforeNextArchiveWrite) {
        const callback = beforeNextArchiveWrite;
        beforeNextArchiveWrite = undefined;
        await callback(upload.key, body);
      }
      if (!uploads.has(uploadId)) {
        throw Object.assign(new Error("Multipart upload was aborted"), {
          name: "NoSuchUpload",
        });
      }
      uploads.delete(uploadId);
      objects.set(upload.key, body);
      writes.push({ key: upload.key, body });
      if (afterNextArchiveWrite) {
        const callback = afterNextArchiveWrite;
        afterNextArchiveWrite = undefined;
        await callback(upload.key, body);
      }
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) {
      uploads.delete(command.input.UploadId ?? "");
      return {};
    }
    return undefined;
  }

  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    const uploaded = await multipart(command);
    if (uploaded !== undefined) {
      return uploaded;
    }
    if (command instanceof DeleteObjectsCommand) {
      if (beforeNextDelete) {
        const callback = beforeNextDelete;
        beforeNextDelete = undefined;
        await callback(
          (command.input.Delete?.Objects ?? []).flatMap((object) => {
            return object.Key === undefined ? [] : [object.Key];
          }),
        );
      }
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key !== undefined) {
          objects.delete(object.Key);
        }
      }
      return {};
    }
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
    afterNextArchiveWrite(
      callback: (key: string, body: Buffer) => void | Promise<void>,
    ): void {
      afterNextArchiveWrite = callback;
    },
    beforeNextDelete(
      callback: (keys: readonly string[]) => void | Promise<void>,
    ): void {
      beforeNextDelete = callback;
    },
  };
}
