import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactDeliveryRecordSchema } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { http, HttpResponse } from "msw";

import type { TestContext } from "../../../../__tests__/test-context";
import { server } from "../../../../mocks/server";

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly metadata: Record<string, string>;
}

function etag(object: StoredObject): string {
  return `"${createHash("sha256").update(object.bytes).digest("hex")}"`;
}

async function objectBytes(body: unknown): Promise<Buffer> {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        throw new Error("Expected an object byte stream");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Expected an object body");
}

async function putStoredObject(
  objects: Map<string, StoredObject>,
  command: PutObjectCommand,
  rejectCopies: boolean,
) {
  const path = `${command.input.Bucket}/${command.input.Key}`;
  if (
    rejectCopies &&
    command.input.Key?.startsWith("artifacts/shared-threads/")
  ) {
    throw new Error("Object copy failed");
  }
  if (command.input.IfNoneMatch === "*" && objects.has(path)) {
    throw Object.assign(new Error("Object already exists"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
  }
  const previous = objects.get(path);
  if (
    command.input.IfMatch &&
    (!previous || command.input.IfMatch !== etag(previous))
  ) {
    throw Object.assign(new Error("Object changed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
  }
  objects.set(path, {
    bytes: await objectBytes(command.input.Body),
    contentType: command.input.ContentType ?? "application/octet-stream",
    metadata: command.input.Metadata ?? {},
  });
  return {};
}

function copyStoredObject(
  objects: Map<string, StoredObject>,
  command: CopyObjectCommand,
  rejectCopies: boolean,
) {
  if (rejectCopies) {
    throw new Error("Object copy failed");
  }
  const source = objects.get(
    decodeURIComponent(command.input.CopySource ?? ""),
  );
  if (
    !source ||
    (command.input.CopySourceIfMatch !== undefined &&
      command.input.CopySourceIfMatch !== etag(source))
  ) {
    throw new Error("Copy source is missing or changed");
  }
  objects.set(`${command.input.Bucket}/${command.input.Key}`, {
    bytes: Buffer.from(source.bytes),
    contentType: command.input.ContentType ?? source.contentType,
    metadata: command.input.Metadata ?? {},
  });
  return {};
}

function readStoredObject(
  objects: Map<string, StoredObject>,
  command: HeadObjectCommand | GetObjectCommand,
) {
  const object = objects.get(`${command.input.Bucket}/${command.input.Key}`);
  if (!object) {
    throw Object.assign(new Error("Object not found"), {
      name: command instanceof GetObjectCommand ? "NoSuchKey" : "NotFound",
    });
  }
  if (
    command instanceof GetObjectCommand &&
    command.input.IfMatch &&
    command.input.IfMatch !== etag(object)
  ) {
    throw new Error("Read source changed");
  }
  return {
    ContentLength: object.bytes.length,
    ContentType: object.contentType,
    LastModified: new Date("2026-09-15T00:00:00Z"),
    ETag: etag(object),
    Metadata: object.metadata,
    Body: Readable.from([object.bytes]),
  };
}

/** Emulate object storage and public delivery, including upload/copy bytes. */
export function installSharedThreadStorage(context: TestContext) {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<
    string,
    { readonly path: string; readonly input: PutObjectCommand["input"] }
  >();
  const otherStorage = context.mocks.s3.send.getMockImplementation();
  let rejectCopies = false;
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    if (!(command instanceof PutObjectCommand)) {
      return Promise.resolve("https://attachment-storage.example/download");
    }
    const path = `${command.input.Bucket}/${command.input.Key}`;
    const url = `https://attachment-storage.example/${path}`;
    uploads.set(url, { path, input: command.input });
    return Promise.resolve(url);
  });
  context.mocks.s3.send.mockImplementation(async (command) => {
    if (
      !(
        command instanceof HeadObjectCommand ||
        command instanceof GetObjectCommand ||
        command instanceof ListObjectsV2Command ||
        command instanceof PutObjectCommand ||
        command instanceof DeleteObjectsCommand ||
        command instanceof CopyObjectCommand
      )
    ) {
      throw new Error("Unexpected storage operation");
    }
    const bucket = command.input.Bucket;
    if (
      bucket !== "test-user-artifacts" &&
      bucket !== "test-private-artifacts" &&
      bucket !== "test-hosted-sites"
    ) {
      if (!otherStorage) {
        throw new Error("Missing storage fixture");
      }
      return await otherStorage(command);
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        objects.delete(`${bucket}/${object.Key}`);
      }
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = `${bucket}/${command.input.Prefix}`;
      return {
        Contents: [...objects]
          .filter(([path]) => {
            return path.startsWith(prefix);
          })
          .map(([path, object]) => {
            return {
              Key: path.slice(`${bucket}/`.length),
              Size: object.bytes.length,
              LastModified: new Date("2026-09-15T00:00:00Z"),
            };
          }),
      };
    }
    if (command instanceof PutObjectCommand) {
      return await putStoredObject(objects, command, rejectCopies);
    }
    if (command instanceof CopyObjectCommand) {
      return copyStoredObject(objects, command, rejectCopies);
    }
    return readStoredObject(objects, command);
  });
  server.use(
    http.get("https://*.okou.app/*", ({ request }) => {
      const url = new URL(request.url);
      const alias = url.hostname.split(".")[0];
      const registration = objects.get(
        `test-hosted-sites/artifact-delivery/okou/html/${alias}.json`,
      );
      if (!registration) {
        return new HttpResponse(null, { status: 404 });
      }
      const record = artifactDeliveryRecordSchema.parse(
        JSON.parse(registration.bytes.toString()),
      );
      if (record.kind !== "thread-resource") {
        return new HttpResponse(null, { status: 404 });
      }
      const parent = objects.get(
        `test-hosted-sites/${sharedThreadArtifactPolicyKey(record.publicBrand, record.threadId)}`,
      );
      if (!parent) {
        return new HttpResponse(null, { status: 404 });
      }
      const policy = sharedThreadArtifactPolicySchema.parse(
        JSON.parse(parent.bytes.toString()),
      );
      const target = policy.resources[record.publicToken];
      if (policy.status !== "active" || target?.kind !== "html") {
        return new HttpResponse(null, { status: 404 });
      }
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = target.manifest.files[path];
      const object = objects.get(
        `test-hosted-sites/shared-artifacts/${record.publicBrand}/${target.snapshotId}/${target.id}${path}`,
      );
      return file && object
        ? new HttpResponse(new Uint8Array(object.bytes), {
            headers: { "Content-Type": file.contentType },
          })
        : new HttpResponse(null, { status: 404 });
    }),
    http.put("https://attachment-storage.example/*", async ({ request }) => {
      const upload = uploads.get(request.url);
      if (!upload) {
        return new HttpResponse(null, { status: 403 });
      }
      objects.set(upload.path, {
        bytes: Buffer.from(await request.arrayBuffer()),
        contentType: upload.input.ContentType ?? "application/octet-stream",
        metadata: upload.input.Metadata ?? {},
      });
      return new HttpResponse(null, { status: 200 });
    }),
    http.get("https://a.okou.io/*", ({ request }) => {
      const alias = new URL(request.url).pathname.slice(1);
      const registration = objects.get(
        `test-hosted-sites/artifact-delivery/files/${encodeURIComponent(alias)}.json`,
      );
      if (!registration) {
        return new HttpResponse(null, { status: 404 });
      }
      const record = artifactDeliveryRecordSchema.parse(
        JSON.parse(registration.bytes.toString()),
      );
      if (record.kind === "thread-resource") {
        const policyObject = objects.get(
          `test-hosted-sites/${sharedThreadArtifactPolicyKey(record.publicBrand, record.threadId)}`,
        );
        if (!policyObject) {
          return new HttpResponse(null, { status: 404 });
        }
        const policy = sharedThreadArtifactPolicySchema.parse(
          JSON.parse(policyObject.bytes.toString()),
        );
        const target = policy.resources[record.publicToken];
        if (policy.status !== "active" || target?.kind !== "file") {
          return new HttpResponse(null, { status: 404 });
        }
        const object = objects.get(`test-private-artifacts/${target.key}`);
        return object
          ? new HttpResponse(new Uint8Array(object.bytes), {
              headers: { "Content-Type": target.contentType },
            })
          : new HttpResponse(null, { status: 404 });
      }
      if (record.kind !== "legacy-file") {
        throw new Error("Expected public file delivery");
      }
      const object = objects.get(`test-user-artifacts/${record.key}`);
      if (!object) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(new Uint8Array(object.bytes), {
        headers: { "Content-Type": record.contentType },
      });
    }),
  );
  return {
    snapshotThreadId(url: string) {
      const alias = new URL(url).pathname.slice(1);
      const registration = objects.get(
        `test-hosted-sites/artifact-delivery/files/${encodeURIComponent(alias)}.json`,
      );
      if (!registration) {
        throw new Error("Expected a registered snapshot URL");
      }
      const record = artifactDeliveryRecordSchema.parse(
        JSON.parse(registration.bytes.toString()),
      );
      if (record.kind !== "thread-resource") {
        throw new Error("Expected a snapshot delivery record");
      }
      return record.threadId;
    },
    removeUpload(url: string) {
      const upload = uploads.get(url);
      if (!upload) {
        throw new Error("Upload not found");
      }
      objects.delete(upload.path);
    },
    rejectCopies() {
      rejectCopies = true;
    },
  };
}
