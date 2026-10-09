import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { z } from "zod";
import { expect, onTestFinished, test } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { hostRoutes } from "../host";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";

const context = testContext();
const referenceSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: z.string(),
  publicBrand: z.enum(["vm0", "okou"]),
  prefix: z.string(),
  manifestKey: z.string(),
});

test("rejects malformed pointer identities at the anonymous request boundary", async () => {
  const client = setupAppWithRoutes({ context, routes: hostRoutes })(
    hostContract,
  );
  const params = { siteId: randomUUID(), deploymentId: randomUUID() };
  const query = {
    alias: "missing-site",
    publicSlug: "missing-site",
    publicBrand: "okou" as const,
    prefix: "sites/missing",
    manifestKey: "sites/missing/manifest.json",
  };
  for (const request of [
    { params: { ...params, siteId: "invalid" }, query },
    { params, query: { ...query, alias: "INVALID" } },
    { params, query: { ...query, prefix: "private-sites/missing" } },
    { params, query: { ...query, manifestKey: `sites/${"x".repeat(1024)}` } },
  ]) {
    const response = await accept(client.deliveryAuthorization(request), [400]);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  }
  const missing = await accept(
    client.deliveryAuthorization({ params, query }),
    [200],
  );
  expect(missing.body).toStrictEqual({ allowed: false });
  expect(missing.headers.get("Cache-Control")).toBe("private, no-store");
});

test("denies late immutable writes after deletion even when R2 loses the response", async () => {
  const bdd = createBddApi(context);
  const api = createHostMapsBddApi(context);
  const owner = bdd.user();
  const capture = api.captureHostedSitesS3();
  const site = `delivery-loss-${randomUUID().slice(0, 8)}`;
  const pending = await api.prepareHostedSite(owner, {
    site,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>old</p>")],
  });
  const send = context.mocks.s3.send.getMockImplementation();
  if (!send) {
    throw new Error("Hosted-sites storage mock is not installed");
  }
  const publishing = createDeferredPromise<void>(context.signal);
  const resume = createDeferredPromise<void>(context.signal);
  const pointerKey = `sites/brands/okou/deployments/${pending.deploymentId}.json`;
  const recordKey = `artifact-delivery/okou/html/dpl-${pending.deploymentId}.json`;
  context.mocks.s3.send.mockImplementation(async (request: unknown) => {
    if (
      request instanceof PutObjectCommand &&
      request.input.Key === pointerKey
    ) {
      publishing.resolve(undefined);
      await resume.promise;
    }
    const response = await send(request);
    if (
      request instanceof PutObjectCommand &&
      request.input.Key === recordKey
    ) {
      throw new Error("R2 accepted the alias write but its response was lost");
    }
    return response;
  });
  const completion = api.requestCompleteHostedSite(
    owner,
    pending.deploymentId,
    [500],
  );
  onTestFinished(async () => {
    if (!resume.settled()) {
      resume.resolve(undefined);
    }
    await Promise.allSettled([completion]);
  });
  await publishing.promise;
  await api.deleteHostedSite(owner, site);
  resume.resolve(undefined);
  await completion;
  await api.requestHostedSiteFiles(owner, `dpl-${pending.deploymentId}`, [409]);
  // Preserve the original failed physical-cleanup observation. The reader
  // candidate denies the residual reference instead of claiming it is absent.
  expect(capture.objects.get(recordKey)).toBeDefined();
  const reference = referenceSchema.parse(
    JSON.parse(capture.objects.get(pointerKey) ?? "null"),
  );
  const client = setupAppWithRoutes({ context, routes: hostRoutes })(
    hostContract,
  );
  const response = await accept(
    client.deliveryAuthorization({
      params: { siteId: pending.siteId, deploymentId: pending.deploymentId },
      query: { ...reference, alias: `dpl-${pending.deploymentId}` },
    }),
    [200],
  );
  expect(response.body.allowed).toBeFalsy();
});

test("waits for SQL readiness when the public pointer already exists", async () => {
  const bdd = createBddApi(context);
  const api = createHostMapsBddApi(context);
  const owner = bdd.user();
  const capture = api.captureHostedSitesS3();
  const site = `delivery-pending-${randomUUID().slice(0, 8)}`;
  const pending = await api.prepareHostedSite(owner, {
    site,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>old</p>")],
  });
  const send = context.mocks.s3.send.getMockImplementation();
  if (!send) {
    throw new Error("Hosted-sites storage mock is not installed");
  }
  const written = createDeferredPromise<void>(context.signal);
  const resume = createDeferredPromise<void>(context.signal);
  context.mocks.s3.send.mockImplementation(async (request: unknown) => {
    const response = await send(request);
    if (
      request instanceof PutObjectCommand &&
      request.input.Key === `artifact-delivery/okou/html/${site}.json`
    ) {
      written.resolve(undefined);
      await resume.promise;
    }
    return response;
  });
  const completion = api.completeHostedSite(owner, pending.deploymentId);
  onTestFinished(async () => {
    if (!resume.settled()) {
      resume.resolve(undefined);
    }
    await Promise.allSettled([completion]);
  });
  await written.promise;
  const reference = referenceSchema.parse(
    JSON.parse(
      capture.objects.get(`sites/brands/okou/${site}/active.json`) ?? "null",
    ),
  );
  const client = setupAppWithRoutes({ context, routes: hostRoutes })(
    hostContract,
  );
  const request = {
    params: { siteId: pending.siteId, deploymentId: pending.deploymentId },
    query: { ...reference, alias: site },
  };
  const before = await accept(client.deliveryAuthorization(request), [200]);
  expect(before.body.allowed).toBeFalsy();
  resume.resolve(undefined);
  await completion;
  const after = await accept(client.deliveryAuthorization(request), [200]);
  expect(after.body.allowed).toBeTruthy();
});

test("authorizes ready owned identities, keeps immutable history and denies deleted content", async () => {
  const bdd = createBddApi(context);
  const api = createHostMapsBddApi(context);
  const owner = bdd.user();
  const other = bdd.user();
  const capture = api.captureHostedSitesS3();
  const site = `delivery-${randomUUID().slice(0, 8)}`;
  const body = {
    site,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>site</p>")],
  };
  const first = await api.prepareHostedSite(owner, body);
  const prefix = `sites/brands/okou/publications/${first.deploymentId}`;
  const client = setupAppWithRoutes({ context, routes: hostRoutes })(
    hostContract,
  );
  const check = async (
    deploymentId: string,
    query: {
      alias: string;
      publicSlug: string;
      publicBrand: "okou" | "vm0";
      prefix: string;
      manifestKey: string;
    },
    siteId = first.siteId,
  ) => {
    const response = await accept(
      client.deliveryAuthorization({ params: { siteId, deploymentId }, query }),
      [200],
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    return response.body.allowed;
  };
  const firstQuery = {
    alias: site,
    publicSlug: site,
    publicBrand: "okou" as const,
    prefix,
    manifestKey: `${prefix}/manifest.json`,
  };
  await expect(check(first.deploymentId, firstQuery)).resolves.toBeFalsy();
  await api.completeHostedSite(owner, first.deploymentId);
  const reference = referenceSchema.parse(
    JSON.parse(
      capture.objects.get(`sites/brands/okou/${site}/active.json`) ?? "null",
    ),
  );
  expect(reference.deploymentId).toBe(first.deploymentId);
  await expect(check(first.deploymentId, firstQuery)).resolves.toBeTruthy();
  await expect(
    check(
      first.deploymentId.toUpperCase(),
      firstQuery,
      first.siteId.toUpperCase(),
    ),
  ).resolves.toBeTruthy();
  for (const query of [
    { ...firstQuery, publicBrand: "vm0" as const },
    { ...firstQuery, publicSlug: "other-site" },
    { ...firstQuery, prefix: "sites/foreign" },
    { ...firstQuery, manifestKey: "sites/foreign/manifest.json" },
    { ...firstQuery, alias: "other-site" },
  ]) {
    await expect(check(first.deploymentId, query)).resolves.toBeFalsy();
  }
  const foreign = await api.prepareHostedSite(other, {
    ...body,
    site: `foreign-${randomUUID().slice(0, 8)}`,
  });
  await api.completeHostedSite(other, foreign.deploymentId);
  await expect(check(foreign.deploymentId, firstQuery)).resolves.toBeFalsy();
  await expect(
    check(first.deploymentId, firstQuery, foreign.siteId),
  ).resolves.toBeFalsy();
  const newer = await api.prepareHostedSite(owner, body);
  await api.completeHostedSite(owner, newer.deploymentId);
  await expect(check(first.deploymentId, firstQuery)).resolves.toBeFalsy();
  await expect(
    check(first.deploymentId, {
      ...firstQuery,
      alias: `dpl-${first.deploymentId}`,
    }),
  ).resolves.toBeTruthy();
  await api.deleteHostedSite(owner, site);
  await expect(
    check(first.deploymentId, {
      ...firstQuery,
      alias: `dpl-${first.deploymentId}`,
    }),
  ).resolves.toBeFalsy();
  const replacement = await api.prepareHostedSite(owner, body);
  await api.completeHostedSite(owner, replacement.deploymentId);
  const replacementPrefix = `sites/brands/okou/publications/${replacement.deploymentId}`;
  await expect(
    check(replacement.deploymentId, {
      ...firstQuery,
      prefix: replacementPrefix,
      manifestKey: `${replacementPrefix}/manifest.json`,
    }),
  ).resolves.toBeTruthy();
  await expect(
    check(first.deploymentId, {
      ...firstQuery,
      alias: `dpl-${first.deploymentId}`,
    }),
  ).resolves.toBeFalsy();
  await expect(check(randomUUID(), firstQuery)).resolves.toBeFalsy();
});
