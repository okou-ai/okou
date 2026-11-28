import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const MiB = 1024 * 1024;

interface Actor {
  readonly userId: string;
  readonly orgId: string | null;
}

interface StorageOperation {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface StoredObject {
  readonly size: number;
  readonly contentType: string;
  readonly metadata: Record<string, string>;
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsMultipartRoutes],
  })(uploadsContract);
}

function member(): Actor {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

/** In-memory R2 with a configurable multipart upload. */
function installStorage(options: {
  readonly uploadId: string;
  readonly uploadedParts: number;
  readonly completedObject?: (
    operation: Record<string, unknown>,
  ) => StoredObject;
}) {
  const objects = new Map<string, StoredObject>();
  const operations: StorageOperation[] = [];
  const signed: { url: string; expiresIn: number }[] = [];
  const objectKey = (bucket: unknown, key: unknown) => {
    return `${String(bucket)}/${String(key)}`;
  };

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown, signing: unknown) => {
      const { input } = command as {
        readonly input: { readonly Bucket: string; readonly Key: string };
      };
      const expiresIn =
        (signing as { readonly expiresIn?: number } | undefined)?.expiresIn ??
        0;
      const url = `https://r2.example.com/${input.Bucket}/${input.Key}?n=${signed.length}`;
      signed.push({ url, expiresIn });
      return Promise.resolve(url);
    },
  );

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    operations.push({ name: constructor.name, input });
    const stored = objects.get(objectKey(input.Bucket, input.Key));
    switch (constructor.name) {
      case "CreateMultipartUploadCommand": {
        return Promise.resolve({ UploadId: options.uploadId });
      }
      case "ListPartsCommand": {
        return Promise.resolve({
          Parts: Array.from({ length: options.uploadedParts }, (_, index) => {
            return { PartNumber: index + 1, ETag: `"etag-${index + 1}"` };
          }),
        });
      }
      case "CompleteMultipartUploadCommand": {
        if (options.completedObject) {
          objects.set(
            objectKey(input.Bucket, input.Key),
            options.completedObject(input),
          );
        }
        return Promise.resolve({});
      }
      case "ListObjectsV2Command": {
        const prefix = `${String(input.Bucket)}/${String(input.Prefix ?? "")}`;
        return Promise.resolve({
          Contents: [...objects.entries()]
            .filter(([key]) => {
              return key.startsWith(prefix);
            })
            .map(([key, object]) => {
              return {
                Key: key.slice(String(input.Bucket).length + 1),
                Size: object.size,
                LastModified: new Date("2026-01-01T00:00:00.000Z"),
              };
            }),
        });
      }
      case "HeadObjectCommand": {
        if (!stored) {
          return Promise.reject(
            Object.assign(new Error("Not found"), {
              name: "NotFound",
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        return Promise.resolve({
          ContentLength: stored.size,
          ContentType: stored.contentType,
          LastModified: new Date("2026-01-01T00:00:00.000Z"),
          Metadata: stored.metadata,
        });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(
            Object.assign(new Error("Not found"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        return Promise.resolve({
          ContentLength: stored.size,
          ContentType: stored.contentType,
          Body: Readable.from([Buffer.from("multipart-header-bytes")]),
        });
      }
      default: {
        return Promise.resolve({});
      }
    }
  });

  return { operations, signed };
}

const publicArtifactKey = /^artifacts\/[A-Za-z0-9_-]{10}\.mp4$/;
const publicArtifactUrl = /^https:\/\/a\.okou\.io\/[A-Za-z0-9_-]{10}\.mp4$/;

describe("multipart user artifact uploads", () => {
  it("uploads-multipart-003 prepares 5 MiB parts for a large upload", async () => {
    const storage = installStorage({
      uploadId: "multipart-upload-1",
      uploadedParts: 0,
    });
    const actor: Actor = { userId: `user_${randomUUID()}`, orgId: null };
    const api = signIn(actor);

    const prepared = await accept(
      api.prepare({
        headers,
        body: {
          filename: "recording.mp4",
          contentType: "video/mp4",
          size: 20 * MiB,
          multipart: true,
        },
      }),
      [200],
    );

    if (!("multipart" in prepared.body)) {
      throw new Error("Expected a multipart upload");
    }
    expect(prepared.body).toMatchObject({
      filename: "recording.mp4",
      contentType: "video/mp4",
      size: 20 * MiB,
    });
    expect(prepared.body.url).toMatch(publicArtifactUrl);
    expect(prepared.body.multipart.uploadId).toBe("multipart-upload-1");
    expect(prepared.body.multipart.partSize).toBe(5 * MiB);
    expect(
      prepared.body.multipart.parts.map((part) => {
        return part.partNumber;
      }),
    ).toStrictEqual([1, 2, 3, 4]);
    for (const part of prepared.body.multipart.parts) {
      expect(
        storage.signed.find((entry) => {
          return entry.url === part.uploadUrl;
        })?.expiresIn,
      ).toBe(172_800);
    }

    const names = storage.operations.map((operation) => {
      return operation.name;
    });
    const registration = storage.operations.find((operation) => {
      return (
        operation.name === "PutObjectCommand" &&
        String(operation.input.Body).includes('"legacy-file"')
      );
    });
    expect(registration).toBeDefined();
    const created = storage.operations.find((operation) => {
      return operation.name === "CreateMultipartUploadCommand";
    })!;
    expect(names.indexOf("PutObjectCommand")).toBeLessThan(
      names.indexOf("CreateMultipartUploadCommand"),
    );
    expect(created.input.Bucket).toBe(env("R2_USER_ARTIFACTS_BUCKET_NAME"));
    expect(String(created.input.Key)).toMatch(publicArtifactKey);
    expect(created.input.Metadata).toMatchObject({
      "artifact-id": prepared.body.id,
      filename: "recording.mp4",
      "public-brand": "okou",
      "user-id": actor.userId,
    });
  });

  it("uploads-multipart-004 prepares and completes a 5 GiB attachment within the 1000-part contract", async () => {
    const size = 5 * 1024 * MiB;
    installStorage({
      uploadId: "five-gib-upload",
      uploadedParts: 512,
      completedObject: () => {
        return { size, contentType: "video/mp4", metadata: {} };
      },
    });
    const api = signIn(member());

    const prepared = await accept(
      api.prepare({
        headers,
        body: {
          filename: "long-recording.mp4",
          contentType: "video/mp4",
          size,
          multipart: true,
        },
      }),
      [200],
    );
    if (!("multipart" in prepared.body)) {
      throw new Error("Expected a multipart upload");
    }
    const completed = await accept(
      api.completeMultipart({
        headers,
        body: {
          id: prepared.body.id,
          filename: "long-recording.mp4",
          uploadId: prepared.body.multipart.uploadId,
          partCount: prepared.body.multipart.parts.length,
        },
      }),
      [200],
    );

    expect(prepared.body.multipart.partSize).toBe(10 * MiB);
    expect(prepared.body.multipart.parts).toHaveLength(512);
    expect(completed.body).toStrictEqual({
      id: prepared.body.id,
      url: new URL(
        `/artifacts/${prepared.body.id.replace(/-/gu, "")}.mp4`,
        prepared.body.url,
      ).href,
    });
  });

  it("uploads-multipart-008 lists uploaded parts and completes the multipart upload", async () => {
    const actor = member();
    const id = randomUUID();
    const storage = installStorage({
      uploadId: "multipart-upload-1",
      uploadedParts: 2,
      completedObject: () => {
        return {
          size: 20 * MiB,
          contentType: "video/mp4",
          metadata: {
            "artifact-id": id,
            filename: encodeURIComponent("my recording.mp4"),
            "user-id": actor.userId,
            "public-brand": "okou",
          },
        };
      },
    });
    const api = signIn(actor);

    const completed = await accept(
      api.completeMultipart({
        headers,
        body: {
          id,
          filename: "my recording.mp4",
          uploadId: "multipart-upload-1",
          partCount: 2,
        },
      }),
      [200],
    );

    expect(Object.keys(completed.body).sort()).toStrictEqual(["id", "url"]);
    expect(completed.body.id).toBe(id);
    expect(completed.body.url).toMatch(publicArtifactUrl);
    const completion = storage.operations.filter((operation) => {
      return operation.name === "CompleteMultipartUploadCommand";
    });
    expect(completion).toHaveLength(1);
    expect(completion[0]!.input).toMatchObject({
      Bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
      UploadId: "multipart-upload-1",
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
      },
    });
    expect(String(completion[0]!.input.Key)).toMatch(publicArtifactKey);
  });

  it("uploads-multipart-009 rejects completion when an uploaded part is missing", async () => {
    const storage = installStorage({
      uploadId: "multipart-upload-2",
      uploadedParts: 1,
    });
    const api = signIn(member());

    const rejected = await accept(
      api.completeMultipart({
        headers,
        body: {
          id: randomUUID(),
          filename: "recording.mp4",
          uploadId: "multipart-upload-2",
          partCount: 2,
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe("Multipart upload is incomplete");
    expect(
      storage.operations.map((operation) => {
        return operation.name;
      }),
    ).toStrictEqual(["ListPartsCommand"]);
  });

  it("uploads-multipart-010 aborts an unfinished multipart upload", async () => {
    const storage = installStorage({
      uploadId: "multipart-upload-3",
      uploadedParts: 1,
    });
    const api = signIn(member());
    const id = randomUUID();

    const aborted = await accept(
      api.abortMultipart({
        headers,
        body: {
          id,
          filename: "my recording.mp4",
          uploadId: "multipart-upload-3",
        },
      }),
      [200],
    );

    expect(aborted.body).toStrictEqual({ id });
    const aborts = storage.operations.filter((operation) => {
      return operation.name === "AbortMultipartUploadCommand";
    });
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.input).toMatchObject({
      Bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
      UploadId: "multipart-upload-3",
    });
    expect(String(aborts[0]!.input.Key)).toMatch(publicArtifactKey);
  });
});
