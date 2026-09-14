import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { uploadsPrepareRoutes } from "../uploads-prepare";

const uploadsTestRoutes = Object.freeze([
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...uploadsPrepareRoutes,
]);

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);

beforeEach(() => {
  mocks.s3.listObjects([]);
});

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function validBody() {
  return { filename: "hello.txt", contentType: "text/plain", size: 13 };
}

describe("POST /api/uploads/prepare", () => {
  it("registers the legacy public URL before issuing upload credentials", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const registrations: unknown[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof PutObjectCommand) {
        expect(command.input.Bucket).toBe("test-hosted-sites");
        expect(command.input.IfNoneMatch).toBe("*");
        registrations.push(JSON.parse(String(command.input.Body)));
      }
      return Promise.resolve({});
    });
    context.mocks.s3.getSignedUrl.mockImplementation(() => {
      expect(registrations).toHaveLength(1);
      return Promise.resolve("https://r2.example.com/upload?sig=test");
    });
    const response = await setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    ).prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
      extraHeaders: { origin: "https://app.okou.ai" },
    });
    expect(response.status).toBe(200);
    expect(registrations).toStrictEqual([
      {
        version: 1,
        kind: "legacy-file",
        audience: "public",
        publicBrand: "okou",
        key: expect.stringMatching(/^artifacts\/[a-z0-9]{10}\.txt$/u),
        filename: "hello.txt",
        contentType: "text/plain",
      },
    ]);
  });

  it("does not issue upload credentials when public registration fails", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof PutObjectCommand) {
        return Promise.reject(new Error("Registry unavailable"));
      }
      return Promise.resolve({});
    });
    const response = await accept(
      setupApp({ context, routes: uploadsTestRoutes })(uploadsContract).prepare(
        {
          body: validBody(),
          headers: { authorization: "Bearer clerk-session" },
        },
      ),
      [500],
    );
    expect(response.status).toBe(500);
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await accept(
      client.prepare({ body: validBody(), headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("accepts an Okou run token with file:write and returns a presigned URL", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId,
      capabilities: ["file:write"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await client.prepare({
      body: validBody(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect("uploadUrl" in response.body ? response.body.uploadUrl : "").toMatch(
      /^https?:\/\//,
    );
    expect(response.body.url).toMatch(/^https?:\/\//);
    expect(response.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.txt$/u,
    );
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns Okou artifact metadata for run uploads", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId,
      capabilities: ["file:write"],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    ).prepare({
      body: validBody(),
      headers: { authorization: `Bearer ${token}` },
      extraHeaders: { origin: "https://app.okou.ai" },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.txt$/u,
    );
    expect(response.body).toMatchObject({
      uploadHeaders: { "x-amz-meta-public-brand": "okou" },
    });
  });

  it("returns Okou artifact metadata for browser uploads", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    ).prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
      extraHeaders: { origin: "https://app.okou.ai" },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.txt$/u,
    );
    expect(response.body).toMatchObject({
      uploadHeaders: { "x-amz-meta-public-brand": "okou" },
    });
  });

  it("rejects invalid body shape with 400", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await accept(
      client.prepare({
        body: { filename: "" } as never,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects files larger than 1 GB with 400", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await accept(
      client.prepare({
        body: {
          filename: "big.bin",
          contentType: "application/pdf",
          size: 1024 * 1024 * 1024 + 1,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("File too large");
  });

  it("falls back to a generic content type for unrecognized MIME values", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await client.prepare({
      body: {
        filename: "capture.custom",
        contentType: "Application/X-Custom; Version=1",
        size: 10,
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({
      filename: "capture.custom",
      contentType: "application/octet-stream",
      size: 10,
    });
  });

  it.each([
    ['Text/Markdown; Charset="UTF-8"', "text/markdown; charset=utf-8"],
    ["Text/Plain; Charset=UTF-8", "text/plain; charset=utf-8"],
    ["text/plain; charset=GB18030", "text/plain; charset=gb18030"],
    ["text/markdown", "text/markdown"],
    ["text/markdown; charset=unsupported-label", "text/markdown"],
    ["image/png; charset=utf-8", "image/png"],
  ])(
    "prepares %s with compatible upload metadata",
    async (contentType, expected) => {
      mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
      let registration: unknown;
      context.mocks.s3.send.mockImplementation((command) => {
        if (command instanceof PutObjectCommand) {
          registration = JSON.parse(String(command.input.Body));
        }
        return Promise.resolve({});
      });
      const response = await accept(
        setupApp({ context, routes: uploadsTestRoutes })(
          uploadsContract,
        ).prepare({
          body: { filename: "artifact.bin", contentType, size: 32 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(response.body.contentType).toBe(expected);
      expect(registration).toMatchObject({
        kind: "legacy-file",
        contentType: expected,
      });
      expect(context.mocks.s3.getSignedUrl.mock.calls[0]?.[1]).toMatchObject({
        input: { ContentType: expected },
      });
    },
  );

  it("returns presigned upload URL and final CDN URL with full body shape", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await client.prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    if (!("uploadHeaders" in response.body)) {
      throw new Error("Expected a single-part upload response");
    }
    expect(response.body).toMatchObject({
      filename: "hello.txt",
      contentType: "text/plain",
      size: 13,
    });
    expect(response.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(response.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.txt$/,
    );
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.uploadHeaders).toMatchObject({
      "x-amz-meta-artifact-id": response.body.id,
      "x-amz-meta-filename": "hello.txt",
      "x-amz-meta-public-brand": "okou",
      "x-amz-meta-user-id": encodeURIComponent(userId),
    });
  });

  it("uses flat 10-character keys and signed filename metadata", async () => {
    const orgId = `org_${randomUUID()}`;
    const peer = { userId: `user_${randomUUID()}`, orgId };
    mocks.clerk.session(peer.userId, peer.orgId);
    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await client.prepare({
      body: {
        filename: "财务 报告.PDF",
        contentType: "application/pdf",
        size: 13,
      },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }

    expect(response.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.pdf$/,
    );
    expect(response.body.url).not.toContain(peer.userId);
    expect(response.body).toMatchObject({
      uploadHeaders: {
        "x-amz-meta-artifact-id": response.body.id,
        "x-amz-meta-filename": encodeURIComponent("财务 报告.PDF"),
        "x-amz-meta-public-brand": "okou",
        "x-amz-meta-user-id": encodeURIComponent(peer.userId),
      },
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls[0]?.[1] as {
      input: {
        Key: string;
        Metadata: Readonly<Record<string, string>>;
      };
    };
    expect(signedCommand.input).toMatchObject({
      Key: expect.stringMatching(/^artifacts\/[0-9a-z]{10}\.pdf$/),
      Metadata: {
        "artifact-id": response.body.id,
        filename: encodeURIComponent("财务 报告.PDF"),
        "public-brand": "okou",
        "user-id": encodeURIComponent(peer.userId),
      },
    });
    expect(context.mocks.s3.getSignedUrl.mock.calls[0]?.[2]).toMatchObject({
      unhoistableHeaders: new Set([
        "x-amz-meta-artifact-id",
        "x-amz-meta-filename",
        "x-amz-meta-public-brand",
        "x-amz-meta-user-id",
      ]),
    });
  });

  it("retries with a new artifact id when a flat hash is occupied", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = { userId: `user_${randomUUID()}`, orgId };
    mocks.clerk.session(actor.userId, actor.orgId);
    const prefixes: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command?.constructor.name !== "ListObjectsV2Command") {
        return Promise.resolve({});
      }
      const input = (command as { input: { Prefix?: string } }).input;
      const prefix = input.Prefix ?? "";
      prefixes.push(prefix);
      if (prefixes.length === 1) {
        return Promise.resolve({
          Contents: [
            {
              Key: `${prefix}txt`,
              Size: 1,
              LastModified: nowDate(),
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const response = await setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    ).prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      throw new Error("Expected flat artifact upload preparation to succeed");
    }
    expect(prefixes).toHaveLength(2);
    expect(prefixes[1]).not.toBe(prefixes[0]);
    expect(response.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.txt$/,
    );
  });

  it("rejects suspended orgs with insufficient credits", async () => {
    const actor = bdd.user();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    if (!actor.orgId) {
      throw new Error("Expected suspended upload prepare actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    mocks.clerk.session(actor.userId, actor.orgId);

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await accept(
      client.prepare({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("normalizes staff entitlement lifecycle statuses for suspension checks", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = createUniqueStaffOrgIdFixture();
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/upload?sig=staff-entitlement",
    );
    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    mocks.clerk.session(userId, orgId);
    onTestFinished(async () => {
      await deleteOrgPlanEntitlementFixture(orgId);
    });

    await seedOrgMetadata({
      orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    for (const status of ["trialing", "past_due"] as const) {
      await upsertOrgPlanEntitlementFixture({
        orgId,
        status,
      });
      await accept(
        client.prepare({
          body: validBody(),
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
    }

    await seedOrgMetadata({
      orgId,
      tier: "pro",
      credits: 1000,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "canceled",
    });
    const response = await accept(
      client.prepare({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("uses the public S3 endpoint for externally consumed upload URLs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    mockEnv("S3_ENDPOINT", "http://internal-s3.example.com");
    mockEnv("S3_PUBLIC_ENDPOINT", "http://public-s3.example.com");

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await client.prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);

    expect(
      context.mocks.s3.clientConfig.mock.calls.map(([config]) => {
        return config;
      }),
    ).toContainEqual(
      expect.objectContaining({
        endpoint: "http://public-s3.example.com",
        credentials: {
          accessKeyId: "test-artifacts-access-key",
          secretAccessKey: "test-artifacts-secret-key",
        },
        region: "auto",
        forcePathStyle: false,
        requestChecksumCalculation: "WHEN_REQUIRED",
      }),
    );
  });

  it("preserves original filenames in metadata while using flat keys", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    await client.prepare({
      body: {
        filename: "my file (1).txt",
        contentType: "text/plain",
        size: 10,
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const command = calls[0]?.[1] as {
      input: {
        Bucket: string;
        Key: string;
        Metadata: Readonly<Record<string, string>>;
      };
    };
    expect(command.input.Bucket).toBe("test-user-artifacts");
    expect(command.input.Key).toMatch(/^artifacts\/[0-9a-z]{10}\.txt$/);
    expect(command.input.Key).not.toContain(userId);
    expect(command.input.Metadata).toMatchObject({
      filename: encodeURIComponent("my file (1).txt"),
      "public-brand": "okou",
      "user-id": encodeURIComponent(userId),
    });
  });

  it("accepts representative MIME types from the allowlist", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const cases = [
      { filename: "screenshot.avif", contentType: "image/avif" },
      { filename: "report.html", contentType: "text/html" },
      { filename: "clip.mp3", contentType: "audio/mpeg" },
      { filename: "archive.zip", contentType: "application/zip" },
      {
        filename: "backup.7z",
        contentType: "application/x-7z-compressed",
      },
      { filename: "bundle.tar", contentType: "application/x-tar" },
      { filename: "bundle.tgz", contentType: "application/gzip" },
      { filename: "design.psd", contentType: "image/vnd.adobe.photoshop" },
      { filename: "vector.ai", contentType: "application/postscript" },
      { filename: "photo.heic", contentType: "image/heic" },
      { filename: "scan.tiff", contentType: "image/tiff" },
      {
        filename: "brief.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        filename: "budget.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        filename: "deck.pptx",
        contentType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      {
        filename: "document.pages",
        contentType: "application/vnd.apple.pages",
      },
      {
        filename: "sheet.numbers",
        contentType: "application/vnd.apple.numbers",
      },
      {
        filename: "slides.key",
        contentType: "application/vnd.apple.keynote",
      },
      {
        filename: "macro.xlsm",
        contentType: "application/vnd.ms-excel.sheet.macroenabled.12",
      },
      {
        filename: "template.potx",
        contentType:
          "application/vnd.openxmlformats-officedocument.presentationml.template",
      },
      { filename: "doc.pdf", contentType: "application/pdf" },
      { filename: "data.xml", contentType: "application/xml" },
      { filename: "config.yaml", contentType: "application/yaml" },
      { filename: "table.tsv", contentType: "text/tab-separated-values" },
      {
        filename: "events.parquet",
        contentType: "application/vnd.apache.parquet",
      },
      { filename: "local.sqlite", contentType: "application/vnd.sqlite3" },
      { filename: "book.epub", contentType: "application/epub+zip" },
    ] as const;

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    for (const { filename, contentType } of cases) {
      const response = await client.prepare({
        body: { filename, contentType, size: 4096 },
        headers: { authorization: "Bearer clerk-session" },
      });
      expect(response.status).toBe(200);
      if (response.status !== 200) {
        continue;
      }
      expect(response.body).toMatchObject({ filename, contentType });
    }
  });

  it("returns 403 for sandbox token without file:write capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId,
      orgId,
      runId,
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context, routes: uploadsTestRoutes })(
      uploadsContract,
    );
    const response = await accept(
      client.prepare({
        body: validBody(),
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("file:write");
  });
});
