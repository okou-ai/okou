import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);
function hostedFile(path: string, content: string, contentType: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType,
  };
}

function htmlFile(content: string) {
  return hostedFile("/index.html", content, "text/html; charset=utf-8");
}

function siteName(): string {
  return `site-${randomUUID().slice(0, 8)}`;
}

describe("hosted-site deployments through host APIs", () => {
  it("host.bdd-002 refuses completion by another member of the owner's workspace", async () => {
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const prepared = await host.prepareHostedSite(owner, {
      site: siteName(),
      title: "Team page",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>Team</h1>")],
    });

    await host.requestCompleteHostedSite(peer, prepared.deploymentId, [404]);
    const completed = await host.completeHostedSite(
      owner,
      prepared.deploymentId,
    );

    expect(completed).toMatchObject({ isActive: true });
  });

  it("host.bdd-004 redeploys a site while old publication URLs and completion retries stay stable", async () => {
    mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou-public-sites.test");
    mockEnv("OKOU_HOST_SCHEME", "http");
    host.captureHostedSitesS3();
    const member = bdd.user();
    const site = siteName();
    const firstFile = htmlFile("<h1>First</h1>");
    const secondFile = htmlFile("<h1>Second</h1>");

    const first = await host.prepareHostedSite(member, {
      site,
      title: "Launch page",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [firstFile],
    });
    const siteUrl = `http://${first.publicSlug}.okou-public-sites.test`;
    expect(first).toMatchObject({
      url: siteUrl,
      aliasUrl: siteUrl,
      deploymentVersion: 1,
      artifactUrl: `http://dpl-${first.deploymentId}.okou-public-sites.test`,
    });
    const firstCompletion = await host.completeHostedSite(
      member,
      first.deploymentId,
    );
    await expect(
      host.completeHostedSite(member, first.deploymentId),
    ).resolves.toStrictEqual(firstCompletion);

    const second = await host.prepareHostedSite(member, {
      site,
      title: "Launch page",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [secondFile],
    });
    expect(second).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
      aliasUrl: siteUrl,
      deploymentVersion: 2,
      artifactUrl: `http://dpl-${second.deploymentId}.okou-public-sites.test`,
    });
    await host.completeHostedSite(member, second.deploymentId);
    await expect(
      host.completeHostedSite(member, first.deploymentId),
    ).resolves.toMatchObject({ isActive: false, activeDeploymentVersion: 2 });

    const history = await host.readHostedSiteDeployments(member, site);
    expect(
      history.deployments.map((deployment) => {
        return {
          deploymentId: deployment.deploymentId,
          deploymentVersion: deployment.deploymentVersion,
          artifactUrl: deployment.artifactUrl,
          isActive: deployment.isActive,
        };
      }),
    ).toStrictEqual([
      {
        deploymentId: second.deploymentId,
        deploymentVersion: 2,
        artifactUrl: second.artifactUrl,
        isActive: true,
      },
      {
        deploymentId: first.deploymentId,
        deploymentVersion: 1,
        artifactUrl: first.artifactUrl,
        isActive: false,
      },
    ]);
  });

  it("host.bdd-007 adds a four-character suffix only when the simple alias is occupied", async () => {
    const storage = host.captureHostedSitesS3();
    const site = siteName();
    const occupant = bdd.user();
    const occupied = await host.prepareHostedSite(occupant, {
      site,
      title: "First claim",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>First</h1>")],
    });
    const member = bdd.user();
    await bdd.completeOnboarding(member);

    const prepared = await host.prepareHostedSite(member, {
      site,
      title: "Second claim",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>Second</h1>")],
    });
    await host.completeHostedSite(member, prepared.deploymentId);

    expect(prepared.publicSlug).toMatch(
      new RegExp(`^${occupied.publicSlug}-[a-z0-9]{4}$`, "u"),
    );
    expect(prepared.deploymentVersion).toBe(1);
    expect(prepared.artifactUrl).toContain(`dpl-${prepared.deploymentId}.`);
    expect(
      storage.puts.filter((put) => {
        return (
          put.key.endsWith("manifest.json") &&
          put.body.includes(prepared.deploymentId)
        );
      }),
    ).not.toHaveLength(0);
  });
});
