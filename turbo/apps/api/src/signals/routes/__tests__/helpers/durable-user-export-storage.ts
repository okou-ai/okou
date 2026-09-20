import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import type { TestContext } from "../../../../__tests__/test-context";
import { nowDate } from "../../../../lib/time";

interface StoredObject {
  readonly bytes: Buffer;
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag: string;
}

interface StoredUpload {
  readonly key: string;
  readonly initiated: Date;
  readonly metadata: Readonly<Record<string, string>>;
  readonly parts: Map<number, StoredObject>;
}

type ExportWriteCommand =
  | PutObjectCommand
  | UploadPartCommand
  | CompleteMultipartUploadCommand;

type ExportObjectCommand =
  | ExportWriteCommand
  | GetObjectCommand
  | HeadObjectCommand
  | CreateMultipartUploadCommand
  | ListPartsCommand
  | AbortMultipartUploadCommand;

function exportObjectCommand(command: unknown): command is ExportObjectCommand {
  return (
    command instanceof PutObjectCommand ||
    command instanceof GetObjectCommand ||
    command instanceof HeadObjectCommand ||
    command instanceof CreateMultipartUploadCommand ||
    command instanceof UploadPartCommand ||
    command instanceof ListPartsCommand ||
    command instanceof CompleteMultipartUploadCommand ||
    command instanceof AbortMultipartUploadCommand
  );
}

interface ExportStorageOptions {
  readonly prefixes?: readonly string[];
  readonly afterWrite?: (command: ExportWriteCommand) => Promise<void>;
}

function storedObject(
  bytes: Buffer,
  metadata: Readonly<Record<string, string>> = {},
): StoredObject {
  return {
    bytes: Buffer.from(bytes),
    metadata,
    etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
  };
}

function readBytes(body: unknown): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected export object bytes");
}

function missingObject(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function rangeBytes(bytes: Buffer, range: string | undefined): Buffer {
  if (range === undefined) {
    return bytes;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match?.[1]) {
    throw new Error(`Unsupported export byte range: ${range}`);
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) + 1 : bytes.length;
  return bytes.subarray(start, end);
}

/** Preserve external objects and multipart receipts across worker requests. */
export function installDurableUserExportStorage(
  context: TestContext,
  options: ExportStorageOptions = {},
) {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, StoredUpload>();
  const prefixes = options.prefixes ?? ["exports/"];
  const otherStorage = context.mocks.s3.send.getMockImplementation();
  const otherSignedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();

  function handles(key: string | undefined): key is string {
    return (
      key !== undefined &&
      prefixes.some((prefix) => {
        return key.startsWith(prefix);
      })
    );
  }

  function uploadFor(uploadId: string | undefined, key: string): StoredUpload {
    const upload = uploadId ? uploads.get(uploadId) : undefined;
    if (!upload || upload.key !== key) {
      throw missingObject("Multipart upload not found");
    }
    return upload;
  }

  context.mocks.s3.getSignedUrl.mockImplementation((client, command) => {
    if (command instanceof GetObjectCommand && handles(command.input.Key)) {
      return Promise.resolve(
        `https://user-export.example.test/${encodeURIComponent(command.input.Key)}`,
      );
    }
    return (
      otherSignedUrl?.(client, command) ??
      Promise.resolve("https://storage.example.test/download")
    );
  });

  function listObjects(command: ListObjectsV2Command, prefix: string) {
    const keys = [...objects.keys()]
      .filter((key) => {
        return key.startsWith(prefix);
      })
      .sort();
    const offset = Number(command.input.ContinuationToken ?? "0");
    const page = keys.slice(offset, offset + (command.input.MaxKeys ?? 1000));
    const next = offset + page.length;
    return {
      Contents: page.map((key) => {
        return { Key: key, Size: objects.get(key)?.bytes.length ?? 0 };
      }),
      IsTruncated: next < keys.length,
      NextContinuationToken: next < keys.length ? String(next) : undefined,
    };
  }

  async function writeObject(command: PutObjectCommand, key: string) {
    const object = storedObject(
      readBytes(command.input.Body),
      command.input.Metadata,
    );
    objects.set(key, object);
    await options.afterWrite?.(command);
    return { ETag: object.etag };
  }

  function readObject(
    command: GetObjectCommand | HeadObjectCommand,
    key: string,
  ) {
    const object = objects.get(key);
    if (!object) {
      throw missingObject(`Export object not found: ${key}`);
    }
    if (command.input.IfMatch && command.input.IfMatch !== object.etag) {
      throw new Error("Export object changed before its range read");
    }
    const bytes = rangeBytes(object.bytes, command.input.Range);
    const start = command.input.Range
      ? Number(/^bytes=(\d+)-/.exec(command.input.Range)?.[1])
      : undefined;
    return {
      Body: Readable.from([bytes]),
      ContentLength: bytes.length,
      ETag: object.etag,
      Metadata: object.metadata,
      ContentRange:
        start === undefined
          ? undefined
          : `bytes ${start}-${start + bytes.length - 1}/${object.bytes.length}`,
    };
  }

  async function multipart(
    command:
      | CreateMultipartUploadCommand
      | UploadPartCommand
      | ListPartsCommand
      | CompleteMultipartUploadCommand
      | AbortMultipartUploadCommand,
    key: string,
  ) {
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = randomUUID();
      uploads.set(uploadId, {
        key,
        initiated: nowDate(),
        metadata: command.input.Metadata ?? {},
        parts: new Map(),
      });
      return { UploadId: uploadId };
    }
    const upload = uploadFor(command.input.UploadId, key);
    if (command instanceof UploadPartCommand) {
      if (!command.input.PartNumber) {
        throw new Error("Expected a multipart part number");
      }
      const part = storedObject(readBytes(command.input.Body));
      upload.parts.set(command.input.PartNumber, part);
      await options.afterWrite?.(command);
      return { ETag: part.etag };
    }
    if (command instanceof ListPartsCommand) {
      return {
        Parts: [...upload.parts].map(([partNumber, part]) => {
          return { PartNumber: partNumber, ETag: part.etag };
        }),
        IsTruncated: false,
      };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      uploads.delete(command.input.UploadId ?? "");
      return {};
    }
    const parts = command.input.MultipartUpload?.Parts ?? [];
    const buffers = parts.map((part) => {
      const stored = upload.parts.get(part.PartNumber ?? 0);
      if (!stored || stored.etag !== part.ETag) {
        throw new Error("Missing or changed multipart export part");
      }
      return stored.bytes;
    });
    objects.set(key, storedObject(Buffer.concat(buffers), upload.metadata));
    uploads.delete(command.input.UploadId ?? "");
    await options.afterWrite?.(command);
    return {};
  }

  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (
      command instanceof ListMultipartUploadsCommand &&
      handles(command.input.Prefix)
    ) {
      const prefix = command.input.Prefix;
      const matching = [...uploads.entries()].filter(([, upload]) => {
        return upload.key.startsWith(prefix);
      });
      const page = matching.slice(0, command.input.MaxUploads ?? 1000);
      return {
        Uploads: page.map(([uploadId, upload]) => {
          return {
            Key: upload.key,
            UploadId: uploadId,
            Initiated: upload.initiated,
          };
        }),
        IsTruncated: page.length < matching.length,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const keys = command.input.Delete?.Objects ?? [];
      if (
        keys.every((item) => {
          return handles(item.Key);
        })
      ) {
        for (const item of keys) {
          if (item.Key) {
            objects.delete(item.Key);
          }
        }
        return { Errors: [] };
      }
    }
    if (
      command instanceof ListObjectsV2Command &&
      handles(command.input.Prefix)
    ) {
      return listObjects(command, command.input.Prefix);
    }
    if (!exportObjectCommand(command) || !handles(command.input.Key)) {
      return (await otherStorage?.(command)) ?? {};
    }
    const key = command.input.Key;
    if (command instanceof PutObjectCommand) {
      return await writeObject(command, key);
    }
    if (
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand
    ) {
      return readObject(command, key);
    }
    return await multipart(command, key);
  });

  return {
    seedObject(key: string, bytes: Buffer): void {
      objects.set(key, storedObject(bytes));
    },
    seedMultipartUpload(key: string, initiated: Date): string {
      const uploadId = randomUUID();
      uploads.set(uploadId, { key, initiated, metadata: {}, parts: new Map() });
      return uploadId;
    },
    objectKeys(prefix: string): readonly string[] {
      return [...objects.keys()].filter((key) => {
        return key.startsWith(prefix);
      });
    },
    hasObject(key: string): boolean {
      return objects.has(key);
    },
    hasMultipartUpload(uploadId: string): boolean {
      return uploads.has(uploadId);
    },
    download(url: string): Buffer {
      const key = decodeURIComponent(new URL(url).pathname.slice(1));
      const object = objects.get(key);
      if (!object) {
        throw new Error("The export download has no stored object");
      }
      return Buffer.from(object.bytes);
    },
  };
}
