import { mockNow } from "../../../lib/time";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { webFileUrlRoutes } from "../web-file-url";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { createRouteMocks } from "./helpers/route-test";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const bucket = "test-private-artifacts";
const body = Object.freeze({
  filename: "report.html",
  contentType: "text/html",
  size: 13,
});
const routes = Object.freeze([
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...webFileUrlRoutes,
  ...artifactReferenceRoutes,
  ...artifactCatalogRoutes,
]);

function api() {
  return setupApp({ context, routes });
}

function mockStoredFile(id: string) {
  const key = `private-artifacts/${id}/report.html`;
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((command) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.startsWith("artifact-references/")
    ) {
      return storage(command);
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      expect(command.input).toMatchObject({ Bucket: bucket, Key: key });
      return Promise.resolve({
        ContentLength: 13,
        ContentType: "text/html",
        Metadata: { "artifact-id": id },
        Body: Readable.from([Buffer.from("private bytes")]),
      });
    }
    throw new Error("Unexpected storage request");
  });
}

beforeEach(() => {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const references = new Map<string, string>();
  mocks.s3.listObjects([]);
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((command) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.startsWith("artifact-references/")
    ) {
      return Promise.resolve({
        Body: Readable.from([Buffer.from(references.get(command.input.Key)!)]),
        ETag: '"reference"',
      });
    }
    if (
      command instanceof PutObjectCommand &&
      command.input.Key?.startsWith("artifact-references/")
    ) {
      references.set(command.input.Key, String(command.input.Body));
      return Promise.resolve({});
    }
    return storage(command);
  });
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://private-r2.example/upload?signature=put",
  );
});

describe("private artifact uploads", () => {
  it("cancels private completion during storage verification and permits a fresh replay", async () => {
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: { ...body, purpose: "artifact" },
      }),
      [200],
    );
    mockStoredFile(prepared.body.id);
    const owner = new AbortController();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      owner.abort();
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    const storage = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        started.resolve(undefined);
        await release.promise;
      }
      return await storage(command);
    });
    const request = { headers, body: { id: prepared.body.id } };
    const cancelled = (async () => {
      await expect(
        setupApp({
          context,
          routes,
          signal: owner.signal,
          rethrowErrors: true,
        })(uploadsContract).complete(request),
      ).rejects.toMatchObject({ name: "AbortError" });
    })();
    await started.promise;
    owner.abort();
    release.resolve(undefined);
    await cancelled;
    const before = await accept(
      api()(artifactCatalogContract).list({ headers }),
      [200],
    );
    expect(before.body.artifacts).toStrictEqual([]);
    context.mocks.s3.send.mockImplementation(storage);
    await accept(api()(uploadsContract).complete(request), [200]);
    const after = await accept(
      api()(artifactCatalogContract).list({ headers }),
      [200],
    );
    expect(after.body.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "file", title: body.filename }),
    ]);
  });

  it("keeps one downloadable catalog artifact after concurrent completion and replay", async () => {
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: { ...body, purpose: "artifact" },
      }),
      [200],
    );
    mockStoredFile(prepared.body.id);
    const completions = await Promise.all([
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
    ]);
    for (const completed of completions) {
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({
        id: prepared.body.id,
        url: prepared.body.url,
        size: 13,
      });
    }
    const listed = await accept(
      api()(artifactCatalogContract).list({ headers }),
      [200],
    );
    expect(listed.body.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "file", title: body.filename }),
    ]);
    const artifact = listed.body.artifacts[0]!;
    await accept(
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    const replayed = await accept(
      api()(artifactCatalogContract).list({ headers }),
      [200],
    );
    expect(replayed.body.artifacts).toStrictEqual([
      expect.objectContaining({
        id: artifact.id,
        createdAt: artifact.createdAt,
      }),
    ]);
    const detail = await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: artifact.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      kind: "file",
      file: { id: prepared.body.id, url: prepared.body.url, size: 13 },
    });
    const download = await accept(
      api()(webFilesContract).fileUrl({
        headers,
        query: { file_id: prepared.body.id },
      }),
      [200],
    );
    expect(download.body.downloadUrl).toMatch(/^https:\/\//u);
  });

  it.each(["missing", "unknown-size"] as const)(
    "publishes only verified private bytes after a %s storage response and replay",
    async (failure) => {
      const prepared = await accept(
        api()(uploadsContract).prepare({
          headers,
          body: { ...body, purpose: "artifact" },
        }),
        [200],
      );
      const storage = context.mocks.s3.send.getMockImplementation()!;
      context.mocks.s3.send.mockImplementation((command) => {
        if (command instanceof HeadObjectCommand) {
          if (failure === "missing") {
            return Promise.reject(
              Object.assign(new Error("Missing private object"), {
                name: "NotFound",
              }),
            );
          }
          return Promise.resolve({ ContentType: body.contentType });
        }
        return storage(command);
      });
      const failed = await api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      });
      expect(failed.status).toBe(failure === "missing" ? 404 : 500);
      const unavailable = await accept(
        api()(artifactCatalogContract).list({ headers }),
        [200],
      );
      expect(unavailable.body.artifacts).toStrictEqual([]);
      mockStoredFile(prepared.body.id);
      await accept(
        api()(uploadsContract).complete({
          headers,
          body: { id: prepared.body.id },
        }),
        [200],
      );
      const recovered = await accept(
        api()(artifactCatalogContract).list({ headers }),
        [200],
      );
      expect(recovered.body.artifacts).toStrictEqual([
        expect.objectContaining({ kind: "file", title: body.filename }),
      ]);
    },
  );

  it("keeps a guarded upload private through completion", async () => {
    installSharedThreadStorage(context);
    const prepared = await accept(
      api()(uploadsContract).preparePrivate({ headers, body }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected single upload");
    }
    expect(prepared.body.url).toMatch(
      /^http:\/\/localhost:3002\/artifacts\/[a-z0-9]{10}\.html$/u,
    );
    await fetch(prepared.body.uploadUrl, {
      method: "PUT",
      body: "private bytes",
    });
    const completed = await accept(
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    expect(completed.body.url).toBe(prepared.body.url);
    const preview = await accept(
      api()(webFilesContract).fileUrl({
        headers,
        query: { file_id: prepared.body.id },
      }),
      [200],
    );
    expect(preview.body.publicUrl).toBeNull();
  });

  it("keeps organization-less public uploads readable", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    installSharedThreadStorage(context);
    const prepared = await accept(
      api()(uploadsContract).prepare({ headers, body }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected single upload");
    }
    await fetch(prepared.body.uploadUrl, {
      method: "PUT",
      body: "public bytes",
    });
    await accept(
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    const preview = await accept(
      api()(webFilesContract).fileUrl({
        headers,
        query: { file_id: prepared.body.id },
      }),
      [200],
    );
    expect(preview.body.publicUrl).toBe(prepared.body.url);
  });

  it("previews private bytes uploaded by an older composer without a complete request", async () => {
    const prepared = await accept(
      api()(uploadsContract).prepare({ headers, body }),
      [200],
    );
    mockStoredFile(prepared.body.id);
    const preview = await accept(
      api()(artifactReferencesContract).resolve({
        headers,
        params: {
          reference: new URL(prepared.body.url).pathname.slice(
            "/artifacts/".length,
          ),
        },
      }),
      [200],
    );
    expect(preview.body.url).toBe(
      "https://private-r2.example/upload?signature=put",
    );
    expect(context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1]).toMatchObject({
      input: { Bucket: bucket },
    });
  });

  it("makes attachments and outputs private by default", async () => {
    const input = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: { filename: "input.png", contentType: "image/png", size: 13 },
      }),
      [200],
    );
    expect(input.body.url).toMatch(
      /^http:\/\/localhost:3002\/artifacts\/[a-z0-9]{10}\.png$/u,
    );
    const artifact = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: { ...body, purpose: "artifact" },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(artifact.body.url).toMatch(
      /^http:\/\/localhost:3002\/artifacts\/[a-z0-9]{10}\.html$/u,
    );
  });

  it("returns stable owner references and signed private download URLs", async () => {
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers,
        body,
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    const { id, url } = prepared.body;
    expect(prepared.body).toHaveProperty("uploadUrl");
    const put = context.mocks.s3.getSignedUrl.mock.calls.at(-1);
    expect(put?.[2]).toMatchObject({ expiresIn: 172_800 });
    expect(put?.[1]).toMatchObject({
      input: { Bucket: bucket, Key: `private-artifacts/${id}/report.html` },
    });
    mockStoredFile(id);

    const completed = await accept(
      api()(uploadsContract).complete({ headers, body: { id } }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      id,
      url,
      filename: "report.html",
      contentType: "text/html",
      size: 13,
    });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://private-r2.example/report.html?signature=one",
    );
    mockNow(new Date("2026-09-09T12:00:00.123Z"));
    const preview = await accept(
      api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      url: "https://private-r2.example/report.html?signature=one",
      downloadUrl: "https://private-r2.example/report.html?signature=one",
      publicUrl: null,
      previewImageUrl: null,
      expiresAt: "2026-09-11T12:00:00.000Z",
    });
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: bucket,
          Key: `private-artifacts/${id}/report.html`,
          ResponseCacheControl: "private, max-age=31536000, must-revalidate",
        }),
      }),
      {
        expiresIn: 172_800,
        signingDate: new Date("2026-09-09T12:00:00.000Z"),
      },
    );
    const reference = new URL(url).pathname.slice("/artifacts/".length);
    const resolved = await accept(
      api()(artifactReferencesContract).resolve({
        headers,
        params: { reference },
      }),
      [200],
    );
    expect(resolved.body.url).toBe(preview.body.url);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://private-r2.example/report.html?signature=two",
    );
    const refreshed = await accept(
      api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(refreshed.body).toStrictEqual({
      ...preview.body,
      downloadUrl: "https://private-r2.example/report.html?signature=two",
    });

    mockNow(new Date("2026-09-11T11:50:00.123Z"));
    const nearExpiry = await accept(
      api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(nearExpiry.body).toStrictEqual({
      url: "https://private-r2.example/report.html?signature=two",
      downloadUrl: "https://private-r2.example/report.html?signature=two",
      publicUrl: null,
      previewImageUrl: null,
      expiresAt: "2026-09-13T11:50:00.000Z",
    });
  });

  it("enforces owner and organization for complete and multipart operations", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const prepared = await accept(
      api()(uploadsContract).prepare({ headers, body }),
      [200],
    );
    const id = prepared.body.id;
    mockStoredFile(id);
    const owner = await accept(
      api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(owner.body.publicUrl).toBeNull();
    const completed = await accept(
      api()(uploadsContract).complete({ headers, body: { id } }),
      [200],
    );
    expect(completed.body.url).toBe(prepared.body.url);

    for (const [viewerId, viewerOrg] of [
      [`user_${randomUUID()}`, orgId],
      [userId, `org_${randomUUID()}`],
    ]) {
      if (!viewerId || !viewerOrg) {
        throw new Error("Invalid viewer fixture");
      }
      mocks.clerk.session(viewerId, viewerOrg);
      const denied = await accept(
        api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
        [404],
      );
      expect(denied.body.error.code).toBe("NOT_FOUND");
      await accept(
        api()(uploadsContract).complete({ headers, body: { id } }),
        [404],
      );
      const multipart = { id, filename: body.filename, uploadId: "upload-1" };
      await accept(
        api()(uploadsContract).completeMultipart({
          headers,
          body: { ...multipart, partCount: 1 },
        }),
        [404],
      );
      await accept(
        api()(uploadsContract).abortMultipart({ headers, body: multipart }),
        [404],
      );
    }
    mocks.clerk.session(userId, null);
    await accept(
      api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
      [404],
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return { userId: null };
      },
    });
    await accept(
      api()(webFilesContract).fileUrl({ headers: {}, query: { file_id: id } }),
      [401],
    );
  });

  it("does not consult public storage when a private object is missing", async () => {
    const prepared = await accept(
      api()(uploadsContract).prepare({ headers, body }),
      [200],
    );
    context.mocks.s3.send.mockImplementation((command) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return Promise.reject(
        Object.assign(new Error("Missing private object"), {
          name: "NotFound",
        }),
      );
    });
    const missing = await accept(
      api()(webFilesContract).fileUrl({
        headers,
        query: { file_id: prepared.body.id },
      }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it.each(["complete", "abort"] as const)(
    "%s multipart uploads in their recorded bucket",
    async (action) => {
      const storage = context.mocks.s3.send.getMockImplementation()!;
      context.mocks.s3.send.mockImplementation((command) => {
        if (
          command instanceof PutObjectCommand &&
          command.input.Key?.startsWith("artifact-references/")
        ) {
          return storage(command);
        }
        if (command instanceof CreateMultipartUploadCommand) {
          expect(command.input.Bucket).toBe(bucket);
          return Promise.resolve({ UploadId: "upload-1" });
        }
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        throw new Error("Unexpected prepare request");
      });
      const prepared = await accept(
        api()(uploadsContract).prepare({
          headers,
          body: { ...body, size: 6 * 1024 * 1024, multipart: true },
        }),
        [200],
      );
      const id = prepared.body.id;
      expect(prepared.body).toMatchObject({
        multipart: {
          uploadId: "upload-1",
          parts: [{ partNumber: 1 }, { partNumber: 2 }],
        },
      });
      const identity = { id, filename: body.filename, uploadId: "upload-1" };
      const multipartActions: string[] = [];
      context.mocks.s3.send.mockImplementation((command) => {
        if (
          command instanceof ListPartsCommand ||
          command instanceof HeadObjectCommand ||
          command instanceof CompleteMultipartUploadCommand ||
          command instanceof AbortMultipartUploadCommand
        ) {
          expect(command.input).toMatchObject({
            Bucket: bucket,
            Key: `private-artifacts/${id}/report.html`,
          });
          if (command instanceof CompleteMultipartUploadCommand) {
            multipartActions.push("complete");
          }
          if (command instanceof AbortMultipartUploadCommand) {
            multipartActions.push("abort");
          }
          return Promise.resolve({
            Parts: [
              { PartNumber: 1, ETag: "part-1" },
              { PartNumber: 2, ETag: "part-2" },
            ],
            ContentLength: 6 * 1024 * 1024,
          });
        }
        throw new Error("Unexpected multipart request");
      });
      if (action === "complete") {
        const completed = await accept(
          api()(uploadsContract).completeMultipart({
            headers,
            body: { ...identity, partCount: 2 },
          }),
          [200],
        );
        expect(completed.body.url).toBe(prepared.body.url);
      } else {
        const aborted = await accept(
          api()(uploadsContract).abortMultipart({ headers, body: identity }),
          [200],
        );
        expect(aborted.body.id).toBe(id);
      }
      expect(multipartActions).toStrictEqual([action]);
    },
  );

  it("fails visibly when private storage credentials are absent", async () => {
    mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
    const failed = await api()(uploadsContract).prepare({ headers, body });
    expect(failed.status).toBe(500);
    expect(failed.body).not.toHaveProperty("url");
  });
});
