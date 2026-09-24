import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { artifactDeliveryKey } from "@okouai/api-contracts/contracts/artifact-delivery";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { insertLegacyHostedSitePublicationFixture } from "../../../test-fixtures/hosted-sites";
import { artifactShareRoutes } from "../artifact-shares";
import { createBddApi } from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";

const context = testContext();

/** Historical snapshots cannot be created by the current public-only API. */
async function historicalSite() {
  const bdd = createBddApi(context);
  const api = createHostMapsBddApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a site organization");
  }
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          publicUserData: { userId: actor.userId },
          role: "org:member",
          organization: { id: actor.orgId, name: "Historical sites" },
        },
      ],
      totalCount: 1,
    },
  );
  const site = `historical-${randomUUID().slice(0, 8)}`;
  const files = [
    hostedTextFile("/index.html", "<main>original snapshot</main>"),
  ];
  const legacy = await insertLegacyHostedSitePublicationFixture({
    orgId: actor.orgId,
    userId: actor.userId,
    site,
    files,
  });
  const capture = api.captureHostedSitesS3();
  const storage = context.mocks.s3.send.getMockImplementation()!;
  const objects = new Map<string, Buffer>();
  const aliasKey = artifactDeliveryKey("okou", "html", site);
  const pointerKey = `sites/brands/okou/${site}/active.json`;
  const publication = {
    version: 1,
    kind: "publication",
    publicBrand: "okou",
    shareId: legacy.shareId,
    publicToken: legacy.publicToken,
    targetKind: "html",
  };
  function seed(key: string, value: unknown) {
    objects.set(key, Buffer.from(JSON.stringify(value)));
  }
  seed(aliasKey, publication);
  seed(artifactDeliveryKey("okou", "html", legacy.publicToken), publication);
  seed(legacy.policyKey, legacy.policy);
  let failure: { key: string; afterWrite: boolean } | undefined;
  let replacement: unknown;
  context.mocks.s3.send.mockImplementation(async (operation) => {
    if (
      !(
        operation instanceof GetObjectCommand ||
        operation instanceof PutObjectCommand
      )
    ) {
      return await storage(operation);
    }
    const key = operation.input.Key ?? "";
    const body = objects.get(key);
    const etag = body
      ? `"${createHash("sha256").update(body).digest("hex")}"`
      : null;
    if (operation instanceof GetObjectCommand) {
      return body
        ? {
            Body: Readable.from([body]),
            ETag: etag,
            ContentLength: body.length,
          }
        : await storage(operation);
    }
    if (
      (operation.input.IfNoneMatch === "*" && body) ||
      (operation.input.IfMatch && operation.input.IfMatch !== etag)
    ) {
      throw Object.assign(new Error("Storage revision changed"), {
        name: "PreconditionFailed",
      });
    }
    const fail = failure?.key === key ? failure : undefined;
    if (fail) {
      failure = undefined;
      if (!fail.afterWrite) {
        throw new Error("Interrupted storage write");
      }
    }
    const value = operation.input.Body;
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
      throw new Error("Expected hosted JSON bytes");
    }
    objects.set(key, Buffer.from(value));
    if (key === pointerKey && replacement !== undefined) {
      seed(aliasKey, replacement);
      replacement = undefined;
    }
    if (fail) {
      throw new Error("Storage acknowledged the write before connection loss");
    }
    return await storage(operation);
  });
  return {
    api,
    actor,
    site,
    files,
    legacy,
    aliasKey,
    pointerKey,
    capture,
    seed,
    failOnce(key: string, afterWrite = false) {
      failure = { key, afterWrite };
    },
    raceAlias(record: unknown) {
      replacement = record;
    },
    async prepare(content: string) {
      return await api.prepareHostedSite(actor, {
        site,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [hostedTextFile("/index.html", content)],
      });
    },
  };
}

describe("historical hosted publications", () => {
  it("moves an owned named snapshot to the newest deployment and retains its token", async () => {
    const fixture = await historicalSite();
    const { api, actor, legacy, site } = fixture;
    const next = await fixture.prepare("<main>new version</main>");
    expect(next.siteId).toBe(legacy.siteId);
    expect(next.deploymentVersion).toBe(2);
    const complete = await api.completeHostedSite(actor, next.deploymentId);
    expect(complete).toMatchObject({
      isActive: true,
      activeDeploymentVersion: 2,
    });
    await expect(
      api.completeHostedSite(actor, next.deploymentId),
    ).resolves.toStrictEqual(complete);
    await expect(api.readHostedSiteFiles(actor, site)).resolves.toMatchObject({
      deploymentId: next.deploymentId,
    });
    const status = await accept(
      setupApp({ context, routes: artifactShareRoutes })(
        artifactSharesContract,
      ).status({
        headers: { authorization: "Bearer clerk-session" },
        body: { kind: "html", id: legacy.deploymentId },
      }),
      [200],
    );
    expect(new URL(status.body.url!).hostname.split(".")[0]).toBe(
      legacy.publicToken,
    );
    expect(status.body.selectedTarget).toStrictEqual({
      kind: "html",
      id: legacy.deploymentId,
    });
    const newest = await fixture.prepare("<main>newest version</main>");
    await api.completeHostedSite(actor, newest.deploymentId);
    await expect(
      api.completeHostedSite(actor, next.deploymentId),
    ).resolves.toMatchObject({ isActive: false, activeDeploymentVersion: 3 });
    await expect(
      api.readHostedSiteFiles(actor, `dpl-${next.deploymentId}`),
    ).resolves.toMatchObject({ deploymentId: next.deploymentId });
    await expect(api.readHostedSiteFiles(actor, site)).resolves.toMatchObject({
      deploymentId: newest.deploymentId,
    });
  });

  it.each(["pointer", "alias"])(
    "resumes after an interrupted %s write without a broken site link",
    async (step) => {
      const fixture = await historicalSite();
      const next = await fixture.prepare("<main>retry</main>");
      fixture.failOnce(
        step === "pointer" ? fixture.pointerKey : fixture.aliasKey,
      );
      await fixture.api.requestCompleteHostedSite(
        fixture.actor,
        next.deploymentId,
        [500],
      );
      await expect(
        fixture.api.completeHostedSite(fixture.actor, next.deploymentId),
      ).resolves.toMatchObject({ isActive: true, status: "ready" });
      await expect(
        fixture.api.readHostedSiteFiles(fixture.actor, fixture.site),
      ).resolves.toMatchObject({ deploymentId: next.deploymentId });
    },
  );

  it("does not let an older retry replace a newer pointer after the newer DB transaction rolled back", async () => {
    const fixture = await historicalSite();
    const older = await fixture.prepare("<main>older</main>");
    const newer = await fixture.prepare("<main>newer</main>");
    fixture.failOnce(fixture.aliasKey, true);
    await fixture.api.requestCompleteHostedSite(
      fixture.actor,
      newer.deploymentId,
      [500],
    );
    await expect(
      fixture.api.completeHostedSite(fixture.actor, older.deploymentId),
    ).resolves.toMatchObject({ isActive: false, activeDeploymentVersion: 3 });
    await expect(
      fixture.api.readHostedSiteFiles(fixture.actor, fixture.site),
    ).resolves.toMatchObject({ deploymentId: newer.deploymentId });
    await expect(
      fixture.api.completeHostedSite(fixture.actor, newer.deploymentId),
    ).resolves.toMatchObject({ isActive: true, activeDeploymentVersion: 3 });
  });

  it.each(["owner", "site"])(
    "rejects a %s mismatch and reports a failed deployment instead of leaving it uploading",
    async (mismatch) => {
      const fixture = await historicalSite();
      const next = await fixture.prepare("<main>conflict</main>");
      const policy = fixture.legacy.policy;
      fixture.seed(fixture.legacy.policyKey, {
        ...policy,
        ...(mismatch === "owner" ? { ownerId: `other-${randomUUID()}` } : {}),
        ...(mismatch === "site" ? { publicSlug: `other-${randomUUID()}` } : {}),
      });
      await fixture.api.requestCompleteHostedSite(
        fixture.actor,
        next.deploymentId,
        [409],
      );
      const history = await fixture.api.readHostedSiteDeployments(
        fixture.actor,
        fixture.site,
      );
      expect(history.activeDeploymentId).toBeNull();
      expect(history.deployments).toContainEqual(
        expect.objectContaining({
          deploymentId: next.deploymentId,
          status: "failed",
        }),
      );
      expect(
        fixture.capture.puts.some((object) => {
          return object.key === fixture.pointerKey;
        }),
      ).toBeFalsy();
    },
  );

  it("publishes a fresh owned upload without reactivating a revoked snapshot token", async () => {
    const fixture = await historicalSite();
    fixture.seed(fixture.legacy.policyKey, {
      ...fixture.legacy.policy,
      audience: "private",
      status: "revoked",
      publicToken: null,
    });
    const next = await fixture.prepare("<main>new public version</main>");
    await expect(
      fixture.api.completeHostedSite(fixture.actor, next.deploymentId),
    ).resolves.toMatchObject({ isActive: true });
    await expect(
      fixture.api.readHostedSiteFiles(fixture.actor, fixture.site),
    ).resolves.toMatchObject({ deploymentId: next.deploymentId });
    const status = await accept(
      setupApp({ context, routes: artifactShareRoutes })(
        artifactSharesContract,
      ).status({
        headers: { authorization: "Bearer clerk-session" },
        body: { kind: "html", id: fixture.legacy.deploymentId },
      }),
      [200],
    );
    expect(status.body).toMatchObject({ audience: "private", url: null });
  });

  it("refuses completion by another member of the owner's organization", async () => {
    const fixture = await historicalSite();
    const next = await fixture.prepare("<main>owned</main>");
    const member = createBddApi(context).user({ orgId: fixture.actor.orgId });
    await fixture.api.requestCompleteHostedSite(
      member,
      next.deploymentId,
      [404],
    );
    await expect(
      fixture.api.completeHostedSite(fixture.actor, next.deploymentId),
    ).resolves.toMatchObject({ isActive: true });
  });

  it("does not overwrite an alias that changes after ownership validation", async () => {
    const fixture = await historicalSite();
    const next = await fixture.prepare("<main>race</main>");
    fixture.raceAlias({
      version: 1,
      kind: "publication",
      publicBrand: "okou",
      targetKind: "html",
      shareId: randomUUID(),
      publicToken: "0123456789abcdef01234567",
    });
    await fixture.api.requestCompleteHostedSite(
      fixture.actor,
      next.deploymentId,
      [409],
    );
    const history = await fixture.api.readHostedSiteDeployments(
      fixture.actor,
      fixture.site,
    );
    expect(history.activeDeploymentId).toBeNull();
    expect(history.deployments).toContainEqual(
      expect.objectContaining({
        deploymentId: next.deploymentId,
        status: "failed",
      }),
    );
  });
});
