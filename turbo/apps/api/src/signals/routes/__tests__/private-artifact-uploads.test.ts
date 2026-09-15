import { mockNow } from "../../../lib/time";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
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
} from "@aws-sdk/client-s3";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { webFileUrlRoutes } from "../web-file-url";
import { webDownloadRoutes } from "../web-download";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const bucket = "test-private-artifacts";
const body = Object.freeze({
  filename: "report.html",
  contentType: "text/html",
  size: 13,
  purpose: "artifact" as const,
});
const routes = Object.freeze([
  ...featureSwitchesRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...webFileUrlRoutes,
  ...webDownloadRoutes,
]);

function api() {
  return setupApp({ context, routes });
}

async function setPrivateArtifacts(enabled: boolean) {
  return await accept(
    api()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: enabled } },
    }),
    [200],
  );
}

function mockStoredFile(id: string) {
  const key = `private-artifacts/${id}/report.html`;
  context.mocks.s3.send.mockImplementation((command) => {
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
  mocks.s3.listObjects([]);
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://private-r2.example/upload?signature=put",
  );
});

describe("private artifact uploads", () => {
  it("keeps the shared switch off by default and enables artifact output only", async () => {
    const flags = await accept(
      api()(featureSwitchesContract).get({ headers }),
      [200],
    );
    expect(
      flags.body.effectiveSwitches[FeatureSwitchKey.PrivateArtifacts],
    ).toBeFalsy();
    const legacy = await accept(
      api()(uploadsContract).prepare({ headers, body }),
      [200],
    );
    expect(legacy.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.html$/u,
    );

    await setPrivateArtifacts(true);
    const input = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: { filename: "input.png", contentType: "image/png", size: 13 },
      }),
      [200],
    );
    expect(input.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.png$/u,
    );
    const artifact = await accept(
      api()(uploadsContract).prepare({
        headers,
        body,
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(artifact.body.url).toBe(
      artifactReferencePath(artifact.body.id, "report.html"),
    );
  });

  it("returns a stable owner URL, signs only the private bucket, and downloads safely from the API origin", async () => {
    await setPrivateArtifacts(true);
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
      publicUrl: null,
      expiresAt: "2026-09-11T12:00:00.000Z",
    });
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(context.mocks.s3.getSignedUrl.mock.calls.at(-1)).toMatchObject({
      1: {
        input: {
          Bucket: bucket,
          Key: `private-artifacts/${id}/report.html`,
          ResponseCacheControl: "private, max-age=31536000, must-revalidate",
        },
      },
      2: {
        expiresIn: 172_800,
        signingDate: new Date("2026-09-09T12:00:00.000Z"),
      },
    });
    const downloaded = await accept(
      api()(webFilesContract).download({ headers, query: { file_id: id } }),
      [200],
    );
    expect(downloaded.body).toBe("private bytes");
    expect(downloaded.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''report.html",
    );
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://private-r2.example/report.html?signature=two",
    );
    const refreshed = await accept(
      api()(webFilesContract).fileUrl({ headers, query: { file_id: id } }),
      [200],
    );
    expect(refreshed.body).toStrictEqual({
      url: "https://private-r2.example/report.html?signature=two",
      publicUrl: null,
      expiresAt: "2026-09-11T12:00:00.000Z",
    });
  });

  it("enforces owner and organization after the switch is disabled, including complete and multipart operations", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    await setPrivateArtifacts(true);
    const prepared = await accept(
      api()(uploadsContract).prepare({ headers, body }),
      [200],
    );
    const id = prepared.body.id;
    mockStoredFile(id);
    await setPrivateArtifacts(false);
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
        api()(webFilesContract).download({ headers, query: { file_id: id } }),
        [404],
      );
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
    await accept(
      api()(webFilesContract).download({ headers: {}, query: { file_id: id } }),
      [401],
    );
  });

  it("does not consult public storage when a private object is missing", async () => {
    await setPrivateArtifacts(true);
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
    "%s multipart uploads in their recorded bucket after rollout is disabled",
    async (action) => {
      await setPrivateArtifacts(true);
      context.mocks.s3.send.mockImplementation((command) => {
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
      await setPrivateArtifacts(false);
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
    await setPrivateArtifacts(true);
    mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
    const failed = await api()(uploadsContract).prepare({ headers, body });
    expect(failed.status).toBe(500);
    expect(failed.body).not.toHaveProperty("url");
  });
});
