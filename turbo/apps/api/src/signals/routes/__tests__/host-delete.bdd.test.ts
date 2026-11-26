import { createHash, randomUUID } from "node:crypto";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

function html(content: string) {
  return {
    path: "/index.html",
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

function deployment(site: string, content: string) {
  return {
    site,
    title: "Hosted page",
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [html(content)],
  };
}

async function proMember(options: Parameters<typeof bdd.user>[0] = {}) {
  const member = bdd.user(options);
  await publicPlanLifecycle(context, member, "pro").update("active");
  return member;
}

async function publish(owner: ApiTestUser, site: string, content: string) {
  const prepared = await host.prepareHostedSite(
    owner,
    deployment(site, content),
  );
  const completed = await host.completeHostedSite(owner, prepared.deploymentId);
  return { prepared, completed };
}

describe("FILE-01: hosted-site deletion through host APIs", () => {
  it("host-delete.bdd-002 (1/2) denies workspace admin deletion and preserves files", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = await proMember();
    const site = `site-${randomUUID().slice(0, 8)}`;
    const { prepared } = await publish(owner, site, "<p>v1</p>");
    const admin = bdd.user({ orgId: owner.orgId, orgRole: "org:admin" });

    const denied = await host.requestDeleteHostedSite(
      admin,
      prepared.publicSlug,
      [404],
    );
    const files = await host.readHostedSiteFiles(owner, prepared.publicSlug);

    expect(denied.body).toMatchObject({
      error: { message: "Hosted site not found" },
    });
    expect(storage.deletes).toStrictEqual([]);
    expect(files.deploymentId).toBe(prepared.deploymentId);
  });

  it("host-delete.bdd-002 (2/2) denies unauthenticated deletion and preserves files", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = await proMember();
    const site = `site-${randomUUID().slice(0, 8)}`;
    const { prepared } = await publish(owner, site, "<p>v1</p>");

    await host.requestDeleteHostedSite(null, prepared.publicSlug, [401]);
    const files = await host.readHostedSiteFiles(owner, prepared.publicSlug);

    expect(storage.deletes).toStrictEqual([]);
    expect(files.deploymentId).toBe(prepared.deploymentId);
  });
});
