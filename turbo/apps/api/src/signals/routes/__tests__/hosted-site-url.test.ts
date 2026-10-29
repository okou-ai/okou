import { randomUUID } from "node:crypto";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function client(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  return setupAppWithRoutes({
    context,
    routes: hostRoutes,
    baseUrl: "https://api.okou.ai",
  })(hostContract);
}
async function publish() {
  const owner = createBddApi(context).user();
  const api = createHostBddApi(context);
  api.captureHostedSitesS3();
  const name = `url-${randomUUID().slice(0, 8)}`;
  const prepared = await api.prepareHostedSite(owner, {
    site: name,
    artifactKind: "hosted-site",
    spaFallback: false,
    visibility: "public",
    files: [hostedTextFile("/index.html", "<p>one</p>")],
  });
  await api.completeHostedSite(owner, prepared.deploymentId);
  return { owner, api, name, prepared };
}

test("renames only the active address while immutable versions and the CLI site identity survive", async () => {
  const { owner, api, name, prepared } = await publish();
  const http = client(owner);
  const next = `${name}-new`;
  const response = await accept(
    http.updateSiteUrl({
      headers,
      params: { siteId: prepared.siteId },
      body: { publicSlug: next, expectedPublicSlug: name },
    }),
    [200],
  );
  expect(response.body).toMatchObject({
    siteId: prepared.siteId,
    publicSlug: next,
    url: `https://${next}.okou.app`,
    isActive: true,
  });
  const read = await accept(
    http.siteUrl({
      headers,
      params: { publicSlug: `dpl-${prepared.deploymentId}` },
      query: { hostname: `dpl-${prepared.deploymentId}.okou.app` },
    }),
    [200],
  );
  expect(read.body).toStrictEqual(response.body);
  const alias = await accept(
    http.resolveAlias({
      params: { publicSlug: next },
      query: { publicBrand: "okou" },
    }),
    [200],
  );
  expect(alias.body.pointer).toMatchObject({
    siteId: prepared.siteId,
    deploymentId: prepared.deploymentId,
    publicSlug: name,
  });
  const old = await accept(
    http.resolveAlias({
      params: { publicSlug: name },
      query: { publicBrand: "okou" },
    }),
    [200],
  );
  expect(old.body.pointer).toBeNull();
  const pointer = alias.body.pointer!;
  const authorization = {
    publicSlug: pointer.publicSlug,
    publicBrand: "okou" as const,
    prefix: pointer.prefix,
    manifestKey: pointer.manifestKey,
  };
  for (const [address, allowed] of [
    [next, true],
    [name, false],
    [`dpl-${prepared.deploymentId}`, true],
  ] as const) {
    const result = await accept(
      http.deliveryAuthorization({
        params: {
          siteId: prepared.siteId,
          deploymentId: prepared.deploymentId,
        },
        query: { ...authorization, alias: address },
      }),
      [200],
    );
    expect(result.body.allowed).toBe(allowed);
  }
  const upload = await api.prepareHostedSite(owner, {
    site: name,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>two</p>")],
  });
  expect(upload.siteId).toBe(prepared.siteId);
  expect(upload.publicSlug).toBe(next);
  const completed = await api.completeHostedSite(owner, upload.deploymentId);
  expect(completed.url).toBe(`https://${next}.okou.app`);
  await accept(
    http.updateSiteUrl({
      headers,
      params: { siteId: prepared.siteId },
      body: { publicSlug: name, expectedPublicSlug: next },
    }),
    [200],
  );
  const restored = await accept(
    http.resolveAlias({
      params: { publicSlug: name },
      query: { publicBrand: "okou" },
    }),
    [200],
  );
  expect(restored.body.pointer?.deploymentId).toBe(upload.deploymentId);
});

test("validates addresses and hides other owners' websites", async () => {
  const { owner, prepared, name } = await publish();
  const rename = {
    headers,
    params: { siteId: prepared.siteId },
    body: { publicSlug: `${name}-new`, expectedPublicSlug: name },
  };
  for (const publicSlug of ["dpl-reserved", "pv-private"]) {
    await accept(
      client(owner).updateSiteUrl({
        ...rename,
        body: { ...rename.body, publicSlug },
      }),
      [400],
    );
  }
  const peer = createBddApi(context).user({ orgId: owner.orgId });
  await accept(client(peer).updateSiteUrl(rename), [404]);
  await accept(
    client(peer).siteUrlAvailability({
      headers,
      params: { siteId: prepared.siteId },
      query: { publicSlug: `${name}-new` },
    }),
    [404],
  );
  await accept(
    client(peer).siteUrl({
      headers,
      params: { publicSlug: name },
      query: { hostname: `${name}.okou.app` },
    }),
    [404],
  );
});

test("rejects stale edits and reserves previous published names for their owner", async () => {
  const { owner, api, name, prepared } = await publish();
  const http = client(owner);
  await accept(
    http.updateSiteUrl({
      headers,
      params: { siteId: prepared.siteId },
      body: { publicSlug: `${name}-new`, expectedPublicSlug: name },
    }),
    [200],
  );
  await accept(
    http.updateSiteUrl({
      headers,
      params: { siteId: prepared.siteId },
      body: { publicSlug: `${name}-other`, expectedPublicSlug: name },
    }),
    [409],
  );
  const other = createBddApi(context).user();
  const upload = await api.prepareHostedSite(other, {
    site: name,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>other</p>")],
  });
  expect(upload.publicSlug).not.toBe(name);
  await api.completeHostedSite(other, upload.deploymentId);
  const availability = await accept(
    client(other).siteUrlAvailability({
      headers,
      params: { siteId: upload.siteId },
      query: { publicSlug: name },
    }),
    [200],
  );
  expect(availability.body.available).toBeFalsy();
  await accept(
    client(other).updateSiteUrl({
      headers,
      params: { siteId: upload.siteId },
      body: { publicSlug: name, expectedPublicSlug: upload.publicSlug },
    }),
    [409],
  );
});

test("an upload prepared before renaming completes at the new address", async () => {
  const { owner, api, name, prepared } = await publish();
  const pending = await api.prepareHostedSite(owner, {
    site: name,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>next</p>")],
  });
  await accept(
    client(owner).updateSiteUrl({
      headers,
      params: { siteId: prepared.siteId },
      body: { publicSlug: `${name}-new`, expectedPublicSlug: name },
    }),
    [200],
  );
  const result = await api.completeHostedSite(owner, pending.deploymentId);
  expect(result.url).toBe(`https://${name}-new.okou.app`);
  const alias = await accept(
    client(owner).resolveAlias({
      params: { publicSlug: `${name}-new` },
      query: { publicBrand: "okou" },
    }),
    [200],
  );
  expect(alias.body.pointer?.deploymentId).toBe(pending.deploymentId);
});

test("concurrent websites cannot claim the same address", async () => {
  const { owner, api, name, prepared } = await publish();
  const other = await api.prepareHostedSite(owner, {
    site: `${name}-second`,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>second</p>")],
  });
  await api.completeHostedSite(owner, other.deploymentId);
  const http = client(owner);
  const publicSlug = `${name}-claimed`;
  const results = await Promise.all(
    [prepared, other].map((site) => {
      return accept(
        http.updateSiteUrl({
          headers,
          params: { siteId: site.siteId },
          body: { publicSlug, expectedPublicSlug: site.publicSlug },
        }),
        [200, 409],
      );
    }),
  );
  expect(
    results
      .map((result) => {
        return result.status;
      })
      .sort(),
  ).toStrictEqual([200, 409]);
  const live = await accept(
    http.resolveAlias({
      params: { publicSlug },
      query: { publicBrand: "okou" },
    }),
    [200],
  );
  expect(live.body.pointer?.siteId).toBe(
    results.find((result) => {
      return result.status === 200;
    })?.body.siteId,
  );
  await api.deleteHostedSite(owner, publicSlug);
  const deleted = await accept(
    http.resolveAlias({
      params: { publicSlug },
      query: { publicBrand: "okou" },
    }),
    [200],
  );
  expect(deleted.body.pointer).toBeNull();
});
