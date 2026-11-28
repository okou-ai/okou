import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { describe, expect, it } from "vitest";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { userTemplatesRoutes } from "../user-templates";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkUsers } from "./helpers/clerk-users";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import {
  installS3Fixture,
  tarGz,
  uploadTemplateFile,
  type Fixture,
} from "./helpers/template-publish-fixture";

const context = testContext();
const bdd = createBddApi(context);
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PNG = "image/png";
const GZIP = "application/gzip";
const CHANGED = "presentationTemplatesChanged";

type PackageFiles = readonly { path: string; content: string | Buffer }[];

const DECK_PACKAGE: PackageFiles = Object.freeze([
  { path: "SKILL.md", content: "# Brand system" },
  { path: "design-system.md", content: "Use the brand palette." },
]);

function templatesApi() {
  return setupApp({ context, routes: userTemplatesRoutes })(
    userTemplatesContract,
  );
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function upload(
  actor: ApiTestUser,
  fixture: Fixture,
  filename: string,
  contentType: string,
  body: Buffer,
): Promise<string> {
  return uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename, contentType },
    body,
  );
}

async function uploadDeck(
  actor: ApiTestUser,
  fixture: Fixture,
  packageFiles: PackageFiles = DECK_PACKAGE,
) {
  const sourceFileId = await upload(
    actor,
    fixture,
    "brand-system.pptx",
    PPTX,
    Buffer.from("deck"),
  );
  const pageFileIds = [
    await upload(actor, fixture, "page-1.png", PNG, Buffer.from("png-1")),
    await upload(actor, fixture, "page-2.png", PNG, Buffer.from("png-2")),
  ];
  const packageFileId = await upload(
    actor,
    fixture,
    "package.tar.gz",
    GZIP,
    tarGz(packageFiles),
  );
  return {
    kind: "presentation" as const,
    sourceFileId,
    pageFileIds,
    packageFileId,
  };
}

async function publishDeck(actor: ApiTestUser, fixture: Fixture) {
  const inputs = await uploadDeck(actor, fixture);
  const response = await accept(
    templatesApi().publish({
      headers: signIn(actor),
      body: { ...inputs, title: "Brand system" },
    }),
    [200],
  );
  return response.body;
}

async function shareWithOrganization(owner: ApiTestUser, templateId: string) {
  await accept(
    templatesApi().update({
      headers: signIn(owner),
      params: { templateId },
      body: { visibility: "organization" },
    }),
    [200],
  );
}

function colleagueOf(owner: ApiTestUser): ApiTestUser {
  return bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
}

function forgetRealtime(): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

function userDirectory(
  people: readonly {
    readonly user: ApiTestUser;
    readonly firstName: string;
    readonly lastName: string;
  }[],
): void {
  mockClerkUsers(
    context,
    people.map(({ user, firstName, lastName }) => {
      return {
        id: user.userId,
        firstName,
        lastName,
        imageUrl: "",
        emailAddresses: [
          { id: `email_${user.userId}`, emailAddress: user.email },
        ],
        primaryEmailAddressId: `email_${user.userId}`,
      };
    }),
  );
}

describe("POST /api/user-templates", () => {
  it("user-template-publish-007 publishes a document template that has no page images", async () => {
    const fixture = installS3Fixture(context);
    const admin = bdd.user();
    const source = Buffer.from("docx-bytes");
    const sourceFileId = await upload(
      admin,
      fixture,
      "brand-report.docx",
      DOCX,
      source,
    );
    const packageFileId = await upload(
      admin,
      fixture,
      "package.tar.gz",
      GZIP,
      tarGz([
        { path: "SKILL.md", content: "# Brand report" },
        { path: "reference.docx", content: "reference" },
      ]),
    );
    const api = templatesApi();

    const published = await accept(
      api.publish({
        headers: signIn(admin),
        body: {
          kind: "document",
          title: "Brand report",
          sourceFileId,
          packageFileId,
        },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      kind: "document",
      sourceFilename: "brand-report.docx",
      pageCount: null,
      coverUrl: null,
      coverHasMorePages: false,
    });

    const headers = signIn(admin);
    const list = await accept(api.list({ headers }), [200]);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]?.previewAssets).toStrictEqual([]);
    const detail = await accept(
      api.get({ headers, params: { templateId: published.body.id } }),
      [200],
    );
    expect(detail.body.pageUrls).toStrictEqual([]);
    expect(fixture.readSignedObject(detail.body.sourceUrl)).toStrictEqual(
      source,
    );
  });
  it("user-template-publish-001 publishes an uploaded deck as a private template", async () => {
    const fixture = installS3Fixture(context);
    const admin = bdd.user();

    const published = await publishDeck(admin, fixture);

    expect(published).toMatchObject({
      title: "Brand system",
      kind: "presentation",
      sourceFilename: "brand-system.pptx",
      pageCount: 2,
      visibility: "private",
      ownerUserId: admin.userId,
      canManage: true,
    });
    expect(
      fixture.keys().filter((key) => {
        return /^bundles\/v1\/[0-9a-f]{64}\.tar\.gz$/u.test(key);
      }),
    ).toHaveLength(1);
  });
  it("user-template-publish-002 renames a private template while keeping its cover and owner", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    userDirectory([{ user: owner, firstName: "Mina", lastName: "Okafor" }]);
    const published = await publishDeck(owner, fixture);
    forgetRealtime();
    const api = templatesApi();

    const renamed = await accept(
      api.update({
        headers: signIn(owner),
        params: { templateId: published.id },
        body: { title: "Renamed brand" },
      }),
      [200],
    );

    expect(renamed.body).toMatchObject({
      id: published.id,
      title: "Renamed brand",
      visibility: "private",
      ownerUserId: owner.userId,
      ownerDisplayName: "Mina Okafor",
      canManage: true,
      sourceFilename: "brand-system.pptx",
      pageCount: 2,
      coverHasMorePages: true,
      createdAt: published.createdAt,
    });
    expect(Date.parse(renamed.body.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(published.updatedAt),
    );
    expect(fixture.signedKey(renamed.body.coverUrl ?? "")).toBe(
      fixture.signedKey(published.coverUrl ?? ""),
    );
    await flushWaitUntilForTest();
    const channels = channelsPublishedTo(context.mocks, CHANGED);
    expect(channels).toContain(`user:${owner.userId}`);
    expect(channels).not.toContain(`org:${owner.orgId ?? ""}`);

    const list = await accept(api.list({ headers: signIn(owner) }), [200]);
    expect(list.body[0]).toMatchObject(renamed.body);
  });

  it("user-template-publish-003 retracts a shared template and its previews from a colleague", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const colleague = colleagueOf(owner);
    const published = await publishDeck(owner, fixture);
    const params = { templateId: published.id };
    const api = templatesApi();
    await shareWithOrganization(owner, published.id);

    const sharedList = await accept(
      api.list({ headers: signIn(colleague) }),
      [200],
    );
    const previewAssetIds = (sharedList.body[0]?.previewAssets ?? []).map(
      (asset) => {
        return asset.previewAssetId;
      },
    );
    expect(previewAssetIds).toHaveLength(2);

    forgetRealtime();
    await accept(
      api.update({
        headers: signIn(owner),
        params,
        body: { title: "Shared edit" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, CHANGED)).toContain(
      `org:${owner.orgId ?? ""}`,
    );

    forgetRealtime();
    const retracted = await accept(
      api.update({
        headers: signIn(owner),
        params,
        body: { visibility: "private" },
      }),
      [200],
    );
    expect(retracted.body).toMatchObject({
      title: "Shared edit",
      visibility: "private",
    });
    await flushWaitUntilForTest();
    const channels = channelsPublishedTo(context.mocks, CHANGED);
    expect(channels).toContain(`org:${owner.orgId ?? ""}`);
    expect(channels).not.toContain(`user:${owner.userId}`);

    const colleagueHeaders = signIn(colleague);
    await expect(
      api.list({ headers: colleagueHeaders }),
    ).resolves.toMatchObject({ status: 200, body: [] });
    await accept(api.get({ headers: colleagueHeaders, params }), [404]);
    await expect(
      api.resolvePreviewUrls({
        headers: colleagueHeaders,
        body: { previewAssetIds },
      }),
    ).resolves.toMatchObject({ status: 200, body: { assets: [] } });
  });

  it("user-template-publish-004 refuses an edit from another workspace and leaves the template unchanged", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const outsider = bdd.user();
    const published = await publishDeck(owner, fixture);
    const params = { templateId: published.id };
    const api = templatesApi();

    const refused = await accept(
      api.update({
        headers: signIn(outsider),
        params,
        body: { title: "Cross-organization edit" },
      }),
      [404],
    );
    expect(refused.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: `User template not found: ${published.id}`,
    });

    const detail = await accept(
      api.get({ headers: signIn(owner), params }),
      [200],
    );
    expect(detail.body).toMatchObject(published);
  });

  it("user-template-publish-008 covers a document with its first page without counting pages", async () => {
    const fixture = installS3Fixture(context);
    const admin = bdd.user();
    const sourceFileId = await upload(
      admin,
      fixture,
      "brand-report.docx",
      DOCX,
      Buffer.from("docx-bytes"),
    );
    const packageFileId = await upload(
      admin,
      fixture,
      "package.tar.gz",
      GZIP,
      tarGz([{ path: "SKILL.md", content: "# Brand report" }]),
    );
    const coverFileId = await upload(
      admin,
      fixture,
      "cover.png",
      PNG,
      Buffer.from("cover-png"),
    );
    const api = templatesApi();

    const published = await accept(
      api.publish({
        headers: signIn(admin),
        body: {
          kind: "document",
          title: "Brand report",
          sourceFileId,
          packageFileId,
          coverFileId,
          pageCount: 12,
        },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      kind: "document",
      coverHasMorePages: true,
      pageCount: null,
    });
    expect(published.body.coverUrl).not.toBeNull();

    const detail = await accept(
      api.get({
        headers: signIn(admin),
        params: { templateId: published.body.id },
      }),
      [200],
    );
    expect(detail.body.pageUrls).toStrictEqual([]);
    expect(detail.body.previewAssets).toHaveLength(1);
  });

  it("user-template-publish-012 covers an illustration with its approved examples rather than its source", async () => {
    const fixture = installS3Fixture(context);
    const admin = bdd.user();
    const reference = Buffer.from("reference-png");
    const agenda = Buffer.from("agenda-png");
    const approval = Buffer.from("approval-png");
    const sourceFileId = await upload(
      admin,
      fixture,
      "reference.png",
      PNG,
      reference,
    );
    const exampleFileIds = [
      await upload(admin, fixture, "ref-agenda.png", PNG, agenda),
      await upload(admin, fixture, "ref-approval.png", PNG, approval),
    ];
    const packageFileId = await upload(
      admin,
      fixture,
      "package.tar.gz",
      GZIP,
      tarGz([
        { path: "SKILL.md", content: "# Ink style" },
        { path: "examples/agenda.png", content: agenda },
      ]),
    );
    const api = templatesApi();

    const published = await accept(
      api.publish({
        headers: signIn(admin),
        body: {
          kind: "illustration",
          title: "Ink style",
          sourceFileId,
          packageFileId,
          exampleFileIds,
        },
      }),
      [200],
    );
    expect(
      fixture.readSignedObject(published.body.coverUrl ?? ""),
    ).toStrictEqual(agenda);

    const headers = signIn(admin);
    const list = await accept(api.list({ headers }), [200]);
    const previewAssets = list.body[0]?.previewAssets ?? [];
    expect(
      previewAssets.map((asset) => {
        return fixture.readSignedObject(asset.url);
      }),
    ).toStrictEqual([agenda, approval]);
    const resolved = await accept(
      api.resolvePreviewUrls({
        headers,
        body: {
          previewAssetIds: previewAssets.map((asset) => {
            return asset.previewAssetId;
          }),
        },
      }),
      [200],
    );
    expect(resolved.body.assets).toHaveLength(2);

    const detail = await accept(
      api.get({ headers, params: { templateId: published.body.id } }),
      [200],
    );
    expect(detail.body.pageUrls).toStrictEqual([]);
    expect(detail.body.previewAssets).toHaveLength(2);
    expect(fixture.readSignedObject(detail.body.sourceUrl)).toStrictEqual(
      reference,
    );
  });

  it("user-template-publish-016 replaces a template's package and leaves everything else as published", async () => {
    const fixture = installS3Fixture(context);
    const admin = bdd.user();
    const published = await publishDeck(admin, fixture);
    const packageFileId = await upload(
      admin,
      fixture,
      "package.tar.gz",
      GZIP,
      tarGz([
        { path: "SKILL.md", content: "# Brand system, revised" },
        { path: "design-system.md", content: "Use the revised palette." },
      ]),
    );

    const replaced = await accept(
      templatesApi().replacePackage({
        headers: signIn(admin),
        params: { templateId: published.id },
        body: { packageFileId },
      }),
      [200],
    );

    expect(replaced.body).toMatchObject({
      id: published.id,
      title: published.title,
      kind: published.kind,
      sourceFilename: published.sourceFilename,
      pageCount: published.pageCount,
      visibility: published.visibility,
    });
  });

  it("user-template-publish-022 rejects a deck package that is missing its design-system guidance", async () => {
    const fixture = installS3Fixture(context);
    const admin = bdd.user();
    const inputs = await uploadDeck(admin, fixture, [
      { path: "SKILL.md", content: "# Brand system" },
    ]);

    const refused = await accept(
      templatesApi().publish({
        headers: signIn(admin),
        body: { ...inputs, title: "Brand system" },
      }),
      [400],
    );

    expect(refused.body.error.message).toContain("design-system.md");
  });

  it("user-template-publish-023 keeps a private template out of a colleague's catalog", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const colleague = colleagueOf(owner);
    const published = await publishDeck(owner, fixture);
    const api = templatesApi();

    const headers = signIn(colleague);
    await expect(api.list({ headers })).resolves.toMatchObject({
      status: 200,
      body: [],
    });
    await accept(
      api.get({ headers, params: { templateId: published.id } }),
      [404],
    );
  });

  it("user-template-publish-024 shows an organization template to a colleague who cannot manage it", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const colleague = colleagueOf(owner);
    const published = await publishDeck(owner, fixture);
    await shareWithOrganization(owner, published.id);
    const params = { templateId: published.id };
    const api = templatesApi();

    const headers = signIn(colleague);
    const list = await accept(api.list({ headers }), [200]);
    expect(list.body).toMatchObject([
      {
        id: published.id,
        visibility: "organization",
        ownerUserId: owner.userId,
        canManage: false,
      },
    ]);
    await accept(
      api.update({
        headers,
        params,
        body: { title: "Renamed by a colleague" },
      }),
      [404],
    );
    await accept(api.delete({ headers, params }), [404]);
  });

  it("user-template-publish-025 names a colleague's template after its owner rather than the account id", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const colleague = colleagueOf(owner);
    userDirectory([
      { user: owner, firstName: "Mina", lastName: "Okafor" },
      { user: colleague, firstName: "Sam", lastName: "Reader" },
    ]);
    const published = await publishDeck(owner, fixture);
    await shareWithOrganization(owner, published.id);
    const api = templatesApi();

    const headers = signIn(colleague);
    const list = await accept(api.list({ headers }), [200]);
    expect(list.body).toMatchObject([
      { ownerUserId: owner.userId, ownerDisplayName: "Mina Okafor" },
    ]);
    const detail = await accept(
      api.get({ headers, params: { templateId: published.id } }),
      [200],
    );
    expect(detail.body.ownerDisplayName).toBe("Mina Okafor");
  });
});
