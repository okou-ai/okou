import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import {
  insertLegacyHostedSiteFixture,
  insertLegacyHostedSitePublicationFixture,
} from "../../../test-fixtures/hosted-sites";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

/*
FILE-01 hosted-site soft deletion through `DELETE /api/host/sites/:publicSlug`.
Every public address is observed through the hosted-sites R2 boundary the host
Worker reads (site pointer, version pointers, delivery records); the files and
deployments GETs report what the API still serves for the site.
*/

const context = testContext();

function ownedActor(actor: ApiTestUser): {
  readonly userId: string;
  readonly orgId: string;
} {
  if (!actor.orgId) {
    throw new Error("Expected an organization actor");
  }
  return { userId: actor.userId, orgId: actor.orgId };
}

async function setHostedSiteDelete(actor: ApiTestUser, enabled: boolean) {
  await updateFeatureSwitchesForUser(context, ownedActor(actor), {
    [FeatureSwitchKey.HostedSiteDelete]: enabled,
  });
}

async function enableHostedSiteDelete(actor: ApiTestUser) {
  await setHostedSiteDelete(actor, true);
}

function errorMessage(body: unknown): string {
  expectApiError(body);
  return body.error.message;
}

function siteBody(site: string, html: string) {
  return {
    site,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", html)],
  };
}

describe("FILE-01: hosted-site deletion through host APIs", () => {
  it("takes every version offline and restores the address as a new version on redeploy [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    const outsider = bdd.user();
    await enableHostedSiteDelete(actor);
    const capture = api.captureHostedSitesS3();
    const site = `bdd-delete-${randomUUID().slice(0, 8)}`;
    const first = await api.prepareHostedSite(
      actor,
      siteBody(site, "<p>1</p>"),
    );
    await api.completeHostedSite(actor, first.deploymentId);
    const second = await api.prepareHostedSite(
      actor,
      siteBody(site, "<p>2</p>"),
    );
    await api.completeHostedSite(actor, second.deploymentId);
    // An upload in flight when the site is deleted never goes live.
    const pending = await api.prepareHostedSite(
      actor,
      siteBody(site, "<p>pending</p>"),
    );

    const deleted = await api.deleteHostedSite(actor, site);

    expect(deleted).toStrictEqual({
      siteId: first.siteId,
      site,
      publicSlug: site,
      aliasUrl: first.aliasUrl,
      offlineUrls: [first.aliasUrl, second.artifactUrl, first.artifactUrl],
    });
    const offlineKeys = [
      `sites/brands/okou/${site}/active.json`,
      `artifact-delivery/okou/html/${site}.json`,
      ...[first, second, pending].map((deployment) => {
        return `sites/brands/okou/deployments/${deployment.deploymentId}.json`;
      }),
      ...[first, second].map((deployment) => {
        return `artifact-delivery/okou/html/dpl-${deployment.deploymentId}.json`;
      }),
    ];
    expect(capture.deletes).toStrictEqual(expect.arrayContaining(offlineKeys));
    for (const key of offlineKeys) {
      expect(capture.objects.get(key)).toBeUndefined();
    }
    const history = await api.readHostedSiteDeployments(actor, site);
    expect(history.activeDeploymentId).toBeNull();
    expect(
      history.deployments.map((deployment) => {
        return deployment.status;
      }),
    ).toStrictEqual(["deleted", "deleted", "deleted"]);
    const aliasFiles = await api.requestHostedSiteFiles(actor, site, [409]);
    expect(errorMessage(aliasFiles.body)).toBe(
      "Hosted site has no active deployment",
    );
    const versionFiles = await api.requestHostedSiteFiles(
      actor,
      `dpl-${first.deploymentId}`,
      [409],
    );
    expect(errorMessage(versionFiles.body)).toBe(
      "Hosted deployment is deleted",
    );
    await api.requestHostedSiteFiles(
      outsider,
      `dpl-${second.deploymentId}`,
      [404],
    );
    const completion = await api.requestCompleteHostedSite(
      actor,
      pending.deploymentId,
      [409],
    );
    expect(errorMessage(completion.body)).toBe("Hosted deployment is deleted");
    // Repeating the deletion after a partial failure converges.
    await expect(api.deleteHostedSite(actor, site)).resolves.toStrictEqual(
      deleted,
    );

    const restored = await api.prepareHostedSite(
      actor,
      siteBody(site, "<p>restored</p>"),
    );
    await expect(
      api.completeHostedSite(actor, restored.deploymentId),
    ).resolves.toMatchObject({
      siteId: first.siteId,
      url: first.aliasUrl,
      deploymentVersion: 4,
      isActive: true,
    });
    expect(
      capture.objects.get(`sites/brands/okou/${site}/active.json`),
    ).toContain(restored.deploymentId);
    await expect(api.readHostedSiteFiles(actor, site)).resolves.toMatchObject({
      deploymentId: restored.deploymentId,
    });
    await api.requestHostedSiteFiles(actor, `dpl-${first.deploymentId}`, [409]);
    const restoredHistory = await api.readHostedSiteDeployments(actor, site);
    expect(
      restoredHistory.deployments.map((deployment) => {
        return [deployment.deploymentVersion, deployment.status];
      }),
    ).toStrictEqual([
      [4, "ready"],
      [3, "deleted"],
      [2, "deleted"],
      [1, "deleted"],
    ]);
  });

  it("lets only the site owner delete while the switch is enabled [HOST-D]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const owner = bdd.user();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:admin" });
    const capture = api.captureHostedSitesS3();
    const site = `bdd-owned-${randomUUID().slice(0, 8)}`;
    const published = await api.prepareHostedSite(
      owner,
      siteBody(site, "<p>owned</p>"),
    );
    await api.completeHostedSite(owner, published.deploymentId);

    await setHostedSiteDelete(owner, false);
    const disabled = await api.requestDeleteHostedSite(owner, site, [404]);
    expect(errorMessage(disabled.body)).toBe(
      "Hosted site deletion is not available",
    );
    await enableHostedSiteDelete(owner);
    await enableHostedSiteDelete(member);
    for (const [actor, target] of [
      [member, site],
      [owner, `missing-${randomUUID().slice(0, 8)}`],
    ] as const) {
      const rejected = await api.requestDeleteHostedSite(actor, target, [404]);
      expect(errorMessage(rejected.body)).toBe("Hosted site not found");
    }
    await api.requestDeleteHostedSite(null, site, [401]);

    expect(capture.deletes).toStrictEqual([]);
    await expect(api.readHostedSiteFiles(owner, site)).resolves.toMatchObject({
      deploymentId: published.deploymentId,
    });
  });

  it("refuses legacy-layout sites because redeploying cannot restore them [HOST-D]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const owner = bdd.user();
    await enableHostedSiteDelete(owner);
    const capture = api.captureHostedSitesS3();
    const site = `bdd-legacy-${randomUUID().slice(0, 8)}`;
    // Prepare only allocates current-layout sites, so no endpoint can create a
    // legacy-layout site. Seed that historical row: refusing to delete what a
    // redeploy could never restore is the contract under test.
    await insertLegacyHostedSiteFixture({ ...ownedActor(owner), site });

    const rejected = await api.requestDeleteHostedSite(owner, site, [400]);

    expect(errorMessage(rejected.body)).toBe(
      "Hosted sites on the legacy domain cannot be redeployed, so they cannot be deleted",
    );
    expect(capture.deletes).toStrictEqual([]);
  });

  it("revokes a historical private publication's share link [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const owner = bdd.user();
    const { orgId, userId } = ownedActor(owner);
    await enableHostedSiteDelete(owner);
    const capture = api.captureHostedSitesS3();
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: orgId,
      name: "Owner organization",
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId },
            role: "org:admin",
            organization: { id: orgId, name: "Owner organization" },
          },
        ],
        totalCount: 1,
      },
    );
    const site = `bdd-shared-${randomUUID().slice(0, 8)}`;
    // Private HTML publishing is refused (`prepare/private` returns 403), so
    // no endpoint can create a shared private publication. Seed that retained
    // historical identity: its live share link must stop serving on deletion.
    const publication = await insertLegacyHostedSitePublicationFixture({
      orgId,
      userId,
      site,
      layout: "current",
      files: [hostedTextFile("/index.html", "<p>shared</p>")],
    });
    capture.objects.set(
      publication.policyKey,
      JSON.stringify(publication.policy),
    );

    const deleted = await api.deleteHostedSite(owner, site);

    expect(deleted).toMatchObject({ siteId: publication.siteId, site });
    // A private publication never served a public version URL.
    expect(deleted.offlineUrls).toStrictEqual([deleted.aliasUrl]);

    const policy = z
      .object({ status: z.string(), publicToken: z.string().nullable() })
      .parse(JSON.parse(capture.objects.get(publication.policyKey) ?? "{}"));
    expect(policy).toStrictEqual({ status: "revoked", publicToken: null });
    const history = await api.readHostedSiteDeployments(owner, site);
    expect(history.deployments).toStrictEqual([
      expect.objectContaining({
        deploymentId: publication.deploymentId,
        status: "deleted",
      }),
    ]);
  });
});
