import { randomUUID } from "node:crypto";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import { describe, expect, it } from "vitest";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { presentationTemplatesRoutes } from "../presentation-templates";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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
const CHANGED = "presentationTemplatesChanged";

function templatesApi() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
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

interface DeckInputs {
  readonly sourceFileId: string;
  readonly pageFileIds: string[];
  readonly packageFileId: string;
}

async function uploadDeck(
  actor: ApiTestUser,
  fixture: Fixture,
  options: {
    readonly sourceFilename?: string;
    readonly sourceType?: string;
    readonly packageFiles?: readonly { path: string; content: string }[];
    readonly pageCount?: 1 | 2;
  } = {},
): Promise<DeckInputs> {
  const sourceFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    {
      filename: options.sourceFilename ?? "brand-system.pptx",
      contentType: options.sourceType ?? PPTX,
    },
    Buffer.from("deck"),
  );
  const pageFileIds = [
    await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "page-1.png", contentType: "image/png" },
      Buffer.from("png-1"),
    ),
  ];
  if (options.pageCount !== 1) {
    pageFileIds.push(
      await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "page-2.png", contentType: "image/png" },
        Buffer.from("png-2"),
      ),
    );
  }
  const packageFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "package.tar.gz", contentType: "application/gzip" },
    tarGz(
      options.packageFiles ?? [
        { path: "SKILL.md", content: "# Brand system" },
        { path: "design-system.md", content: "Use the brand palette." },
      ],
    ),
  );
  return { sourceFileId, pageFileIds, packageFileId };
}

async function publish(actor: ApiTestUser, inputs: DeckInputs, title: string) {
  const response = await accept(
    templatesApi().publish({
      headers: signIn(actor),
      body: { ...inputs, title },
    }),
    [200],
  );
  return response.body;
}

describe("presentation template publish", () => {
  it("presentation-template-publish-011 refuses uploads that belong to someone else", async () => {
    const fixture = installS3Fixture(context);
    const uploader = bdd.user();
    const inputs = await uploadDeck(uploader, fixture, { pageCount: 1 });
    const other = bdd.user({ orgId: `org_${randomUUID()}` });

    const refused = await accept(
      templatesApi().publish({
        headers: signIn(other),
        body: { ...inputs, title: "Borrowed deck" },
      }),
      [400],
    );
    expect(refused.body.error.message).toContain("Uploaded file not found");
  });
  it("presentation-template-publish-008 refuses a package without its design-system guidance", async () => {
    const fixture = installS3Fixture(context);
    const member = bdd.user();
    const inputs = await uploadDeck(member, fixture, {
      packageFiles: [{ path: "SKILL.md", content: "# Brand system" }],
    });
    const api = templatesApi();

    const refused = await accept(
      api.publish({
        headers: signIn(member),
        body: { ...inputs, title: "Brand system" },
      }),
      [400],
    );
    expect(refused.body.error.message).toContain("design-system.md");
    await expect(api.list({ headers: signIn(member) })).resolves.toMatchObject({
      status: 200,
      body: [],
    });
  });

  it("presentation-template-publish-003 publishes a legacy PowerPoint source as uploaded", async () => {
    const fixture = installS3Fixture(context);
    const member = bdd.user();
    const inputs = await uploadDeck(member, fixture, {
      sourceFilename: "legacy-deck.ppt",
      sourceType: "application/vnd.ms-powerpoint",
    });

    await expect(
      publish(member, inputs, "Legacy brand system"),
    ).resolves.toMatchObject({
      title: "Legacy brand system",
      sourceFilename: "legacy-deck.ppt",
      pageCount: 2,
    });
  });

  it("presentation-template-publish-001 publishes an analysed deck as a ready template with reusable previews", async () => {
    const fixture = installS3Fixture(context);
    const member = bdd.user();
    const inputs = await uploadDeck(member, fixture);
    const published = await publish(member, inputs, "Brand system");
    expect(published).toMatchObject({
      title: "Brand system",
      sourceFilename: "brand-system.pptx",
      pageCount: 2,
    });
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, CHANGED)).toContain(
      `user:${member.userId}`,
    );

    const api = templatesApi();
    const headers = signIn(member);
    const list = await accept(api.list({ headers }), [200]);
    const detail = await accept(
      api.get({ headers, params: { templateId: published.id } }),
      [200],
    );
    expect(list.body).toHaveLength(1);
    const [entry] = list.body;
    expect(
      entry?.previewAssets.map((asset) => {
        return asset.url;
      }),
    ).toStrictEqual(detail.body.pageUrls);
    expect(detail.body.pageUrls).toHaveLength(2);
    expect(entry?.coverUrl).toBe(detail.body.pageUrls[0]);

    const previewAssetIds = (entry?.previewAssets ?? []).map((asset) => {
      return asset.previewAssetId;
    });
    const first = await accept(
      api.resolvePreviewUrls({ headers, body: { previewAssetIds } }),
      [200],
    );
    const repeat = await accept(
      api.resolvePreviewUrls({ headers, body: { previewAssetIds } }),
      [200],
    );
    expect(repeat.body).toStrictEqual(first.body);

    mockNow(
      Math.max(
        ...first.body.assets.map((asset) => {
          return Date.parse(asset.expiresAt);
        }),
      ),
    );
    const renewed = await accept(
      api.resolvePreviewUrls({ headers, body: { previewAssetIds } }),
      [200],
    );
    expect(
      renewed.body.assets.map((asset) => {
        return asset.previewAssetId;
      }),
    ).toStrictEqual(previewAssetIds);
    for (const [index, asset] of renewed.body.assets.entries()) {
      const previous = first.body.assets[index];
      expect(asset.url).not.toBe(previous?.url);
      expect(Date.parse(asset.expiresAt)).toBeGreaterThan(
        Date.parse(previous?.expiresAt ?? ""),
      );
    }
    await expect(
      api.resolvePreviewUrls({ headers, body: { previewAssetIds } }),
    ).resolves.toMatchObject({ status: 200, body: renewed.body });
    expect(
      fixture.keys().filter((key) => {
        return /bundles\/v1\/[a-f0-9]{64}\.tar\.gz$/u.test(key);
      }),
    ).toHaveLength(1);
  });

  it("presentation-template-publish-004 shares a public template with the workspace while only the owner manages it", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const published = await publish(
      owner,
      await uploadDeck(owner, fixture),
      "Brand system",
    );
    expect(published).toMatchObject({ visibility: "private", canManage: true });
    const api = templatesApi();
    const params = { templateId: published.id };

    const shared = await accept(
      api.update({
        headers: signIn(owner),
        params,
        body: { visibility: "public" },
      }),
      [200],
    );
    expect(shared.body.visibility).toBe("public");
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, CHANGED)).toContain(
      `org:${owner.orgId ?? ""}`,
    );
    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("Ably unavailable"),
    );
    await accept(
      api.update({
        headers: signIn(owner),
        params,
        body: { title: "Shared brand system" },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    const memberHeaders = signIn(member);
    const list = await accept(api.list({ headers: memberHeaders }), [200]);
    expect(list.body).toMatchObject([
      {
        id: published.id,
        title: "Shared brand system",
        canManage: false,
      },
    ]);
    const detail = await accept(
      api.get({ headers: memberHeaders, params }),
      [200],
    );
    expect(detail.body.pageUrls).toHaveLength(2);
    const previewAssetIds = detail.body.previewAssets.map((asset) => {
      return asset.previewAssetId;
    });
    expect(
      previewAssetIds.every((id) => {
        return id.startsWith("ptp:");
      }),
    ).toBeTruthy();
    const resolved = await accept(
      api.resolvePreviewUrls({
        headers: memberHeaders,
        body: { previewAssetIds },
      }),
      [200],
    );
    expect(resolved.body.assets).toHaveLength(2);
    await accept(
      api.update({
        headers: memberHeaders,
        params,
        body: { title: "Taken over" },
      }),
      [404],
    );
    await accept(api.delete({ headers: memberHeaders, params }), [404]);

    await accept(
      api.update({
        headers: signIn(owner),
        params,
        body: { visibility: "private" },
      }),
      [200],
    );
    const retractedHeaders = signIn(member);
    await expect(
      api.list({ headers: retractedHeaders }),
    ).resolves.toMatchObject({ status: 200, body: [] });
    await accept(api.get({ headers: retractedHeaders, params }), [404]);
    await expect(
      api.resolvePreviewUrls({
        headers: retractedHeaders,
        body: { previewAssetIds },
      }),
    ).resolves.toMatchObject({ status: 200, body: { assets: [] } });
  });

  it("presentation-template-publish-005 renames a private template for its owner and hides it from another workspace", async () => {
    const fixture = installS3Fixture(context);
    const owner = bdd.user();
    const published = await publish(
      owner,
      await uploadDeck(owner, fixture),
      "Brand system",
    );
    const api = templatesApi();
    const params = { templateId: published.id };
    mockNow(Date.parse(published.updatedAt) + 60_000);
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();

    const renamed = await accept(
      api.update({
        headers: signIn(owner),
        params,
        body: { title: "  Renamed private brand  " },
      }),
      [200],
    );
    expect(renamed.body).toStrictEqual({
      ...published,
      title: "Renamed private brand",
      updatedAt: renamed.body.updatedAt,
    });
    expect(Date.parse(renamed.body.updatedAt)).toBeGreaterThan(
      Date.parse(published.updatedAt),
    );
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, CHANGED)).toStrictEqual([
      `user:${owner.userId}`,
    ]);

    const elsewhere = bdd.user({ userId: owner.userId });
    const foreign = await accept(
      api.update({
        headers: signIn(elsewhere),
        params,
        body: { title: "Moved", visibility: "public" },
      }),
      [404],
    );
    expect(foreign.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: `Presentation template not found: ${published.id}`,
    });
    const detail = await accept(
      api.get({ headers: signIn(owner), params }),
      [200],
    );
    expect(detail.body).toMatchObject({
      title: "Renamed private brand",
      visibility: "private",
      updatedAt: renamed.body.updatedAt,
    });
  });
});
