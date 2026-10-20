import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockEnv } from "../../../lib/env";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { hostRoutes } from "../host";
import { featureSwitchesRoutes } from "../feature-switches";
import { artifactOgRoutes } from "../artifact-og";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" } as const;

function client(user?: ApiTestUser) {
  if (user) {
    createRouteMocks(context).clerk.session(
      user.userId,
      user.orgId,
      user.orgRole,
    );
  }
  return setupAppWithRoutes({
    context,
    routes: hostRoutes,
    baseUrl: "https://api.okou.ai",
  })(hostContract);
}

async function enable(user: ApiTestUser, value = true) {
  mockEnv("HOSTED_SITE_ACCESS_ENABLED", "true");
  client(user);
  await accept(
    setupAppWithRoutes({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers,
      body: { switches: { [FeatureSwitchKey.HostedSiteVisibility]: value } },
    }),
    [200],
  );
}

test("preparation keeps downloads public and blocks writes even with a user override", async () => {
  const { owner, api, prepared, request } = await publish();
  await enable(owner);
  mockEnv("HOSTED_SITE_ACCESS_ENABLED", "false");
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [403],
  );
  expect(
    (await accept(client().deliveryAuthorization(request), [200])).body.allowed,
  ).toBeTruthy();
  const files = await api.requestHostedSiteFiles(
    owner,
    `dpl-${prepared.deploymentId}`,
    [200],
  );
  if (files.status !== 200) {
    throw new Error("Expected hosted download files");
  }
  expect(files.body.files[0]!.downloadUrl).not.toContain("/.okou/download/");
});

async function publish() {
  const owner = createBddApi(context).user();
  const api = createHostMapsBddApi(context);
  api.captureHostedSitesS3();
  const site = `access-${randomUUID().slice(0, 8)}`;
  const input = {
    site,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>protected report</p>")],
  };
  const prepared = await api.prepareHostedSite(owner, input);
  await api.completeHostedSite(owner, prepared.deploymentId);
  const prefix = `sites/brands/okou/publications/${prepared.deploymentId}`;
  return {
    owner,
    api,
    input,
    prepared,
    request: {
      params: { siteId: prepared.siteId, deploymentId: prepared.deploymentId },
      query: {
        alias: prepared.publicSlug,
        publicSlug: prepared.publicSlug,
        publicBrand: "okou" as const,
        prefix,
        manifestKey: `${prefix}/manifest.json`,
      },
    },
  };
}

test("creation stays public and ignores stale credentials before Clerk is called", async () => {
  const { owner, prepared, request } = await publish();
  await accept(
    client(owner).siteVisibility({
      headers,
      params: { siteId: prepared.siteId },
    }),
    [403],
  );
  await enable(owner);
  const status = await accept(
    client(owner).siteVisibility({
      headers,
      params: { siteId: prepared.siteId },
    }),
    [200],
  );
  expect(status.body).toStrictEqual({
    siteId: prepared.siteId,
    visibility: "public",
    revision: null,
  });
  context.mocks.clerk.authenticateRequest.mockRejectedValue(
    new Error("Clerk unavailable"),
  );
  const response = await accept(
    client().deliveryAuthorization({
      ...request,
      headers: { authorization: "Bearer expired" },
    }),
    [200],
  );
  expect(response.body).toStrictEqual({ allowed: true, decision: "allow" });
});

test("only the owner changes visibility and stale edits cannot overwrite it", async () => {
  const { owner, prepared, request } = await publish();
  const other = createBddApi(context).user();
  await enable(owner);
  await enable(other);
  const params = { siteId: prepared.siteId };
  await accept(
    client(other).updateSiteVisibility({
      headers,
      params,
      body: { visibility: "private", expectedRevision: null },
    }),
    [404],
  );
  const changed = await accept(
    client(owner).updateSiteVisibility({
      headers,
      params,
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  expect(changed.body.visibility).toBe("private");
  expect(changed.body.revision).toStrictEqual(expect.any(String));
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params,
      body: { visibility: "public", expectedRevision: null },
    }),
    [409],
  );
  expect(
    (await accept(client().deliveryAuthorization(request), [200])).body
      .decision,
  ).toBe("authenticate");
  expect(
    (
      await accept(
        client(other).deliveryAuthorization({ ...request, headers }),
        [200],
      )
    ).body.decision,
  ).toBe("deny");
  expect(
    (
      await accept(
        client(owner).deliveryAuthorization({ ...request, headers }),
        [200],
      )
    ).body.decision,
  ).toBe("allow");
  const legacyRequest = {
    ...request,
    query: { ...request.query, publicBrand: "vm0" as const },
  };
  expect(
    (await accept(client().deliveryAuthorization(legacyRequest), [200])).body
      .decision,
  ).toBe("deny");
  await enable(owner, false);
  expect(
    (await accept(client().deliveryAuthorization(request), [200])).body.allowed,
  ).toBeFalsy();
  await enable(owner);
  const restored = await accept(
    client(owner).updateSiteVisibility({
      headers,
      params,
      body: { visibility: "public", expectedRevision: changed.body.revision },
    }),
    [200],
  );
  expect(restored.body.visibility).toBe("public");
  expect(
    (await accept(client().deliveryAuthorization(request), [200])).body
      .decision,
  ).toBe("allow");
  expect(
    (await accept(client().deliveryAuthorization(legacyRequest), [200])).body
      .decision,
  ).toBe("deny");
});

test("organization access follows current membership in the site's organization", async () => {
  const { owner, prepared, request } = await publish();
  const viewer = createBddApi(context).user();
  await enable(owner);
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "organization", expectedRevision: null },
    }),
    [200],
  );
  let member = true;
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (params) => {
      const matches =
        typeof params === "object" &&
        params !== null &&
        "organizationId" in params &&
        params.organizationId === owner.orgId;
      return Promise.resolve({
        data:
          matches && member
            ? [
                {
                  publicUserData: { userId: viewer.userId },
                  organization: { id: owner.orgId },
                },
              ]
            : [],
      });
    },
  );
  expect(
    (
      await accept(
        client(viewer).deliveryAuthorization({ ...request, headers }),
        [200],
      )
    ).body.allowed,
  ).toBeTruthy();
  member = false;
  expect(
    (
      await accept(
        client(viewer).deliveryAuthorization({ ...request, headers }),
        [200],
      )
    ).body.decision,
  ).toBe("deny");
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
    new Error("Membership service unavailable"),
  );
  await accept(
    client(viewer).deliveryAuthorization({ ...request, headers }),
    [500],
  );
});

test("redeployment preserves an explicit policy for both aliases and immutable addresses", async () => {
  const { owner, api, input, prepared, request } = await publish();
  await enable(owner);
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  const next = await api.prepareHostedSite(owner, {
    ...input,
    files: [hostedTextFile("/index.html", "<p>next</p>")],
  });
  await api.completeHostedSite(owner, next.deploymentId);
  const old = await accept(
    client().deliveryAuthorization({
      ...request,
      query: { ...request.query, alias: `dpl-${prepared.deploymentId}` },
    }),
    [200],
  );
  expect(old.body.decision).toBe("authenticate");
  const policy = await accept(
    client(owner).siteVisibility({ headers, params: { siteId: next.siteId } }),
    [200],
  );
  expect(policy.body.visibility).toBe("private");
});

test("issued download grants stop working after a policy revision changes", async () => {
  const { owner, api, prepared } = await publish();
  await enable(owner);
  const files = await api.requestHostedSiteFiles(
    owner,
    `dpl-${prepared.deploymentId}`,
    [200],
  );
  if (files.status !== 200) {
    throw new Error("Expected hosted download files");
  }
  const url = new URL(files.body.files[0]!.downloadUrl);
  const token = url.pathname.split("/").at(-1)!;
  const download = {
    params: { token },
    query: { deploymentId: prepared.deploymentId, path: "/index.html" },
  };
  const first = await accept(client().downloadAuthorization(download), [200]);
  expect(first.body.file?.contentType).toBe("text/html; charset=utf-8");
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  expect(
    (await accept(client().downloadAuthorization(download), [200])).body.file,
  ).toBeNull();
});

test("a caller-supplied identity or foreign origin cannot authorize a private preview", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  const result = await accept(
    client(owner).siteAccess({
      headers,
      params: { siteId: prepared.siteId },
      query: { origin: "https://attacker.example" },
    }),
    [200],
  );
  expect(result.body.decision).toBe("authenticate");
});

test("concurrent edits cannot both replace the same policy revision", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const api = client(owner);
  const params = { siteId: prepared.siteId };
  const results = await Promise.all([
    api.updateSiteVisibility({
      headers,
      params,
      body: { visibility: "private", expectedRevision: null },
    }),
    api.updateSiteVisibility({
      headers,
      params,
      body: { visibility: "organization", expectedRevision: null },
    }),
  ]);
  expect(
    results
      .map((result) => {
        return result.status;
      })
      .sort(),
  ).toStrictEqual([200, 409]);
});

test("anonymous OG metadata stops exposing a Site after it becomes private", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const og = setupAppWithRoutes({ context, routes: artifactOgRoutes })(
    artifactOgContract,
  );
  const query = { kind: "host" as const, id: prepared.deploymentId };
  expect(
    (await accept(og.metadata({ query }), [200])).body.available,
  ).toBeTruthy();
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  expect(
    (await accept(og.metadata({ query }), [200])).body.available,
  ).toBeFalsy();
});

test("private downloads remain controlled with management disabled and stop after deletion", async () => {
  const { owner, api, input, prepared } = await publish();
  await enable(owner);
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  await enable(owner, false);
  mockEnv("HOSTED_SITE_ACCESS_ENABLED", "false");
  const files = await api.requestHostedSiteFiles(
    owner,
    `dpl-${prepared.deploymentId}`,
    [200],
  );
  if (files.status !== 200) {
    throw new Error("Expected hosted download files");
  }
  const url = new URL(files.body.files[0]!.downloadUrl);
  expect(url.hostname).toBe(`dpl-${prepared.deploymentId}.okou.app`);
  const download = {
    params: { token: url.pathname.split("/").at(-1)! },
    query: { deploymentId: prepared.deploymentId, path: "/index.html" },
  };
  expect(
    (await accept(client().downloadAuthorization(download), [200])).body.file,
  ).not.toBeNull();
  const wrongDeployment = {
    ...download,
    query: { ...download.query, deploymentId: randomUUID() },
  };
  expect(
    (await accept(client().downloadAuthorization(wrongDeployment), [200])).body
      .file,
  ).toBeNull();
  const wrongPath = {
    ...download,
    query: { ...download.query, path: "/missing.html" },
  };
  expect(
    (await accept(client().downloadAuthorization(wrongPath), [200])).body.file,
  ).toBeNull();
  await api.deleteHostedSite(owner, input.site);
  expect(
    (await accept(client().downloadAuthorization(download), [200])).body.file,
  ).toBeNull();
});
