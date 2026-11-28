import { createHash, randomUUID } from "node:crypto";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

function file(path: string, content: string, contentType: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType,
  };
}

function html(content: string) {
  return file("/index.html", content, "text/html; charset=utf-8");
}

function css(path: string, content: string) {
  return file(path, content, "text/css; charset=utf-8");
}

function deployment(site: string, files: ReturnType<typeof file>[]) {
  return {
    site,
    title: "Hosted page",
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files,
  };
}

async function proOwner() {
  const owner = bdd.user();
  await publicPlanLifecycle(context, owner, "pro").update("active");
  return owner;
}

test("hosted-upload-immutability-003 rejects an asset whose name does not carry its content hash", async () => {
  host.captureHostedSitesS3();
  const owner = await proOwner();

  const rejected = await host.requestPrepareHostedSite(
    owner,
    deployment(`site-${randomUUID().slice(0, 8)}`, [
      html("<link rel=stylesheet href=/assets/app.css>"),
      css("/assets/app.css", "body{color:red}"),
    ]),
    [400],
  );

  expect("error" in rejected.body && rejected.body.error.message).toContain(
    "Hosted-site asset must carry a content hash in its file name: /assets/app.css",
  );
});

test("hosted-upload-immutability-004 preserves asset hashes across retained deployments even when a later deployment omits the asset", async () => {
  host.captureHostedSitesS3();
  const owner = await proOwner();
  const site = `site-${randomUUID().slice(0, 8)}`;
  const firstAsset = css("/assets/app-4f3a9c12.css", "body{color:red}");
  const secondAsset = css("/assets/app-8b6e1d42.css", "body{color:blue}");

  const first = await host.prepareHostedSite(
    owner,
    deployment(site, [html("<p>v1</p>"), firstAsset]),
  );
  await host.completeHostedSite(owner, first.deploymentId);
  const second = await host.prepareHostedSite(
    owner,
    deployment(site, [html("<p>v2</p>"), secondAsset]),
  );
  await host.completeHostedSite(owner, second.deploymentId);

  const changed = await host.requestPrepareHostedSite(
    owner,
    deployment(site, [
      html("<p>v3</p>"),
      css("/assets/app-4f3a9c12.css", "body{color:green}"),
    ]),
    [409],
  );
  const unchanged = await host.prepareHostedSite(
    owner,
    deployment(site, [html("<p>v4</p>"), firstAsset, secondAsset]),
  );

  expect(second.siteId).toBe(first.siteId);
  expect(second.deploymentVersion).toBe(2);
  expect("error" in changed.body && changed.body.error.message).toContain(
    "Hosted-site asset changed without a new file name: /assets/app-4f3a9c12.css",
  );
  expect(unchanged.siteId).toBe(first.siteId);
  expect(unchanged.publicSlug).toBe(first.publicSlug);
  expect(unchanged.deploymentVersion).toBe(3);
});
