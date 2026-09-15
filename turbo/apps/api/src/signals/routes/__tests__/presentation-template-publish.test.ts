import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { gzipSync } from "node:zlib";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES,
  PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  presentationTemplatesContract,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { getPresentationTemplateStorageName } from "@okouai/core/storage-names";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { presentationTemplatesRoutes } from "../presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const ARTIFACTS_BUCKET = "test-user-artifacts";

const SOURCE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const LEGACY_SOURCE_CONTENT_TYPE = "application/vnd.ms-powerpoint";

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
function tarGz(files: readonly { path: string; content: string }[]): Buffer {
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

function installS3Fixture() {
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

type Fixture = ReturnType<typeof installS3Fixture>;

/** Run the ordinary three-step upload the CLI would run, and return its id. */
async function upload(
  actor: ApiTestUser,
  fixture: Fixture,
  file: { readonly filename: string; readonly contentType: string },
  body: Buffer,
): Promise<string> {
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

function templateClient() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
  );
}

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function guidance(): readonly { path: string; content: string }[] {
  return [
    { path: "SKILL.md", content: "# Use this template\n" },
    { path: "design-system.md", content: "Ink on warm paper.\n" },
  ];
}

async function uploadInputs(
  actor: ApiTestUser,
  fixture: Fixture,
  archive: Buffer,
  source: { readonly filename: string; readonly contentType: string } = {
    filename: "brand-system.pptx",
    contentType: SOURCE_CONTENT_TYPE,
  },
): Promise<{
  readonly sourceFileId: string;
  readonly pageFileIds: string[];
  readonly packageFileId: string;
}> {
  const sourceFileId = await upload(
    actor,
    fixture,
    source,
    Buffer.from("PK deck bytes", "utf8"),
  );
  const pageFileIds: string[] = [];
  for (const index of [0, 1]) {
    pageFileIds.push(
      await upload(
        actor,
        fixture,
        {
          filename: `page-00${(index + 1).toString()}.png`,
          contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
        },
        Buffer.from(`page ${index.toString()}`, "utf8"),
      ),
    );
  }
  const packageFileId = await upload(
    actor,
    fixture,
    {
      filename: "package.tar.gz",
      contentType: PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
    },
    archive,
  );
  return { sourceFileId, pageFileIds, packageFileId };
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", ARTIFACTS_BUCKET);
});

describe("presentation template publish", () => {
  it("publishes an analysed deck as a ready template", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(actor, fixture, tarGz(guidance()));

    mocks.clerk.session(actor.userId, actor.orgId);
    const published = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Brand system", ...inputs },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      title: "Brand system",
      sourceFilename: "brand-system.pptx",
      pageCount: 2,
    });
    expect(published.body.coverUrl).not.toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "presentationTemplatesChanged",
      null,
    );
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${actor.userId}`,
    );

    // The row is usable immediately: nothing is pending on a later transition.
    const listed = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    const catalogPreviewAssets = listed.body[0]?.previewAssets;
    expect(catalogPreviewAssets).toHaveLength(2);
    if (catalogPreviewAssets === undefined) {
      throw new Error("Expected prefetched presentation preview assets");
    }
    const detail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [200],
    );
    expect(detail.body.pageUrls).toHaveLength(2);
    expect(detail.body.previewAssets).toStrictEqual(catalogPreviewAssets);
    expect(
      catalogPreviewAssets.map((asset) => {
        return asset.url;
      }),
    ).toStrictEqual(detail.body.pageUrls);
    const previewAssetIds = catalogPreviewAssets.map((asset) => {
      return asset.previewAssetId;
    });
    const firstPreviewUrls = await accept(
      templateClient().resolvePreviewUrls({
        headers: webHeaders(),
        body: { previewAssetIds },
      }),
      [200],
    );
    const secondPreviewUrls = await accept(
      templateClient().resolvePreviewUrls({
        headers: webHeaders(),
        body: { previewAssetIds },
      }),
      [200],
    );
    expect(firstPreviewUrls.body.assets).toHaveLength(2);
    expect(firstPreviewUrls.body.assets[0]?.url).toBe(detail.body.pageUrls[0]);
    expect(published.body.coverUrl).toBe(detail.body.pageUrls[0]);
    expect(secondPreviewUrls.body.assets).toStrictEqual(
      firstPreviewUrls.body.assets,
    );

    // The guidance package is stored under a name derived from the row id.
    const storageName = getPresentationTemplateStorageName(published.body.id);
    expect(storageName).toBe(`presentation-template@${published.body.id}`);
    expect(
      fixture.keys().some((key) => {
        return key.endsWith("/archive.tar.gz");
      }),
    ).toBeTruthy();
  });

  it("imports and previews private template files after creation is disabled", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    const flagActor = { ...actor, orgId: actor.orgId };
    await updateFeatureSwitchesForUser(context, flagActor, {
      [FeatureSwitchKey.PrivateArtifacts]: true,
    });
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(actor, fixture, tarGz(guidance()));
    await updateFeatureSwitchesForUser(context, flagActor, {
      [FeatureSwitchKey.PrivateArtifacts]: false,
    });
    const published = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Private template", ...inputs },
      }),
      [200],
    );
    const detail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [200],
    );
    expect(detail.body.pageUrls).toHaveLength(2);
    const downloads = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .filter((command) => {
        return command instanceof GetObjectCommand;
      });
    expect(
      downloads.some((command) => {
        return (
          command.input.Bucket === "test-private-artifacts" &&
          command.input.Key?.endsWith("package.tar.gz")
        );
      }),
    ).toBeTruthy();
    const previews = context.mocks.s3.getSignedUrl.mock.calls
      .map(([, command]) => {
        return command;
      })
      .filter((command) => {
        return command instanceof GetObjectCommand;
      });
    expect(previews.length).toBeGreaterThan(0);
    expect(
      previews.every((command) => {
        return command.input.Bucket === "test-private-artifacts";
      }),
    ).toBeTruthy();
  });

  it("publishes a legacy PowerPoint source without conversion", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(actor, fixture, tarGz(guidance()), {
      filename: "legacy-deck.ppt",
      contentType: LEGACY_SOURCE_CONTENT_TYPE,
    });

    mocks.clerk.session(actor.userId, actor.orgId);
    const published = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Legacy brand system", ...inputs },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      title: "Legacy brand system",
      sourceFilename: "legacy-deck.ppt",
      pageCount: 2,
    });
  });

  it("shares a public template with workspace members while keeping management owner-only", async () => {
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Presentation template sharing requires an organization");
    }
    const member = bdd.user({
      orgId: owner.orgId,
      orgRole: "org:member",
    });
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(owner, fixture, tarGz(guidance()));

    mocks.clerk.session(owner.userId, owner.orgId);
    const published = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Workspace brand", ...inputs },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      visibility: "private",
      canManage: true,
    });

    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const shared = await accept(
      templateClient().update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "public" },
      }),
      [200],
    );
    expect(shared.body).toMatchObject({
      visibility: "public",
      canManage: true,
    });
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${owner.orgId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "presentationTemplatesChanged",
      null,
    );

    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("workspace template invalidation failed"),
    );
    const renamed = await accept(
      templateClient().update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { title: "Workspace brand refreshed" },
      }),
      [200],
    );
    expect(renamed.body.title).toBe("Workspace brand refreshed");
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${owner.orgId}`,
    );

    mocks.clerk.session(member.userId, member.orgId);
    const listedForMember = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(listedForMember.body).toStrictEqual([
      expect.objectContaining({
        id: published.body.id,
        title: "Workspace brand refreshed",
        visibility: "public",
        canManage: false,
        previewAssets: expect.arrayContaining([
          expect.objectContaining({
            previewAssetId: expect.stringMatching(/^ptp:/),
          }),
        ]),
      }),
    ]);
    const detailForMember = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [200],
    );
    expect(detailForMember.body.pageUrls).toHaveLength(2);
    expect(detailForMember.body.canManage).toBeFalsy();
    expect(detailForMember.body.previewAssets).toStrictEqual(
      listedForMember.body[0]?.previewAssets,
    );
    const memberPreviewAssetIds = listedForMember.body[0]?.previewAssets?.map(
      (asset) => {
        return asset.previewAssetId;
      },
    );
    if (memberPreviewAssetIds === undefined) {
      throw new Error("Expected shared presentation preview asset ids");
    }
    const memberPreviewUrls = await accept(
      templateClient().resolvePreviewUrls({
        headers: webHeaders(),
        body: { previewAssetIds: memberPreviewAssetIds },
      }),
      [200],
    );
    expect(memberPreviewUrls.body.assets).toHaveLength(2);

    await accept(
      templateClient().update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { title: "Member rename" },
      }),
      [404],
    );
    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [404],
    );

    mocks.clerk.session(owner.userId, owner.orgId);
    context.mocks.ably.channelGet.mockClear();
    await accept(
      templateClient().update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "private" },
      }),
      [200],
    );
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${owner.orgId}`,
    );

    mocks.clerk.session(member.userId, member.orgId);
    const privateList = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(privateList.body).toStrictEqual([]);
    await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [404],
    );
    const revokedPreviewUrls = await accept(
      templateClient().resolvePreviewUrls({
        headers: webHeaders(),
        body: { previewAssetIds: memberPreviewAssetIds },
      }),
      [200],
    );
    expect(revokedPreviewUrls.body.assets).toStrictEqual([]);
  });

  it("deletes a template exactly once when two requests race", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(actor, fixture, tarGz(guidance()));

    mocks.clerk.session(actor.userId, actor.orgId);
    const published = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Brand system", ...inputs },
      }),
      [200],
    );

    await accept(
      templateClient().update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "public" },
      }),
      [200],
    );
    context.mocks.ably.channelGet.mockClear();

    const params = { templateId: published.body.id };
    const [first, second] = await Promise.all([
      accept(
        templateClient().delete({ headers: webHeaders(), params }),
        [204, 404],
      ),
      accept(
        templateClient().delete({ headers: webHeaders(), params }),
        [204, 404],
      ),
    ]);
    const statuses = [first.status, second.status].sort((left, right) => {
      return left - right;
    });
    expect(statuses).toStrictEqual([204, 404]);
    expect(context.mocks.ably.channelGet).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${actor.orgId}`,
    );

    const listed = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(listed.body).toHaveLength(0);
  });

  it("refuses a package that omits its required guidance", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(
      actor,
      fixture,
      tarGz([{ path: "SKILL.md", content: "# Only half of it\n" }]),
    );

    mocks.clerk.session(actor.userId, actor.orgId);
    const rejected = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Half a package", ...inputs },
      }),
      [400],
    );
    expect(rejected.body.error.message).toContain("design-system.md");

    // Nothing is created by a rejected publish.
    const listed = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(listed.body).toStrictEqual([]);
  });

  it("refuses a package path that escapes its root", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(
      actor,
      fixture,
      tarGz([...guidance(), { path: "../escaped.md", content: "nope\n" }]),
    );

    mocks.clerk.session(actor.userId, actor.orgId);
    const rejected = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Traversal", ...inputs },
      }),
      [400],
    );
    expect(rejected.body.error.message).toContain("Unsafe package path");
  });

  it("refuses a package that unpacks past the size cap", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    // Compresses to a few hundred kilobytes, so the stored object clears every
    // size check that reads the upload's own size. Only a cap on the
    // decompressed output can reject it.
    const bomb = gzipSync(
      Buffer.alloc(MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES + 1),
    );
    const inputs = await uploadInputs(actor, fixture, bomb);

    mocks.clerk.session(actor.userId, actor.orgId);
    const rejected = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Zip bomb", ...inputs },
      }),
      [400],
    );
    expect(rejected.body.error.message).toContain("must unpack to");

    const listed = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(listed.body).toStrictEqual([]);
  });

  it("refuses uploads that belong to someone else", async () => {
    const owner = bdd.user();
    const stranger = bdd.user();
    const fixture = installS3Fixture();
    const inputs = await uploadInputs(owner, fixture, tarGz(guidance()));

    mocks.clerk.session(stranger.userId, stranger.orgId);
    const rejected = await accept(
      templateClient().publish({
        headers: webHeaders(),
        body: { title: "Not mine", ...inputs },
      }),
      [400],
    );
    expect(rejected.body.error.message).toContain("Uploaded file not found");
  });
});
