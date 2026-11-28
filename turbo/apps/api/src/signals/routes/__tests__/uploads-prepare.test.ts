import { randomUUID } from "node:crypto";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi } from "./helpers/api-bdd";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const httpUrl = /^https?:\/\//;
const publicTextUrl = /^https:\/\/a\.okou\.io\/[A-Za-z0-9_-]{10}\.txt$/;
const publicPdfUrl = /^https:\/\/a\.okou\.io\/[A-Za-z0-9_-]{10}\.pdf$/;
const publicPdfKey = /^artifacts\/[A-Za-z0-9_-]{10}\.pdf$/;

interface StorageWrite {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface SignedUpload {
  readonly input: Record<string, unknown>;
  readonly unhoistableHeaders: ReadonlySet<string> | undefined;
}

/** Record R2 writes and presigned uploads at the storage boundary. */
function recordStorage() {
  const writes: StorageWrite[] = [];
  const signed: SignedUpload[] = [];
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    writes.push({ name: constructor.name, input });
    return Promise.resolve({});
  });
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown, signing: unknown) => {
      const { input } = command as {
        readonly input: Record<string, unknown>;
      };
      signed.push({
        input,
        unhoistableHeaders: (
          signing as { readonly unhoistableHeaders?: ReadonlySet<string> }
        ).unhoistableHeaders,
      });
      return Promise.resolve(
        `https://r2.example.com/${String(input.Bucket)}/${String(input.Key)}`,
      );
    },
  );
  return {
    signed,
    registration() {
      const write = writes.find((entry) => {
        return (
          entry.name === "PutObjectCommand" &&
          String(entry.input.Body).includes('"legacy-file"')
        );
      });
      if (!write) {
        throw new Error("Expected a legacy-file registration");
      }
      return write;
    },
  };
}

function signIn(actor: {
  readonly userId: string;
  readonly orgId: string | null;
}) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return api();
}

function api() {
  return setupApp({ context, routes: uploadsPrepareRoutes })(uploadsContract);
}

function member() {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function orgless() {
  return { userId: `user_${randomUUID()}`, orgId: null };
}

const helloTxt = {
  filename: "hello.txt",
  contentType: "text/plain",
  size: 13,
} as const;

describe("POST /api/uploads/prepare", () => {
  it("uploads-prepare-007 rejects a file larger than 5 GB", async () => {
    recordStorage();
    const response = await accept(
      signIn(member()).prepare({
        headers,
        body: {
          filename: "big.bin",
          contentType: "application/octet-stream",
          size: 5 * 1024 * 1024 * 1024 + 1,
        },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("File too large");
  });

  it("uploads-prepare-003 rejects an unauthenticated caller", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const response = await accept(
      api().prepare({ headers: {}, body: helloTxt }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("uploads-prepare-006 returns public artifact metadata for an organization-less browser upload", async () => {
    recordStorage();
    const client = signIn(orgless());

    const response = await accept(
      client.prepare({
        headers,
        extraHeaders: { origin: "https://app.okou.ai" },
        body: helloTxt,
      }),
      [200],
    );

    if (!("uploadUrl" in response.body)) {
      throw new Error("Expected a single-part upload");
    }
    expect(response.body.url).toMatch(publicTextUrl);
    expect(response.body.uploadHeaders).toMatchObject({
      "x-amz-meta-public-brand": "okou",
    });
  });

  it("uploads-prepare-008 falls back to a generic content type for an unrecognized MIME value", async () => {
    recordStorage();
    const response = await accept(
      signIn(member()).prepare({
        headers,
        body: {
          filename: "capture.custom",
          contentType: "Application/X-Custom; Version=1",
          size: 10,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "capture.custom",
      contentType: "application/octet-stream",
      size: 10,
    });
  });

  it('uploads-prepare-009 prepares Text/Markdown; Charset="UTF-8" with compatible upload metadata', async () => {
    const storage = recordStorage();
    const response = await accept(
      signIn(orgless()).prepare({
        headers,
        body: {
          filename: "artifact.bin",
          contentType: 'Text/Markdown; Charset="UTF-8"',
          size: 32,
        },
      }),
      [200],
    );

    expect(response.body.contentType).toBe("text/markdown; charset=utf-8");
    expect(String(storage.registration().input.Body)).toContain(
      '"contentType":"text/markdown; charset=utf-8"',
    );
    expect(storage.signed).toHaveLength(1);
    expect(storage.signed[0]?.input.ContentType).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("uploads-prepare-015 returns the presigned upload URL and final CDN URL", async () => {
    recordStorage();
    const actor = orgless();
    const response = await accept(
      signIn(actor).prepare({ headers, body: helloTxt }),
      [200],
    );

    if (!("uploadUrl" in response.body)) {
      throw new Error("Expected a single-part upload");
    }
    expect(response.body).toMatchObject(helloTxt);
    expect(response.body.uploadUrl).toMatch(httpUrl);
    expect(response.body.url).toMatch(publicTextUrl);
    expect(response.body.id).toMatch(uuid);
    expect(response.body.uploadHeaders).toStrictEqual({
      "x-amz-meta-artifact-id": response.body.id,
      "x-amz-meta-filename": "hello.txt",
      "x-amz-meta-public-brand": "okou",
      "x-amz-meta-user-id": encodeURIComponent(actor.userId),
    });
  });

  it("uploads-prepare-016 signs a flat 10-character key with filename metadata", async () => {
    const storage = recordStorage();
    const actor = orgless();
    const filename = "财务 报告.PDF";
    const response = await accept(
      signIn(actor).prepare({
        headers,
        body: { filename, contentType: "application/pdf", size: 2048 },
      }),
      [200],
    );

    if (!("uploadUrl" in response.body)) {
      throw new Error("Expected a single-part upload");
    }
    expect(response.body.url).toMatch(publicPdfUrl);
    expect(response.body.url).not.toContain(actor.userId);
    const metadata = {
      "artifact-id": response.body.id,
      filename: encodeURIComponent(filename),
      "public-brand": "okou",
      "user-id": encodeURIComponent(actor.userId),
    };
    expect(response.body.uploadHeaders).toStrictEqual({
      "x-amz-meta-artifact-id": metadata["artifact-id"],
      "x-amz-meta-filename": metadata.filename,
      "x-amz-meta-public-brand": metadata["public-brand"],
      "x-amz-meta-user-id": metadata["user-id"],
    });
    expect(storage.signed).toHaveLength(1);
    const upload = storage.signed[0]!;
    expect(String(upload.input.Key)).toMatch(publicPdfKey);
    expect(upload.input.Metadata).toStrictEqual(metadata);
    expect([...(upload.unhoistableHeaders ?? [])].sort()).toStrictEqual([
      "x-amz-meta-artifact-id",
      "x-amz-meta-filename",
      "x-amz-meta-public-brand",
      "x-amz-meta-user-id",
    ]);
  });

  it("uploads-prepare-018 rejects a suspended unfunded Pro organization", async () => {
    const actor = bdd.user();
    bdd.acceptStorageWrites();
    const workspace = createPublicUnfundedProFixture(context, actor);
    await workspace.initialize();
    await workspace.suspend();

    await workspace.run(async () => {
      recordStorage();
      const response = await accept(
        signIn(actor).prepare({ headers, body: helloTxt }),
        [402],
      );
      expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    });
  });

  it("uploads-prepare-019 (1/2) allows uploads while the Stripe subscription is trialing and past_due", async () => {
    const actor = bdd.user();
    bdd.acceptStorageWrites();
    await bdd.completeOnboarding(actor);
    const plan = publicPlanLifecycle(context, actor, "pro");
    recordStorage();

    await plan.update("trialing");
    const trialing = await accept(
      signIn(actor).prepare({ headers, body: helloTxt }),
      [200],
    );

    await plan.update("past_due");
    const pastDue = await accept(
      signIn(actor).prepare({ headers, body: helloTxt }),
      [200],
    );

    expect([trialing.status, pastDue.status]).toStrictEqual([200, 200]);
  });

  it("uploads-prepare-019 (2/2) rejects uploads once the Stripe subscription is canceled", async () => {
    const actor = bdd.user();
    bdd.acceptStorageWrites();
    await bdd.completeOnboarding(actor);
    const plan = publicPlanLifecycle(context, actor, "pro");
    recordStorage();

    await plan.update("canceled");
    const canceled = await accept(
      signIn(actor).prepare({ headers, body: helloTxt }),
      [402],
    );
    expect(canceled.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("uploads-prepare-022 accepts representative MIME types from the allowlist", async () => {
    recordStorage();
    const client = signIn(member());
    const files = [
      ["image.avif", "image/avif"],
      ["page.html", "text/html"],
      ["song.mp3", "audio/mpeg"],
      ["bundle.zip", "application/zip"],
      ["bundle.7z", "application/x-7z-compressed"],
      ["bundle.tar", "application/x-tar"],
      ["bundle.gz", "application/gzip"],
      ["design.psd", "image/vnd.adobe.photoshop"],
      ["vector.ai", "application/postscript"],
      ["photo.heic", "image/heic"],
      ["scan.tiff", "image/tiff"],
      [
        "report.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      [
        "sheet.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      [
        "deck.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
      ["letter.pages", "application/vnd.apple.pages"],
      ["budget.numbers", "application/vnd.apple.numbers"],
      ["talk.key", "application/vnd.apple.keynote"],
      ["macro.xlsm", "application/vnd.ms-excel.sheet.macroenabled.12"],
      [
        "template.potx",
        "application/vnd.openxmlformats-officedocument.presentationml.template",
      ],
      ["paper.pdf", "application/pdf"],
      ["feed.xml", "application/xml"],
      ["config.yaml", "application/yaml"],
      ["table.tsv", "text/tab-separated-values"],
      ["events.parquet", "application/vnd.apache.parquet"],
      ["store.sqlite", "application/vnd.sqlite3"],
      ["novel.epub", "application/epub+zip"],
    ] as const;
    expect(files).toHaveLength(26);

    for (const [filename, contentType] of files) {
      const response = await accept(
        client.prepare({
          headers,
          body: { filename, contentType, size: 4096 },
        }),
        [200],
      );
      expect(response.body).toMatchObject({ filename, contentType });
    }
  });
});
