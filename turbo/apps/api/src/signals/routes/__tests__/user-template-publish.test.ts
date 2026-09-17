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
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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
 * What each reverse skill actually writes.
 *
 * `presentation-reverse-template` produces the visual language as prose;
 * `docx-reverse-template` produces `reference.docx`, which is what pandoc
 * consumes, and writes no `design-system.md` at all. A fixture that gave both
 * kinds the same files would agree with the endpoint and disagree with the
 * packages it has to accept.
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
  }
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

    // A document is its styles, so it has no pages and no cover — null rather
    // than a zero that would read as an empty template.
    expect(response.body).toMatchObject({
      kind: "document",
      sourceFilename: "brand-report.docx",
      pageCount: null,
      coverUrl: null,
    });

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.previewAssets).toStrictEqual([]);
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
});
