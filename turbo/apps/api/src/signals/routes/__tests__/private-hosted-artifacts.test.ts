import { mockNow } from "../../../lib/time";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { hostRoutes } from "../host";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const api = createHostMapsBddApi(context);
const billing = createBillingMediaApi(context);

async function fixture(enabled = true) {
  const actor = bdd.user();
  await createRunsApi(context).grantProEntitlement(actor);
  await billing.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: enabled,
  });
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
  mockEnv("OKOU_HOST_SCHEME", "https");
  const capture = api.captureHostedSitesS3();
  const body = {
    site: `private-${randomUUID().slice(0, 8)}`,
    artifactKind: "hosted-site" as const,
    spaFallback: true,
    files: [
      hostedTextFile(
        "/index.html",
        '<link rel="stylesheet" href="/assets/site.css"><main>Private report</main>',
      ),
      hostedTextFile("/assets/site.css", "main { color: green }"),
    ],
  };
  return { actor, capture, body };
}

test("keeps runless deployments private across switch rollback and only issues owner previews", async () => {
  const { actor, capture, body } = await fixture();
  mocks.clerk.session(actor.userId, actor.orgId);
  const prepared = await accept(
    setupApp({ context, routes: hostRoutes })(hostContract).preparePrivate({
      headers: { authorization: "Bearer clerk-session" },
      body: { ...body, requirePrivateArtifact: true },
    }),
    [200],
  );
  const draft = prepared.body;
  const canonical = draft.url;
  expect(canonical).toMatch(/^\/artifacts\/[a-z0-9]{10}\.html$/u);
  expect(draft).toMatchObject({ url: canonical, artifactUrl: canonical });
  expect(draft.aliasUrl).toBeUndefined();
  await billing.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: false,
  });
  const completed = await api.completeHostedSite(actor, draft.deploymentId);
  expect(completed).toMatchObject({
    status: "ready",
    url: canonical,
    isActive: false,
  });
  expect(completed.aliasUrl).toBeUndefined();
  expect(
    capture.puts
      .filter(({ key }) => {
        return key.startsWith("private-sites/");
      })
      .map(({ key }) => {
        return key;
      }),
  ).toStrictEqual([`private-sites/okou/${draft.deploymentId}/manifest.json`]);
  const manifest = JSON.parse(
    capture.puts.find(({ key }) => {
      return key.endsWith("/manifest.json");
    })!.body,
  ) as Record<string, unknown>;
  expect(manifest.access).toBe("owner-private-v1");
  const files = await api.readHostedSiteFiles(
    actor,
    `dpl-${draft.deploymentId}`,
  );
  expect(files).toMatchObject({ url: canonical, fileCount: 2 });
  expect(files.aliasUrl).toBeUndefined();
  const history = await api.readHostedSiteDeployments(actor, body.site);
  expect(history).toMatchObject({ aliasUrl: null, activeDeploymentId: null });
  expect(history.deployments).toStrictEqual([
    expect.objectContaining({ artifactUrl: canonical, isActive: false }),
  ]);
  mockNow(new Date("2026-09-09T12:00:00.000Z"));
  const preview = await api.requestPrivateHostedPreview(
    actor,
    draft.deploymentId,
    [200],
  );
  expect(preview.status).toBe(200);
  expect(preview.headers.get("cache-control")).toBe("private, no-store");
  if (preview.status !== 200) {
    throw new Error("Expected preview");
  }
  expect(preview.body.url).toMatch(/^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/);
  expect(preview.body.expiresAt).toBe("2026-09-11T12:00:00.000Z");
  const token = new URL(preview.body.url).hostname.slice(3).split(".")[0];
  expect(capture.puts.at(-1)).toStrictEqual({
    key: `private-previews/okou/${token}.json`,
    body: JSON.stringify({
      version: 1,
      publicBrand: "okou",
      deploymentId: draft.deploymentId,
      immutableContent: true,
      expiresAt: preview.body.expiresAt,
    }),
  });
  const view = await api.requestPrivateHostedView(
    actor,
    draft.deploymentId,
    [302],
  );
  expect(view.headers.get("location")).toMatch(
    /^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/,
  );
  expect(view.headers.get("cache-control")).toBe("private, no-store");
  expect(view.headers.get("referrer-policy")).toBe("no-referrer");
  const second = await api.requestPrivateHostedPreview(
    actor,
    draft.deploymentId,
    [200],
  );
  if (second.status !== 200) {
    throw new Error("Expected a second private preview");
  }
  expect(second.body.url).not.toBe(preview.body.url);
  expect(
    (await api.readHostedSiteFiles(actor, `dpl-${draft.deploymentId}`)).url,
  ).toBe(canonical);
});

test("denies anonymous, other-owner and other-org preview, completion and cloning", async () => {
  const { actor, body, capture } = await fixture();
  const draft = await api.prepareHostedSite(actor, body);
  const sameOrg = bdd.user({ orgId: actor.orgId });
  const otherOrg = bdd.user({ userId: actor.userId });
  await api.requestCompleteHostedSite(sameOrg, draft.deploymentId, [404]);
  await api.requestCompleteHostedSite(otherOrg, draft.deploymentId, [404]);
  await api.completeHostedSite(actor, draft.deploymentId);
  const signedWrites = capture.puts.length;
  for (const unauthorized of [null, sameOrg, otherOrg]) {
    const status = unauthorized === null ? 401 : 404;
    await api.requestPrivateHostedPreview(unauthorized, draft.deploymentId, [
      status,
    ]);
    await api.requestPrivateHostedView(unauthorized, draft.deploymentId, [
      status,
    ]);
    await api.requestHostedSiteFiles(
      unauthorized,
      `dpl-${draft.deploymentId}`,
      [status],
    );
    await api.requestHostedSiteFiles(unauthorized, body.site, [status]);
    await api.requestHostedSiteDeployments(unauthorized, body.site, [status]);
  }
  expect(capture.puts).toHaveLength(signedWrites);
});

test("allocates independent slugs across public and private publication policies", async () => {
  const { actor, body, capture } = await fixture(false);
  const published = await api.prepareHostedSite(actor, body);
  await api.completeHostedSite(actor, published.deploymentId);
  const publicWrites = capture.puts
    .filter(({ key }) => {
      return key.startsWith("sites/");
    })
    .map(({ key, body }) => {
      return { key, body };
    });
  await billing.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: true,
  });
  const draft = await api.prepareHostedSite(actor, body);
  expect(draft.siteId).not.toBe(published.siteId);
  expect(draft.deploymentId).not.toBe(published.deploymentId);
  expect(draft.publicSlug.startsWith(`${body.site}-`)).toBeTruthy();
  expect(draft.publicSlug.slice(body.site.length + 1)).toMatch(
    /^[a-z0-9]{4}$/u,
  );
  expect(draft.deploymentVersion).toBe(1);
  await api.completeHostedSite(actor, draft.deploymentId);
  expect(
    capture.puts.filter(({ key }) => {
      return key.startsWith("sites/");
    }),
  ).toStrictEqual(publicWrites);
  const history = await api.readHostedSiteDeployments(actor, body.site);
  expect(history).toMatchObject({
    aliasUrl: published.url,
    activeDeploymentId: published.deploymentId,
    activeDeploymentVersion: 1,
  });
  expect(history.deployments).toHaveLength(1);
  expect((await api.readHostedSiteFiles(actor, body.site)).deploymentId).toBe(
    published.deploymentId,
  );
  const colleague = bdd.user({ orgId: actor.orgId });
  expect(
    (await api.readHostedSiteFiles(colleague, body.site)).deploymentId,
  ).toBe(published.deploymentId);
  await api.requestHostedSiteFiles(colleague, draft.publicSlug, [404]);
  await api.requestHostedSiteDeployments(colleague, draft.publicSlug, [404]);
  await billing.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: false,
  });
  const nextPublic = await api.prepareHostedSite(actor, body);
  expect(nextPublic.publicSlug.startsWith(`${body.site}-`)).toBeTruthy();
  expect(nextPublic.publicSlug.slice(body.site.length + 1)).toMatch(
    /^[a-z0-9]{4}$/u,
  );
  expect(nextPublic.publicSlug).not.toBe(draft.publicSlug);
  expect(nextPublic.siteId).not.toBe(draft.siteId);
  expect(nextPublic.siteId).not.toBe(published.siteId);
  await api.completeHostedSite(actor, nextPublic.deploymentId);
  expect(
    (await api.readHostedSiteFiles(actor, draft.publicSlug)).deploymentId,
  ).toBe(draft.deploymentId);
  expect(
    (await api.readHostedSiteFiles(colleague, nextPublic.publicSlug))
      .deploymentId,
  ).toBe(nextPublic.deploymentId);
  await api.requestHostedSiteFiles(colleague, draft.publicSlug, [404]);
});

test("creates hostless references without requiring an API hostname", async () => {
  const { actor, body, capture } = await fixture();
  mockEnv("OKOU_API_BACKEND_URL", undefined);
  const draft = await api.prepareHostedSite(actor, body);
  expect(draft.url).toMatch(/^\/artifacts\/[a-z0-9]{10}\.html$/u);
  expect(
    capture.puts.some(({ key }) => {
      return key.startsWith("sites/");
    }),
  ).toBeFalsy();
});
