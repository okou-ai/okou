import {
  userTemplatesContract,
  type PublishUserTemplateBody,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getUserTemplateStorageName } from "@okouai/core/storage-names";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { ClerkRateLimitError } from "../../external/clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  installS3Fixture,
  tarGz,
  uploadTemplateFile,
  type Fixture,
} from "./helpers/template-publish-fixture";
import { userTemplatesRoutes } from "../user-templates";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const storageApi = createStoragesBddApi(context);

const SOURCE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PACKAGE_CONTENT_TYPE = "application/gzip";

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function templateClient() {
  return setupApp({ context, routes: userTemplatesRoutes })(
    userTemplatesContract,
  );
}

/**
 * What each template-extraction branch actually writes.
 *
 * `presentation-extract-template` produces the visual language as prose;
 * `docx-extract-template` produces `reference.docx`, which is what pandoc
 * consumes, and writes no `design-system.md` at all; the illustration branch
 * writes the locked frame and the prompt into `SKILL.md` itself and saves its
 * example pictures under names that follow the subject and dials they
 * demonstrate. A fixture that gave every kind the same files would agree with
 * the endpoint and disagree with the packages it has to accept.
 */
function guidance(
  kind: UserTemplateKind,
): readonly { path: string; content: string }[] {
  switch (kind) {
    case "presentation": {
      return [
        { path: "SKILL.md", content: "# Use this template\n" },
        { path: "design-system.md", content: "Ink on warm paper.\n" },
      ];
    }
    case "document": {
      return [
        { path: "SKILL.md", content: "# Use this template\n" },
        { path: "reference.docx", content: "PK reference bytes\n" },
      ];
    }
    case "illustration": {
      return [
        { path: "SKILL.md", content: "# Draw in this style\n" },
        { path: "ref-market-sage.png", content: "approved piece\n" },
      ];
    }
  }
}

/** A directory entry with a name of its own, to tell two members apart. */
function clerkProfile(userId: string, firstName: string, lastName: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    emailAddresses: [{ id: emailId, emailAddress: `${userId}@example.test` }],
    primaryEmailAddressId: emailId,
    firstName,
    lastName,
    username: null,
    imageUrl: "",
    privateMetadata: {},
  };
}

/** Signs a member in and turns the switch on for them. */
async function enableFor(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("User template tests require an organization");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
    { [FeatureSwitchKey.CustomTemplates]: true },
  );
}

async function publishBody(
  actor: ApiTestUser,
  fixture: Fixture,
  archive: Buffer = tarGz(guidance("presentation")),
): Promise<PublishUserTemplateBody> {
  const sourceFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "brand-system.pptx", contentType: SOURCE_CONTENT_TYPE },
    Buffer.from("PK deck bytes", "utf8"),
  );
  const pageFileIds = [
    await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "page-001.png", contentType: "image/png" },
      Buffer.from("cover", "utf8"),
    ),
    await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "page-002.png", contentType: "image/png" },
      Buffer.from("second", "utf8"),
    ),
  ];
  const packageFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
    archive,
  );
  return {
    title: "Brand system",
    kind: "presentation",
    sourceFileId,
    pageFileIds,
    packageFileId,
  };
}

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A document publish body carrying whatever the reverse run managed to render.
 *
 * Both of the document arm's fields are optional and separately so, which is
 * the point of taking them separately here: a test that omits one is covering
 * a run that produced the other and nothing more.
 */
async function documentPublishBody(
  actor: ApiTestUser,
  fixture: Fixture,
  rendered: {
    readonly cover?: { readonly contentType: string };
    readonly pageCount?: number;
  } = {},
): Promise<PublishUserTemplateBody> {
  const sourceFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "brand-report.docx", contentType: DOCX_CONTENT_TYPE },
    Buffer.from("PK docx bytes", "utf8"),
  );
  const coverFileId =
    rendered.cover === undefined
      ? undefined
      : await uploadTemplateFile(
          context,
          actor,
          fixture,
          {
            filename: "cover.png",
            contentType: rendered.cover.contentType,
          },
          Buffer.from("first page", "utf8"),
        );
  const packageFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
    tarGz(guidance("document")),
  );
  return {
    title: "Brand report",
    kind: "document",
    sourceFileId,
    ...(coverFileId === undefined ? {} : { coverFileId }),
    ...(rendered.pageCount === undefined
      ? {}
      : { pageCount: rendered.pageCount }),
    packageFileId,
  };
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
});

describe("POST /api/user-templates", () => {
  it("publishes a compiled reverse run as a private template", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(actor, fixture),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      title: "Brand system",
      kind: "presentation",
      sourceFilename: "brand-system.pptx",
      pageCount: 2,
      visibility: "private",
      ownerUserId: actor.userId,
      canManage: true,
    });
    // The package is addressed by the row id, so no column points at it.
    expect(getUserTemplateStorageName(response.body.id)).toBe(
      `user-template@${response.body.id}`,
    );
    expect(
      fixture.keys().some((key) => {
        return key.endsWith("/archive.tar.gz");
      }),
    ).toBeTruthy();
  });

  it("accepts a pdf source, which the import picker already offers", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const body = await publishBody(actor, fixture);
    // Rejecting a format the picker lets the user choose would fail only after
    // the reverse run had already done its work.
    const pdfSourceId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "brand-system.pdf", contentType: "application/pdf" },
      Buffer.from("%PDF-1.7", "utf8"),
    );

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: { ...body, sourceFileId: pdfSourceId },
      }),
      [200],
    );
    expect(response.body.sourceFilename).toBe("brand-system.pdf");
  });

  it("publishes a document template without page images", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const docxSourceId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      {
        filename: "brand-report.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      Buffer.from("PK docx bytes", "utf8"),
    );
    // The package the docx reverse skill actually writes: no design-system.md.
    const packageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz(guidance("document")),
    );

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: {
          title: "Brand report",
          kind: "document",
          sourceFileId: docxSourceId,
          packageFileId,
        },
      }),
      [200],
    );

    // A document is its styles, so it has no pages — null rather than a zero
    // that would read as an empty template. This one was also published
    // without a rendered first page, so it has no cover either, and nothing
    // for the catalog to stack behind one.
    expect(response.body).toMatchObject({
      kind: "document",
      sourceFilename: "brand-report.docx",
      pageCount: null,
      coverUrl: null,
      coverHasMorePages: false,
    });

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.previewAssets).toStrictEqual([]);

    // Nothing was rendered, so the detail answers with the file itself: it is
    // the only thing there is to show, and the reader opening the template is
    // the moment its URL is worth minting.
    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: response.body.id },
      }),
      [200],
    );
    expect(detail.body.pageUrls).toStrictEqual([]);
    // The object that URL signs is the document itself, not the package
    // archive uploaded beside it. Stored names are generated, so the extension
    // is what identifies it.
    expect(fixture.signedKey(detail.body.sourceUrl)).toBe(
      fixture.keys().find((key) => {
        return key.endsWith(".docx");
      }),
    );
  });

  it("covers a document with its first page without calling it a page", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: await documentPublishBody(actor, fixture, {
          cover: { contentType: "image/png" },
          pageCount: 12,
        }),
      }),
      [200],
    );

    // The picture is a cover and only a cover. `pageCount` stays null because
    // it answers how many pages this template renders, which is still none;
    // how long the source was reaches the catalog as the one thing the tile
    // does with it.
    expect(response.body).toMatchObject({
      kind: "document",
      coverHasMorePages: true,
      pageCount: null,
    });
    expect(response.body.coverUrl).not.toBeNull();

    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: response.body.id },
      }),
      [200],
    );
    // Not in `pageUrls`: a reader opening a document is given the file to
    // read, not one picture of its opening. Putting the cover here is what
    // would replace the source viewer with a dead end.
    expect(detail.body.pageUrls).toStrictEqual([]);
    expect(detail.body.previewAssets).toHaveLength(1);
  });

  it("leaves a one-page document nothing to stack behind its cover", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: await documentPublishBody(actor, fixture, {
          cover: { contentType: "image/png" },
          pageCount: 1,
        }),
      }),
      [200],
    );

    expect(response.body.coverUrl).not.toBeNull();
    // An invitation is one page. Sheets behind it would claim a second.
    // `toMatchObject` rather than `toBeFalsy`, which would also accept the
    // `undefined` an absent field would produce.
    expect(response.body).toMatchObject({ coverHasMorePages: false });
  });

  it("keeps a page count that arrived without a cover from claiming one", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: await documentPublishBody(actor, fixture, { pageCount: 12 }),
      }),
      [200],
    );

    // The count is recorded and the catalog still has nothing to draw, so the
    // template falls back to being named by its file. A stack with no sheet in
    // front of it is what pairing the two fields would have had to prevent by
    // rejecting the publish instead.
    expect(response.body.coverUrl).toBeNull();
    expect(response.body).toMatchObject({ coverHasMorePages: false });
  });

  it("refuses a cover the catalog could not paint", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: await documentPublishBody(actor, fixture, {
          cover: { contentType: "image/webp" },
          pageCount: 12,
        }),
      }),
      [400],
    );
    expect(response.body.error.message).toContain("image/png");
  });

  it("publishes an illustration template and covers it with its source", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const referenceId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "market-day.png", contentType: "image/png" },
      Buffer.from("PNG reference bytes", "utf8"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz(guidance("illustration")),
    );

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: {
          title: "Market day",
          kind: "illustration",
          sourceFileId: referenceId,
          packageFileId,
        },
      }),
      [200],
    );

    // No pages, but a cover: the source is already a picture, so the catalog
    // has something to show without anything having been rendered.
    expect(response.body).toMatchObject({
      kind: "illustration",
      sourceFilename: "market-day.png",
      pageCount: null,
    });
    expect(response.body.coverUrl).not.toBeNull();

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    // One preview asset, and it is a handle the resolve endpoint accepts —
    // the grid reissues its covers through that endpoint once they expire.
    const previewAssetIds = (listed.body[0]?.previewAssets ?? []).map(
      (asset) => {
        return asset.previewAssetId;
      },
    );
    expect(previewAssetIds).toHaveLength(1);
    const reresolved = await accept(
      client.resolvePreviewUrls({
        headers: webHeaders(),
        body: { previewAssetIds },
      }),
      [200],
    );
    expect(reresolved.body.assets).toHaveLength(1);

    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: response.body.id },
      }),
      [200],
    );
    // The cover is the source, so both point at the same object — and it is
    // still not a page, so the column a reader would scroll stays empty.
    expect(detail.body.pageUrls).toStrictEqual([]);
    expect(fixture.signedKey(detail.body.sourceUrl)).toBe(
      fixture.keys().find((key) => {
        return key.endsWith(".png");
      }),
    );
  });

  it("refuses a source the kind it was published as cannot be shown as", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const docxSourceId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      {
        filename: "brand-report.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      Buffer.from("PK docx bytes", "utf8"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz(guidance("illustration")),
    );

    // An illustration is shown in the catalog by its source, so a source no
    // browser can draw would leave a tile that never loads. The package here
    // is the one the illustration branch writes, so only the source is wrong.
    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: {
          title: "Brand report",
          kind: "illustration",
          sourceFileId: docxSourceId,
          packageFileId,
        },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("illustration");
  });

  it("takes a document package that carries its skill and nothing else", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const docxSourceId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      {
        filename: "brand-report.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      Buffer.from("PK docx bytes", "utf8"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz([{ path: "SKILL.md", content: "# Use this template\n" }]),
    );

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: {
          title: "Brand report",
          kind: "document",
          sourceFileId: docxSourceId,
          packageFileId,
        },
      }),
      [200],
    );

    // The skill names the artifact it consumes and the command that consumes
    // it, so what else the package carries is that account's business. Naming
    // a second file here would let a reverse skill that changed its own output
    // be refused by an endpoint that had not changed with it.
    expect(response.body.kind).toBe("document");
  });

  it("replaces a template's package without touching anything else", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(actor, fixture),
      }),
      [200],
    );
    const rebuilt = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz([
        { path: "SKILL.md", content: "# Use this template, revised\n" },
        { path: "design-system.md", content: "Ink on cool paper.\n" },
      ]),
    );

    const response = await accept(
      client.replacePackage({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { packageFileId: rebuilt },
      }),
      [200],
    );

    // Rebuilding the guidance is not re-reversing the source, so everything
    // the catalog shows still describes the file this was compiled from — and
    // every message already carrying this template keeps pointing at it.
    expect(response.body).toMatchObject({
      id: published.body.id,
      title: published.body.title,
      kind: published.body.kind,
      sourceFilename: published.body.sourceFilename,
      pageCount: published.body.pageCount,
      visibility: published.body.visibility,
    });
  });

  it("replaces the stored package rather than adding to it", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const threeFiles = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz([
        ...guidance("presentation"),
        { path: "swatches.md", content: "Retired on the next pass.\n" },
      ]),
    );
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: {
          ...(await publishBody(actor, fixture)),
          packageFileId: threeFiles,
        },
      }),
      [200],
    );
    const storageName = getUserTemplateStorageName(published.body.id);
    const storedFileCount = async () => {
      const storages = await storageApi.listStorages(actor, "organization");
      return storages.find((storage) => {
        return storage.name === storageName;
      })?.fileCount;
    };
    await expect(storedFileCount()).resolves.toBe(3);

    const twoFiles = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz(guidance("presentation")),
    );
    await accept(
      client.replacePackage({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { packageFileId: twoFiles },
      }),
      [200],
    );

    // Two, not three. A rebuild that dropped a file has dropped it: the new
    // version is exactly what was sent, so nothing the guide no longer
    // mentions is left behind for a run to read.
    await expect(storedFileCount()).resolves.toBe(2);
  });

  it("applies the row's kind to the replacement, not the caller's", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(actor, fixture),
      }),
      [200],
    );
    // A document's package would pass its own rules. This row is a deck, and
    // the row is what decides: the body says nothing about kind at all.
    const documentShaped = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz(guidance("document")),
    );

    const response = await accept(
      client.replacePackage({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { packageFileId: documentShaped },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("design-system.md");
  });

  it("hides a colleague's template from a package replacement", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    await enableFor(owner);
    const client = templateClient();
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(owner, fixture),
      }),
      [200],
    );

    // Shared with the organization first, so the colleague can genuinely read
    // it. A private row would be refused by the visibility rule before the
    // ownership check ran, and this test would prove nothing about ownership.
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "organization" },
      }),
      [200],
    );

    const colleague = bdd.user({ orgId: owner.orgId });
    await enableFor(colleague);
    const rebuilt = await uploadTemplateFile(
      context,
      colleague,
      fixture,
      { filename: "package.tar.gz", contentType: PACKAGE_CONTENT_TYPE },
      tarGz(guidance("presentation")),
    );

    // Readable, and still not theirs to rewrite. Answering "you may read this
    // but not change it" would be a different answer from the one a template
    // they cannot see gets, so both say missing.
    const response = await accept(
      client.replacePackage({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { packageFileId: rebuilt },
      }),
      [404],
    );
    expect(response.body.error.message).toBe(
      `User template not found: ${published.body.id}`,
    );
  });

  it("leaves every change to the owner, not to everyone who can see it", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    await enableFor(owner);
    const client = templateClient();
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(owner, fixture),
      }),
      [200],
    );
    // Shared, so the colleague genuinely reads it: a private row would be
    // refused by the visibility rule and prove nothing about ownership.
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "organization" },
      }),
      [200],
    );

    const colleague = bdd.user({ orgId: owner.orgId });
    await enableFor(colleague);
    await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [200],
    );

    // Reading it is not owning it. Retracting a colleague's template from the
    // organization, renaming it, or deleting it are all theirs to refuse.
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "private" },
      }),
      [404],
    );
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { title: "Renamed by someone else" },
      }),
      [404],
    );
    await accept(
      client.delete({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: undefined,
      }),
      [404],
    );

    const stillThere = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [200],
    );
    expect(stillThere.body).toMatchObject({
      title: published.body.title,
      visibility: "organization",
    });
  });

  it("rejects a package that is missing its required guidance", async () => {
    const fixture = installS3Fixture(context);
    const actor = bdd.user();
    await enableFor(actor);
    const client = templateClient();

    const response = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(
          actor,
          fixture,
          tarGz([{ path: "SKILL.md", content: "# Only half\n" }]),
        ),
      }),
      [400],
    );
    expect(response.body.error.message).toContain("design-system.md");
  });

  it("keeps a private template out of a colleague's catalog", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    await enableFor(owner);
    const client = templateClient();
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(owner, fixture),
      }),
      [200],
    );

    // A second member of the same organization.
    const colleague = bdd.user({ orgId: owner.orgId });
    await enableFor(colleague);

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toStrictEqual([]);
    await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [404],
    );
    expect(colleague.userId).not.toBe(owner.userId);
  });

  it("shows an organization template to a colleague without letting them manage it", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    await enableFor(owner);
    const client = templateClient();
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(owner, fixture),
      }),
      [200],
    );
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "organization" },
      }),
      [200],
    );

    const colleague = bdd.user({ orgId: owner.orgId });
    await enableFor(colleague);

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toHaveLength(1);
    // Readable, attributed to its owner, and not theirs to change.
    expect(listed.body[0]).toMatchObject({
      id: published.body.id,
      visibility: "organization",
      ownerUserId: owner.userId,
      canManage: false,
    });
    // Management is owner-only, and a non-owner is told nothing more than that
    // the template is not theirs.
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { title: "Renamed by a colleague" },
      }),
      [404],
    );
    await accept(
      client.delete({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [404],
    );
  });

  it("names a colleague's template after the person, not the account id", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    await enableFor(owner);
    const client = templateClient();
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(owner, fixture),
      }),
      [200],
    );
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "organization" },
      }),
      [200],
    );

    const colleague = bdd.user({ orgId: owner.orgId });
    await enableFor(colleague);
    // Two members with different names, so the answer has to be the owner's
    // rather than whichever profile the directory happened to return.
    mockClerkUsers(context, [
      clerkProfile(owner.userId, "Mina", "Okafor"),
      clerkProfile(colleague.userId, "Sam", "Reader"),
    ]);

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body[0]).toMatchObject({
      ownerUserId: owner.userId,
      ownerDisplayName: "Mina Okafor",
    });
    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: published.body.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({ ownerDisplayName: "Mina Okafor" });
  });

  it("still lists a template whose owner the provider cannot name", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    await enableFor(owner);
    const client = templateClient();
    const published = await accept(
      client.publish({
        headers: webHeaders(),
        body: await publishBody(owner, fixture),
      }),
      [200],
    );
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: published.body.id },
        body: { visibility: "organization" },
      }),
      [200],
    );

    const colleague = bdd.user({ orgId: owner.orgId });
    await enableFor(colleague);
    // Who owns a template decides nothing about who may read it, so a provider
    // that cannot answer costs the name and not the row.
    context.mocks.clerk.users.getUserList.mockRejectedValue(
      new ClerkRateLimitError("Clerk is rate limiting reads", 30),
    );

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: published.body.id,
      ownerUserId: owner.userId,
      ownerDisplayName: null,
      canManage: false,
    });
  });
});
