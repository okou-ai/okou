import { randomUUID } from "node:crypto";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

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

async function publish(plan: "free" | "pro") {
  const owner = createBddApi(context).user();
  const runs = createRunsApi(context);
  if (plan === "pro") {
    await runs.grantProEntitlement(owner);
  }
  await expect(runs.readBillingStatus(owner)).resolves.toMatchObject({
    tier: plan === "pro" ? "pro" : "limited-free-1",
  });
  const api = createHostBddApi(context);
  api.captureHostedSitesS3();
  const site = `paywall-${randomUUID().slice(0, 8)}`;
  const prepared = await api.prepareHostedSite(owner, {
    site,
    title: site,
    artifactKind: "hosted-site",
    spaFallback: false,
    visibility: "public",
    files: [
      hostedTextFile("/index.html", '<a href="about.html">About</a>'),
      hostedTextFile("/about.html", "<p>About</p>"),
    ],
  });
  await api.completeHostedSite(owner, prepared.deploymentId);
  const prefix = `sites/brands/okou/publications/${prepared.deploymentId}`;
  return {
    owner,
    prepared,
    delivery: {
      params: { siteId: prepared.siteId, deploymentId: prepared.deploymentId },
      query: {
        alias: prepared.publicSlug,
        publicSlug: prepared.publicSlug,
        publicBrand: "okou" as const,
        prefix,
        manifestKey: `${prefix}/manifest.json`,
        presentation: "banner" as const,
      },
    },
  };
}

async function optIntoPaywall(owner: ApiTestUser) {
  await createBillingMediaApi(context).updateFeatureSwitches(owner, {
    [FeatureSwitchKey.FreePlanArtifactPaywall]: true,
  });
}

test("a free plan keeps the banner, its address, and App downloads behind an upgrade", async () => {
  const { owner, prepared, delivery } = await publish("free");
  const params = { siteId: prepared.siteId };
  // Chosen before the paywall reached this workspace.
  const hidden = await accept(
    client(owner).updateSiteBanner({
      headers,
      params,
      body: { showBanner: false, expectedRevision: null },
    }),
    [200],
  );
  expect(hidden.body.showBanner).toBeFalsy();

  await optIntoPaywall(owner);

  expect(
    (await accept(client(owner).siteBanner({ headers, params }), [200])).body,
  ).toMatchObject({ showBanner: true, revision: hidden.body.revision });
  expect(
    (await accept(client().deliveryAuthorization(delivery), [200])).body,
  ).toMatchObject({
    allowed: true,
    presentation: { showBanner: true, downloadAllowed: false },
  });
  const banner = await accept(
    client(owner).updateSiteBanner({
      headers,
      params,
      body: { showBanner: false, expectedRevision: hidden.body.revision },
    }),
    [402],
  );
  expect(banner.body.error.code).toBe("PRO_REQUIRED");
  const rename = await accept(
    client(owner).updateSiteUrl({
      headers,
      params,
      body: {
        publicSlug: `${prepared.publicSlug}-new`,
        expectedPublicSlug: prepared.publicSlug,
      },
    }),
    [402],
  );
  expect(rename.body.error.code).toBe("PRO_REQUIRED");
  await accept(
    client(owner).files({
      headers,
      params: { publicSlug: prepared.publicSlug },
      query: {},
    }),
    [402],
  );
});

test("paid plans keep every artifact action with the paywall rolled out", async () => {
  const { owner, prepared, delivery } = await publish("pro");
  const params = { siteId: prepared.siteId };
  await optIntoPaywall(owner);

  await accept(
    client(owner).updateSiteBanner({
      headers,
      params,
      body: { showBanner: false, expectedRevision: null },
    }),
    [200],
  );
  expect(
    (await accept(client().deliveryAuthorization(delivery), [200])).body,
  ).toMatchObject({
    allowed: true,
    presentation: { showBanner: false, downloadAllowed: true },
  });
  await accept(
    client(owner).files({
      headers,
      params: { publicSlug: prepared.publicSlug },
      query: {},
    }),
    [200],
  );
  const next = `${prepared.publicSlug}-new`;
  const renamed = await accept(
    client(owner).updateSiteUrl({
      headers,
      params,
      body: { publicSlug: next, expectedPublicSlug: prepared.publicSlug },
    }),
    [200],
  );
  expect(renamed.body.publicSlug).toBe(next);
});
