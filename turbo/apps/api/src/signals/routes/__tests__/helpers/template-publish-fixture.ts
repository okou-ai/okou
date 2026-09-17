import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";

import type { TestContext } from "../../../../__tests__/test-context";
import { nowDate } from "../../../../lib/time";
import type { ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";

/**
 * The S3 double and upload walk that publishing a compiled template needs.
 *
 * Publishing takes ids the run already uploaded, so a test cannot fabricate
 * them: it has to walk the real prepare/put/complete sequence against a store
 * that answers Head and Get the way R2 does. Both template publish suites need
 * exactly that, so it lives here rather than in either one.
 */
interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
}

function commandInput(command: unknown): Record<string, unknown> {
  return typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
    ? (command.input as Record<string, unknown>)
    : {};
}

function objectId(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

function notFoundError(key: string): Error {
  return Object.assign(new Error(`Missing S3 object: ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function byteStream(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

/** A minimal ustar archive, so the test exercises the real tar reader. */
export function tarGz(
  files: readonly { path: string; content: string }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write("0", 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocks.push(header);
    const padding = (512 - (content.length % 512)) % 512;
    blocks.push(content, Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function installS3Fixture(context: TestContext) {
  const objects = new Map<string, StoredObject>();
  const signedPuts = new Map<
    string,
    {
      bucket: string;
      key: string;
      metadata: Readonly<Record<string, string>>;
    }
  >();
  let signature = 0;

  function readMetadata(input: Record<string, unknown>) {
    return typeof input.Metadata === "object" && input.Metadata !== null
      ? (input.Metadata as Readonly<Record<string, string>>)
      : {};
  }

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const key = typeof input.Key === "string" ? input.Key : "";
    const id = objectId(bucket, key);

    if (command instanceof PutObjectCommand) {
      const body = input.Body;
      objects.set(id, {
        body: Buffer.isBuffer(body)
          ? Buffer.from(body)
          : Buffer.from(String(body ?? ""), "utf8"),
        contentType:
          typeof input.ContentType === "string" ? input.ContentType : undefined,
        metadata: readMetadata(input),
      });
      return Promise.resolve({});
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      return Promise.resolve({
        Contents: [...objects.entries()].flatMap(([storedId, object]) => {
          const separator = storedId.indexOf("\0");
          const storedKey = storedId.slice(separator + 1);
          return storedId.slice(0, separator) === bucket &&
            storedKey.startsWith(prefix)
            ? [
                {
                  Key: storedKey,
                  Size: object.body.length,
                  LastModified: nowDate(),
                },
              ]
            : [];
        }),
      });
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(id);
      // The SDK rejects on a missing object; it does not throw synchronously.
      return object
        ? Promise.resolve({
            ContentLength: object.body.length,
            ContentType: object.contentType,
            Metadata: object.metadata,
            LastModified: nowDate(),
          })
        : Promise.reject(notFoundError(key));
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(id);
      return object
        ? Promise.resolve({
            Body: byteStream(object.body),
            ContentLength: object.body.length,
            ContentType: object.contentType,
          })
        : Promise.reject(notFoundError(key));
    }
    return Promise.resolve({});
  });

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const input = commandInput(command);
      signature += 1;
      const url = `https://r2.example.test/signed/${signature.toString()}`;
      if (command instanceof PutObjectCommand) {
        signedPuts.set(url, {
          bucket: typeof input.Bucket === "string" ? input.Bucket : "",
          key: typeof input.Key === "string" ? input.Key : "",
          metadata: readMetadata(input),
        });
      }
      return Promise.resolve(url);
    },
  );

  return {
    put(uploadUrl: string, body: Buffer, contentType: string): void {
      const target = signedPuts.get(uploadUrl);
      if (!target) {
        throw new Error(`Unknown presigned PUT: ${uploadUrl}`);
      }
      objects.set(objectId(target.bucket, target.key), {
        body,
        contentType,
        metadata: target.metadata,
      });
    },
    keys(): readonly string[] {
      return [...objects.keys()].map((id) => {
        return id.slice(id.indexOf("\0") + 1);
      });
    },
  };
}

export type Fixture = ReturnType<typeof installS3Fixture>;

/** Run the ordinary three-step upload the CLI would run, and return its id. */
export async function uploadTemplateFile(
  context: TestContext,
  actor: ApiTestUser,
  fixture: Fixture,
  file: { readonly filename: string; readonly contentType: string },
  body: Buffer,
): Promise<string> {
  const chat = createChatFilesBddApi(context);
  const prepared = await chat.prepareUpload(actor, {
    filename: file.filename,
    contentType: file.contentType,
    size: body.length,
  });
  if (!("uploadUrl" in prepared)) {
    throw new Error("Expected a single-part upload");
  }
  fixture.put(prepared.uploadUrl, body, file.contentType);
  const completed = await chat.completeUpload(actor, { id: prepared.id });
  return completed.id;
}
