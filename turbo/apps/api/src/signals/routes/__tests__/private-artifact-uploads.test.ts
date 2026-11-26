import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactReferenceRoutes } from "../artifact-references";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webFileUrlRoutes } from "../web-file-url";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const reportBytes = Buffer.from("<p>report</p>");

interface Actor {
  readonly userId: string;
  readonly orgId: string | null;
}

interface StorageOperation {
  readonly name: string;
  readonly bucket: unknown;
  readonly key: unknown;
}

interface StoredObject {
  readonly body: Buffer;
  readonly size?: number;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

function member(orgId: string | null = `org_${randomUUID()}`): Actor {
  return { userId: `user_${randomUUID()}`, orgId };
}

function as(actor: Actor | null) {
  if (actor) {
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  } else {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  }
  const app = (routes: Parameters<typeof setupApp>[0]["routes"]) => {
    return setupApp({ context, routes });
  };
  return {
    uploads: app([
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...uploadsMultipartRoutes,
    ])(uploadsContract),
    files: app(webFileUrlRoutes)(webFilesContract),
    catalog: app(artifactCatalogRoutes)(artifactCatalogContract),
    references: app(artifactReferenceRoutes)(artifactReferencesContract),
  };
}

function notFoundError(): Error {
  return Object.assign(new Error("Not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

/** In-memory R2: presigned PUT URLs name the object the browser writes. */
function installStorage(options: { readonly multipartParts?: number } = {}) {
  const objects = new Map<string, StoredObject>();
  const operations: StorageOperation[] = [];
  const signed: {
    url: string;
    operation: string;
    bucket: string;
    key: string;
    expiresIn: number;
    cacheControl: unknown;
  }[] = [];
  const objectKey = (bucket: unknown, key: unknown) => {
    return `${String(bucket)}/${String(key)}`;
  };

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown, signing: unknown) => {
      const { constructor, input } = command as {
        readonly constructor: { readonly name: string };
        readonly input: {
          readonly Bucket: string;
          readonly Key: string;
          readonly ResponseCacheControl?: unknown;
        };
      };
      const expiresIn =
        (signing as { readonly expiresIn?: number } | undefined)?.expiresIn ??
        0;
      const url = new URL(
        `https://r2.example.com/${input.Bucket}/${input.Key}`,
      );
      url.searchParams.set("op", constructor.name);
      url.searchParams.set("X-Amz-Expires", String(expiresIn));
      url.searchParams.set("n", String(signed.length));
      signed.push({
        url: url.toString(),
        operation: constructor.name,
        bucket: input.Bucket,
        key: input.Key,
        expiresIn,
        cacheControl: input.ResponseCacheControl,
      });
      return Promise.resolve(url.toString());
    },
  );

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    const name = constructor.name;
    operations.push({ name, bucket: input.Bucket, key: input.Key });
    const id = objectKey(input.Bucket, input.Key);
    const stored = objects.get(id);
    switch (name) {
      case "PutObjectCommand": {
        if (input.IfNoneMatch === "*" && stored) {
          return Promise.reject(
            Object.assign(new Error("Object exists"), {
              name: "PreconditionFailed",
            }),
          );
        }
        objects.set(id, {
          body: Buffer.from(input.Body as string | Uint8Array),
          contentType: input.ContentType as string | undefined,
        });
        return Promise.resolve({ ETag: '"put"' });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(
            Object.assign(new Error("Missing"), { name: "NoSuchKey" }),
          );
        }
        return Promise.resolve({
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          ETag: `"${createHash("sha256").update(stored.body).digest("hex")}"`,
        });
      }
      case "HeadObjectCommand": {
        if (!stored) {
          return Promise.reject(notFoundError());
        }
        return Promise.resolve({
          ContentLength: stored.size ?? stored.body.byteLength,
          ContentType: stored.contentType,
          LastModified: new Date("2026-01-01T00:00:00.000Z"),
          Metadata: stored.metadata ?? {},
          ETag: '"head"',
        });
      }
      case "CreateMultipartUploadCommand": {
        return Promise.resolve({ UploadId: "upload-1" });
      }
      case "ListPartsCommand": {
        return Promise.resolve({
          Parts: Array.from(
            { length: options.multipartParts ?? 0 },
            (_, index) => {
              return { PartNumber: index + 1, ETag: `"etag-${index + 1}"` };
            },
          ),
        });
      }
      case "CompleteMultipartUploadCommand": {
        objects.set(id, {
          body: Buffer.alloc(0),
          size: 6 * 1024 * 1024,
          contentType: "text/html",
        });
        return Promise.resolve({});
      }
      case "ListObjectsV2Command": {
        const prefix = `${String(input.Bucket)}/${String(input.Prefix)}`;
        return Promise.resolve({
          Contents: [...objects]
            .filter(([stored]) => {
              return stored.startsWith(prefix);
            })
            .map(([stored, object]) => {
              return {
                Key: stored.slice(String(input.Bucket).length + 1),
                Size: object.body.byteLength,
                LastModified: new Date("2026-01-01T00:00:00.000Z"),
              };
            }),
        });
      }
      default: {
        return Promise.resolve({});
      }
    }
  });

  return {
    operations,
    signed,
    /** The browser PUTs bytes to a presigned upload URL. */
    upload(
      uploadUrl: string,
      body: Buffer,
      contentType: string,
      uploadHeaders: Readonly<Record<string, string>> = {},
    ) {
      const target = signed.find((entry) => {
        return entry.url === uploadUrl;
      });
      if (!target) {
        throw new Error(`Unknown upload URL ${uploadUrl}`);
      }
      const metadata = Object.fromEntries(
        Object.entries(uploadHeaders).map(([name, value]) => {
          return [name.replace(/^x-amz-meta-/, ""), value];
        }),
      );
      objects.set(objectKey(target.bucket, target.key), {
        body,
        contentType,
        metadata,
      });
    },
  };
}

type Storage = ReturnType<typeof installStorage>;
type Api = ReturnType<typeof as>;

async function prepareReport(
  api: Api,
  options: { readonly purpose?: "artifact" } = {},
) {
  const prepared = await accept(
    api.uploads.prepare({
      headers,
      body: {
        filename: "report.html",
        contentType: "text/html",
        size: reportBytes.byteLength,
        ...options,
      },
    }),
    [200],
  );
  if ("multipart" in prepared.body) {
    throw new Error("Expected a single-part upload");
  }
  return prepared.body;
}

async function uploadedReport(
  api: Api,
  storage: Storage,
  options: { readonly purpose?: "artifact" } = {},
) {
  const prepared = await prepareReport(api, options);
  storage.upload(
    prepared.uploadUrl,
    reportBytes,
    "text/html",
    prepared.uploadHeaders,
  );
  return prepared;
}

async function prepareMultipartReport(api: Api) {
  const prepared = await accept(
    api.uploads.prepare({
      headers,
      body: {
        filename: "report.html",
        contentType: "text/html",
        size: 6 * 1024 * 1024,
        multipart: true,
      },
    }),
    [200],
  );
  if (!("multipart" in prepared.body)) {
    throw new Error("Expected a multipart upload");
  }
  return prepared.body;
}

const privateHtmlUrl = /\/artifacts\/[A-Za-z0-9_-]{10}\.html$/;
const privatePngUrl = /\/artifacts\/[A-Za-z0-9_-]{10}\.png$/;

describe("private artifact uploads", () => {
  it("private-artifact-uploads-002 keeps one downloadable catalog artifact after concurrent completion and replay", async () => {
    const storage = installStorage();
    const api = as(member());
    const prepared = await uploadedReport(api, storage, {
      purpose: "artifact",
    });

    const [first, second] = await Promise.all([
      accept(
        api.uploads.complete({ headers, body: { id: prepared.id } }),
        [200],
      ),
      accept(
        api.uploads.complete({ headers, body: { id: prepared.id } }),
        [200],
      ),
    ]);
    const listed = await accept(
      api.catalog.list({ headers, query: {} }),
      [200],
    );
    await accept(
      api.uploads.complete({ headers, body: { id: prepared.id } }),
      [200],
    );
    const relisted = await accept(
      api.catalog.list({ headers, query: {} }),
      [200],
    );

    for (const completion of [first, second]) {
      expect(completion.body).toMatchObject({
        id: prepared.id,
        url: prepared.url,
        size: 13,
      });
    }
    expect(listed.body.artifacts).toHaveLength(1);
    const [artifact] = listed.body.artifacts;
    expect(artifact).toMatchObject({ kind: "file" });
    expect(relisted.body.artifacts).toStrictEqual([
      expect.objectContaining({
        id: artifact!.id,
        createdAt: artifact!.createdAt,
      }),
    ]);

    const detail = await accept(
      api.catalog.get({ headers, params: { artifactId: artifact!.id } }),
      [200],
    );
    expect(detail.body).toMatchObject({
      kind: "file",
      file: { id: prepared.id, url: prepared.url, size: 13 },
    });
    const fileUrl = await accept(
      api.files.fileUrl({ headers, query: { file_id: prepared.id } }),
      [200],
    );
    expect(fileUrl.body.downloadUrl).toMatch(/^https:\/\//);
  });

  it("private-artifact-uploads-003 publishes only verified private bytes after a missing storage response and replay", async () => {
    const storage = installStorage();
    const api = as(member());
    const prepared = await prepareReport(api, { purpose: "artifact" });

    const missing = await accept(
      api.uploads.complete({ headers, body: { id: prepared.id } }),
      [404],
    );
    const before = await accept(
      api.catalog.list({ headers, query: {} }),
      [200],
    );
    storage.upload(prepared.uploadUrl, reportBytes, "text/html");
    await accept(
      api.uploads.complete({ headers, body: { id: prepared.id } }),
      [200],
    );
    const after = await accept(api.catalog.list({ headers, query: {} }), [200]);

    expect(missing.status).toBe(404);
    expect(before.body.artifacts).toStrictEqual([]);
    expect(after.body.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "file", title: "report.html" }),
    ]);
  });

  it("private-artifact-uploads-005 keeps a guarded upload private through completion", async () => {
    const storage = installStorage();
    const api = as(member());

    const prepared = await accept(
      api.uploads.preparePrivate({
        headers,
        body: {
          filename: "report.html",
          contentType: "text/html",
          size: reportBytes.byteLength,
        },
      }),
      [200],
    );
    if ("multipart" in prepared.body) {
      throw new Error("Expected a single-part upload");
    }
    storage.upload(prepared.body.uploadUrl, reportBytes, "text/html");
    const completed = await accept(
      api.uploads.complete({ headers, body: { id: prepared.body.id } }),
      [200],
    );
    const fileUrl = await accept(
      api.files.fileUrl({ headers, query: { file_id: prepared.body.id } }),
      [200],
    );

    expect(prepared.body.url).toMatch(privateHtmlUrl);
    expect(completed.body.url).toBe(prepared.body.url);
    expect(fileUrl.body.publicUrl).toBeNull();
  });

  it("private-artifact-uploads-008 makes attachments and outputs private by default", async () => {
    installStorage();
    const api = as(member());
    const extraHeaders = { origin: env("APP_URL") };

    const attachment = await accept(
      api.uploads.prepare({
        headers,
        extraHeaders,
        body: { filename: "photo.png", contentType: "image/png", size: 10 },
      }),
      [200],
    );
    const output = await accept(
      api.uploads.prepare({
        headers,
        extraHeaders,
        body: {
          filename: "report.html",
          contentType: "text/html",
          size: 13,
          purpose: "artifact",
        },
      }),
      [200],
    );

    expect(attachment.body.url).toMatch(privatePngUrl);
    expect(output.body.url).toMatch(privateHtmlUrl);
    for (const url of [attachment.body.url, output.body.url]) {
      expect(new URL(url).origin).toBe(new URL(env("APP_URL")).origin);
    }
  });

  it("private-artifact-uploads-010 enforces owner and organization for complete and multipart operations", async () => {
    const storage = installStorage();
    const owner = member();
    const ownerApi = as(owner);
    const prepared = await uploadedReport(ownerApi, storage);
    const completed = await accept(
      ownerApi.uploads.complete({ headers, body: { id: prepared.id } }),
      [200],
    );
    const ownerFile = await accept(
      ownerApi.files.fileUrl({ headers, query: { file_id: prepared.id } }),
      [200],
    );
    expect(completed.body.url).toBe(prepared.url);
    expect(ownerFile.body.publicUrl).toBeNull();

    const multipartBody = {
      id: prepared.id,
      filename: "report.html",
      uploadId: "upload-1",
    };
    for (const other of [
      member(owner.orgId),
      { userId: owner.userId, orgId: `org_${randomUUID()}` },
    ]) {
      const api = as(other);
      const fileUrl = await accept(
        api.files.fileUrl({ headers, query: { file_id: prepared.id } }),
        [404],
      );
      expect(fileUrl.body.error.code).toBe("NOT_FOUND");
      await accept(
        api.uploads.complete({ headers, body: { id: prepared.id } }),
        [404],
      );
      await accept(
        api.uploads.completeMultipart({
          headers,
          body: { ...multipartBody, partCount: 1 },
        }),
        [404],
      );
      await accept(
        api.uploads.abortMultipart({ headers, body: multipartBody }),
        [404],
      );
    }

    const orgless = as({ userId: owner.userId, orgId: null });
    await accept(
      orgless.files.fileUrl({ headers, query: { file_id: prepared.id } }),
      [404],
    );
    const anonymous = as(null);
    await accept(
      anonymous.files.fileUrl({ headers: {}, query: { file_id: prepared.id } }),
      [401],
    );
  });

  it("private-artifact-uploads-015 completes multipart uploads in their recorded bucket", async () => {
    const storage = installStorage({ multipartParts: 2 });
    const api = as(member());
    const prepared = await prepareMultipartReport(api);

    const completed = await accept(
      api.uploads.completeMultipart({
        headers,
        body: {
          id: prepared.id,
          filename: "report.html",
          uploadId: prepared.multipart.uploadId,
          partCount: 2,
        },
      }),
      [200],
    );

    expect(prepared.multipart.uploadId).toBe("upload-1");
    expect(
      prepared.multipart.parts.map((part) => {
        return part.partNumber;
      }),
    ).toStrictEqual([1, 2]);
    expect(completed.body.url).toBe(prepared.url);
    const objectOperations = storage.operations.filter((operation) => {
      return !String(operation.key).startsWith("artifact-references/");
    });
    expect(objectOperations.length).toBeGreaterThan(0);
    for (const operation of objectOperations) {
      expect(operation).toMatchObject({
        bucket: env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
        key: `private-artifacts/${prepared.id}/report.html`,
      });
    }
    expect(
      objectOperations.filter((operation) => {
        return operation.name === "CompleteMultipartUploadCommand";
      }),
    ).toHaveLength(1);
  });

  it("private-artifact-uploads-016 aborts multipart uploads in their recorded bucket", async () => {
    const storage = installStorage({ multipartParts: 2 });
    const api = as(member());
    const prepared = await prepareMultipartReport(api);

    const aborted = await accept(
      api.uploads.abortMultipart({
        headers,
        body: {
          id: prepared.id,
          filename: "report.html",
          uploadId: prepared.multipart.uploadId,
        },
      }),
      [200],
    );

    expect(prepared.multipart.uploadId).toBe("upload-1");
    expect(
      prepared.multipart.parts.map((part) => {
        return part.partNumber;
      }),
    ).toStrictEqual([1, 2]);
    expect(aborted.body).toStrictEqual({ id: prepared.id });
    const objectOperations = storage.operations.filter((operation) => {
      return !String(operation.key).startsWith("artifact-references/");
    });
    for (const operation of objectOperations) {
      expect(operation).toMatchObject({
        bucket: env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
        key: `private-artifacts/${prepared.id}/report.html`,
      });
    }
    expect(
      objectOperations.filter((operation) => {
        return operation.name === "AbortMultipartUploadCommand";
      }),
    ).toHaveLength(1);
  });

  it("private-artifact-uploads-006 keeps an organization-less upload publicly readable", async () => {
    const storage = installStorage();
    const api = as(member(null));
    const prepared = await uploadedReport(api, storage);

    await accept(
      api.uploads.complete({ headers, body: { id: prepared.id } }),
      [200],
    );
    const fileUrl = await accept(
      api.files.fileUrl({ headers, query: { file_id: prepared.id } }),
      [200],
    );

    expect(fileUrl.body.publicUrl).toBe(prepared.url);
  });

  it("private-artifact-uploads-009 returns stable owner references and refreshes signed private download URLs", async () => {
    const storage = installStorage();
    const api = as(member());
    const twoDaysMs = 172_800 * 1000;
    const issuedAt = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
    const issuedSecond = Math.floor(issuedAt / 1000) * 1000;
    mockNow(issuedAt);
    const prepared = await accept(
      api.uploads.prepare({
        headers,
        extraHeaders: { origin: env("APP_URL") },
        body: {
          filename: "report.html",
          contentType: "text/html",
          size: reportBytes.byteLength,
        },
      }),
      [200],
    );
    if ("multipart" in prepared.body) {
      throw new Error("Expected a single-part upload");
    }
    const { id, uploadUrl, url } = prepared.body;
    expect(
      storage.signed.find((entry) => {
        return entry.url === uploadUrl;
      }),
    ).toMatchObject({
      bucket: env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
      key: `private-artifacts/${id}/report.html`,
      expiresIn: 172_800,
    });
    storage.upload(uploadUrl, reportBytes, "text/html");

    const completed = await accept(
      api.uploads.complete({ headers, body: { id } }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      id,
      url,
      filename: "report.html",
      contentType: "text/html",
      size: 13,
    });

    const first = await accept(
      api.files.fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.body).toMatchObject({
      publicUrl: null,
      previewImageUrl: null,
      expiresAt: new Date(issuedSecond + twoDaysMs).toISOString(),
    });
    expect(first.body.url).toMatch(/^https:\/\//);
    expect(
      storage.signed.find((entry) => {
        return entry.url === first.body.url;
      }),
    ).toMatchObject({
      bucket: env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
      key: `private-artifacts/${id}/report.html`,
      cacheControl: "private, max-age=31536000, must-revalidate",
    });

    const reference = new URL(url).pathname.split("/").at(-1) ?? "";
    const resolved = await accept(
      api.references.read({ headers, params: { reference } }),
      [200],
    );
    expect(resolved.body.url).toBe(first.body.url);

    const repeat = await accept(
      api.files.fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(repeat.body.url).toBe(first.body.url);
    expect(repeat.body.expiresAt).toBe(first.body.expiresAt);
    expect(repeat.body.downloadUrl).not.toBe(first.body.downloadUrl);

    const nearExpiry = issuedSecond + twoDaysMs - 30 * 60 * 1000 + 250;
    mockNow(nearExpiry);
    const refreshed = await accept(
      api.files.fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(refreshed.body.url).not.toBe(first.body.url);
    expect(refreshed.body.expiresAt).toBe(
      new Date(Math.floor(nearExpiry / 1000) * 1000 + twoDaysMs).toISOString(),
    );
  });
});
