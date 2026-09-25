import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import {
  insertLegacyHostedSiteFixture,
  insertLegacyHostedSiteHistoryFixture,
} from "../../../test-fixtures/hosted-sites";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createMapsBillingApi } from "./helpers/api-bdd-maps-billing";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  VERTEX_MAPS_URL,
  vertexMapsResponse,
} from "./helpers/google-maps-grounding";

/*
FILE-01 host APIs plus BILL-02/CHAIN-BILLING-MEDIA maps billing. Replaces the
legacy zero-host.test.ts and zero-maps.test.ts route tests:
- Hosted-site/deployment/artifact DB-row asserts are replaced by the files GET
  and complete response bodies; maps org-credit row asserts are
  replaced by billing-status deltas.
- The run-artifact chain uses the run's real Okou token from the runner claim
  (`claim.platformEnvironment.OKOU_TOKEN`) instead of seeding runs and rewriting
  deployment rows.
- Maps gates (NOT_CONFIGURED / 402 / invalid location) stay owned by
  billing-usage-media.bdd.test.ts BILL-02; the legacy slug-suffix request and
  missing-index validations stay owned by chat-files.bdd.test.ts FILE-01.
- "run token without maps:read -> 403" is dropped: every production Okou
  token carries maps:read unconditionally (generateOkouToken), so the case is
  not API-constructible.
*/

const context = testContext();

describe("FILE-01: hosted-site deployments through host APIs", () => {
  it.each([false, true])(
    "preserves history and aliases across out-of-order legacy/rollback completion (immutable first: %s) [HOST-A]",
    async (immutableFirst) => {
      const bdd = createBddApi(context);
      const api = createHostMapsBddApi(context);
      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected legacy site owner organization");
      }
      const capture = api.captureHostedSitesS3();
      const site = `legacy-history-${randomUUID().slice(0, 8)}`;
      const files = [hostedTextFile("/index.html", "<main>historical</main>")];
      // Historical/rollback writers could attach two uploads to one site.
      const history = await insertLegacyHostedSiteHistoryFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        site,
        files,
        immutableFirst,
      });
      const first = history.deployments[0];
      const second = history.deployments[1];
      if (!first || !second) {
        throw new Error("Expected two legacy uploads");
      }
      await api.completeHostedSite(actor, second.id);
      const completedFirst = await api.completeHostedSite(actor, first.id);
      expect(completedFirst).toMatchObject({
        deploymentId: first.id,
        isActive: false,
        activeDeploymentVersion: 2,
      });
      await expect(api.readHostedSiteFiles(actor, site)).resolves.toMatchObject(
        {
          deploymentId: second.id,
        },
      );
      for (const deployment of history.deployments) {
        for (const target of [site, `dpl-${deployment.id}`]) {
          await expect(
            api.readHostedSiteFiles(
              actor,
              target,
              deployment.deploymentVersion,
            ),
          ).resolves.toMatchObject({
            deploymentId: deployment.id,
            artifactUrl: deployment.artifactUrl,
            files,
          });
        }
        expect(capture.puts).toContainEqual(
          expect.objectContaining({
            key: `${deployment.r2Prefix}/manifest.json`,
          }),
        );
      }
      const listed = await api.readHostedSiteDeployments(actor, site);
      expect(listed.deployments).toHaveLength(2);
      expect(listed.activeDeploymentId).toBe(second.id);
    },
  );

  it("gives concurrent publications of one preferred slug their own versions [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    api.captureHostedSitesS3();
    const body = {
      site: `bdd-concurrent-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>concurrent</main>")],
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, async () => {
        return await api.prepareHostedSite(actor, body);
      }),
    );
    expect(
      new Set(
        results.map((result) => {
          return result.siteId;
        }),
      ).size,
    ).toBe(1);
    for (const result of results) {
      expect(result.publicSlug).toBe(body.site);
    }
    expect(
      new Set(
        results.map((result) => {
          return result.deploymentVersion;
        }),
      ),
    ).toStrictEqual(new Set([1, 2, 3]));
    const history = await api.readHostedSiteDeployments(actor, body.site);
    expect(history.deployments).toHaveLength(3);
    for (const prepared of results) {
      expect(history.deployments).toContainEqual(
        expect.objectContaining({
          deploymentId: prepared.deploymentId,
          deploymentVersion: prepared.deploymentVersion,
          status: "uploading",
        }),
      );
    }
  });

  it("redeploys one site while keeping previous publication URLs and completion retries stable [HOST-A]", async () => {
    mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou-public-sites.test");
    mockEnv("ZERO_HOST_DOMAIN", "zero-sites.test");
    mockEnv("OKOU_HOST_SCHEME", "http");
    mockEnv("ZERO_HOST_SCHEME", "https");
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    api.captureHostedSitesS3();
    const site = `bdd-published-${randomUUID().slice(0, 8)}`;
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>original</main>")],
    };
    const first = await api.prepareHostedSite(actor, body);
    expect(first.url).toBe(`http://${site}.okou-public-sites.test`);
    expect(first.aliasUrl).toBe(first.url);
    expect(first.deploymentVersion).toBe(1);
    expect(first.artifactUrl).toBe(
      `http://dpl-${first.deploymentId}.okou-public-sites.test`,
    );
    const completed = await api.completeHostedSite(actor, first.deploymentId);
    await expect(
      api.completeHostedSite(actor, first.deploymentId),
    ).resolves.toStrictEqual(completed);

    const replacement = await api.prepareHostedSite(actor, {
      ...body,
      files: [hostedTextFile("/index.html", "<main>updated</main>")],
    });
    await api.completeHostedSite(actor, replacement.deploymentId);
    // Redeploying the preferred name keeps one site and one alias.
    expect(replacement.siteId).toBe(first.siteId);
    expect(replacement.publicSlug).toBe(site);
    expect(replacement.aliasUrl).toBe(first.aliasUrl);
    expect(replacement.artifactUrl).not.toBe(first.artifactUrl);
    expect(replacement.deploymentVersion).toBe(2);
    await expect(
      api.completeHostedSite(actor, first.deploymentId),
    ).resolves.toMatchObject({
      deploymentId: first.deploymentId,
      isActive: false,
      activeDeploymentVersion: 2,
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    // The previous publication keeps its own immutable URL and bytes.
    await expect(
      api.readHostedSiteFiles(actor, `dpl-${first.deploymentId}`),
    ).resolves.toMatchObject({
      deploymentId: first.deploymentId,
      artifactUrl: first.artifactUrl,
      deploymentVersion: 1,
      files: body.files,
    });
    await expect(
      api.readHostedSiteFiles(actor, site, 1),
    ).resolves.toMatchObject({
      deploymentId: first.deploymentId,
    });
    for (const target of [site, `dpl-${replacement.deploymentId}`]) {
      await expect(
        api.readHostedSiteFiles(actor, target),
      ).resolves.toMatchObject({
        deploymentId: replacement.deploymentId,
        files: [
          expect.objectContaining({
            sha256: hostedTextFile("/index.html", "<main>updated</main>")
              .sha256,
          }),
        ],
      });
    }
    const history = await api.readHostedSiteDeployments(actor, site);
    expect(history.deployments).toStrictEqual([
      expect.objectContaining({
        deploymentId: replacement.deploymentId,
        deploymentVersion: 2,
        isActive: true,
      }),
      expect.objectContaining({
        deploymentId: first.deploymentId,
        deploymentVersion: 1,
        isActive: false,
      }),
    ]);
  });

  it("redeploys the same preferred slug more times than the collision retry limit [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    api.captureHostedSitesS3();
    const body = {
      site: `bdd-repeat-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>copy</main>")],
    };
    const publications = [await api.prepareHostedSite(actor, body)];
    for (let index = 1; index < 8; index += 1) {
      publications.push(await api.prepareHostedSite(actor, body));
    }
    expect(
      new Set(
        publications.map((site) => {
          return site.siteId;
        }),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        publications.map((site) => {
          return site.deploymentId;
        }),
      ).size,
    ).toBe(8);
    expect(
      publications.map((site) => {
        return site.publicSlug;
      }),
    ).toStrictEqual(
      Array.from({ length: 8 }, () => {
        return body.site;
      }),
    );
    expect(
      publications.map((site) => {
        return site.deploymentVersion;
      }),
    ).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const history = await api.readHostedSiteDeployments(actor, body.site);
    expect(history.deployments).toHaveLength(8);
  });

  it("reserves legacy-layout hosted-site identities and creates new sites in the current layout [HOST-A]", async () => {
    mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
    mockEnv("ZERO_HOST_DOMAIN", "sites.vm0.io");
    mockEnv("OKOU_HOST_SCHEME", "https");
    mockEnv("ZERO_HOST_SCHEME", "https");
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected branded host actor to have an org");
    }
    const capture = api.captureHostedSitesS3();
    await upsertOrgPlanEntitlementFixture({ orgId: actor.orgId });

    const vm0Site = `bdd-vm0-brand-${randomUUID().slice(0, 8)}`;
    const vm0Body = {
      site: vm0Site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>VM0 site</main>")],
    };
    // Historical site identities remain reserved after redeployment is retired.
    const legacySiteId = await insertLegacyHostedSiteFixture({
      orgId: actor.orgId,
      userId: actor.userId,
      site: vm0Site,
    });
    const replacement = await api.prepareHostedSite(actor, vm0Body);
    expect(replacement.siteId).not.toBe(legacySiteId);
    expect(replacement.publicSlug.startsWith(`${vm0Site}-`)).toBeTruthy();
    expect(replacement.publicSlug.slice(vm0Site.length + 1)).toMatch(
      /^[a-z0-9]{4}$/u,
    );
    expect(replacement.url).toBe(`https://${replacement.publicSlug}.okou.app`);
    await expect(
      api.readHostedSiteDeployments(actor, vm0Site),
    ).resolves.toMatchObject({
      siteId: legacySiteId,
      publicSlug: vm0Site,
      deployments: [],
    });

    const browserOkouSite = `bdd-browser-okou-${randomUUID().slice(0, 8)}`;
    const createdOnOkou = await api.prepareHostedSite(actor, {
      ...vm0Body,
      site: browserOkouSite,
    });
    expect(createdOnOkou.url).toBe(`https://${browserOkouSite}.okou.app`);

    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: actor.orgId },
          role: "org:admin",
        },
      ],
    });
    const okouToken = runs.okouTokenForRunWithCapabilities(
      actor,
      randomUUID(),
      ["host:write"],
    );
    const okouSite = `bdd-okou-brand-${randomUUID().slice(0, 8)}`;
    const createdWithOkouToken = await api.prepareHostedSite(
      { bearerToken: okouToken },
      {
        site: okouSite,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [hostedTextFile("/index.html", "<main>Okou site</main>")],
      },
    );
    expect(createdWithOkouToken.url).toBe(`https://${okouSite}.okou.app`);
    expect(createdWithOkouToken.artifactUrl).toBe(
      `https://dpl-${createdWithOkouToken.deploymentId}.okou.app`,
    );

    await api.completeHostedSite(
      { bearerToken: okouToken },
      createdWithOkouToken.deploymentId,
    );
    const okouPointerKey = `sites/brands/okou/${okouSite}/active.json`;
    const okouDeploymentPointerKey = `sites/brands/okou/deployments/${createdWithOkouToken.deploymentId}.json`;
    const okouPointer = capture.puts.find((put) => {
      return put.key === okouPointerKey;
    });
    expect(okouPointer).toBeDefined();
    expect(JSON.parse(okouPointer?.body ?? "{}")).toMatchObject({
      publicBrand: "okou",
      publicSlug: okouSite,
      deploymentId: createdWithOkouToken.deploymentId,
    });
    expect(
      capture.puts.some((put) => {
        return put.key === okouDeploymentPointerKey;
      }),
    ).toBeTruthy();
    const okouManifest = capture.puts.find((put) => {
      return put.key.endsWith("/manifest.json") && put.body.includes(okouSite);
    });
    expect(JSON.parse(okouManifest?.body ?? "{}")).toMatchObject({
      publicBrand: "okou",
      publicSlug: okouSite,
      deploymentId: createdWithOkouToken.deploymentId,
    });
    expect(
      capture.puts.some((put) => {
        return (
          put.key === `sites/${okouSite}/active.json` ||
          put.key ===
            `sites/deployments/${createdWithOkouToken.deploymentId}.json`
        );
      }),
    ).toBeFalsy();
  });

  it("adds a four-character hash only when the simple alias is already occupied [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    api.captureHostedSitesS3();

    const aliasOwner = bdd.user();
    const occupied = await api.prepareHostedSite(aliasOwner, {
      site: `bdd-alias-owner-${randomUUID().slice(0, 8)}`,
      slugSuffix: "fixed",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>occupied</main>")],
    });

    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected collision actor to have an org");
    }
    const capture = api.captureHostedSitesS3();
    await upsertOrgPlanEntitlementFixture({ orgId: actor.orgId });
    const versioned = await api.prepareHostedSite(actor, {
      site: occupied.publicSlug,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>collision</main>")],
    });
    expect(
      versioned.publicSlug.startsWith(`${occupied.publicSlug}-`),
    ).toBeTruthy();
    expect(versioned.publicSlug.slice(occupied.publicSlug.length + 1)).toMatch(
      /^[a-z0-9]{4}$/u,
    );
    expect(versioned.deploymentVersion).toBe(1);
    expect(versioned.artifactUrl).toContain(`dpl-${versioned.deploymentId}.`);

    await api.completeHostedSite(actor, versioned.deploymentId);
    expect(
      capture.puts.map((put) => {
        return put.key;
      }),
    ).toContain(
      `sites/brands/okou/publications/${versioned.deploymentId}/manifest.json`,
    );
  });

  it("serves owner file metadata after retrying incomplete uploads and gates suspended orgs [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected hosted site actor to have an org");
    }
    // First test in the file: install the S3 boundary explicitly before any
    // host call (mock defaults only arrive in afterEach resets).
    const capture = api.captureHostedSitesS3();

    const site = `bdd-host-${randomUUID().slice(0, 8)}`;
    const indexFile = hostedTextFile("/index.html", "<main>BDD host</main>");
    const scriptFile = hostedTextFile(
      "/assets/app-4f3a9c12.js",
      "console.log('bdd host');",
      "application/javascript",
    );
    const files = [indexFile, scriptFile];
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: true,
      files,
    };

    const first = await api.prepareHostedSite(actor, body);
    expect(first.publicSlug).toBe(site);
    expect(first.deploymentVersion).toBe(1);
    expect(
      first.uploads.map((upload) => {
        return upload.path;
      }),
    ).toStrictEqual(["/index.html", "/assets/app-4f3a9c12.js"]);
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "test-hosted-sites-access-key",
          secretAccessKey: "test-hosted-sites-secret-key",
        },
      }),
    );

    const missingKey = `sites/brands/okou/publications/${first.deploymentId}/assets/app-4f3a9c12.js`;
    capture.missingKeys.add(missingKey);
    const notUploaded = await api.requestCompleteHostedSite(
      actor,
      first.deploymentId,
      [400],
    );
    expectApiError(notUploaded.body);
    expect(notUploaded.body.error.message).toBe(
      "Hosted deployment file was not uploaded: /assets/app-4f3a9c12.js",
    );
    capture.missingKeys.delete(missingKey);

    const completed = await api.completeHostedSite(actor, first.deploymentId);
    expect(completed).toMatchObject({
      siteId: first.siteId,
      deploymentId: first.deploymentId,
      publicSlug: first.publicSlug,
      url: first.url,
      deploymentVersion: 1,
      artifactUrl: first.artifactUrl,
      aliasUrl: first.url,
      isActive: true,
      activeDeploymentVersion: 1,
      status: "ready",
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    const listed = await api.readHostedSiteFiles(actor, first.publicSlug);
    expect(listed).toMatchObject({
      siteId: first.siteId,
      deploymentId: first.deploymentId,
      publicSlug: first.publicSlug,
      url: first.url,
      fileCount: 2,
      size: indexFile.size + scriptFile.size,
    });
    expect(
      listed.files.map((file) => {
        return {
          path: file.path,
          size: file.size,
          contentType: file.contentType,
          downloadUrl: file.downloadUrl,
        };
      }),
    ).toStrictEqual([
      {
        path: "/assets/app-4f3a9c12.js",
        size: scriptFile.size,
        contentType: "application/javascript",
        downloadUrl: "https://r2.example.com/hosted-sites/download?sig=bdd",
      },
      {
        path: "/index.html",
        size: indexFile.size,
        contentType: "text/html; charset=utf-8",
        downloadUrl: "https://r2.example.com/hosted-sites/download?sig=bdd",
      },
    ]);

    const outsider = bdd.user();
    const crossOrg = await api.requestHostedSiteFiles(
      outsider,
      first.publicSlug,
      [200],
    );
    expect(crossOrg.body).toStrictEqual(listed);

    const third = await api.prepareHostedSite(actor, {
      ...body,
      site: `${site}-pending`,
    });
    const onboardingCompleted = await bdd.completeOnboarding(actor);
    expect(onboardingCompleted.status).toBe(200);
    if (!actor.orgId) {
      throw new Error("Expected suspended host actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
    });
    const suspendedComplete = await api.requestCompleteHostedSite(
      actor,
      third.deploymentId,
      [402],
    );
    expectApiError(suspendedComplete.body);
    expect(suspendedComplete.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const suspendedPrepare = await api.requestPrepareHostedSite(
      actor,
      body,
      [402],
    );
    expectApiError(suspendedPrepare.body);
    expect(suspendedPrepare.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("rejects unauthenticated prepares and oversized public slugs [HOST-D]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const files = [hostedTextFile("/index.html", "<main>auth matrix</main>")];

    const unauthenticated = await api.requestPrepareHostedSite(
      null,
      {
        site: "bdd-anon-site",
        artifactKind: "hosted-site",
        spaFallback: false,
        files,
      },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const tooLong = await api.requestPrepareHostedSite(
      actor,
      {
        site: "a".repeat(63),
        slugSuffix: "b".repeat(32),
        artifactKind: "hosted-site",
        spaFallback: false,
        files,
      },
      [400],
    );
    expectApiError(tooLong.body);
    expect(tooLong.body.error.code).toBe("BAD_REQUEST");
    expect(tooLong.body.error.message).toContain("96");
  });

  it("charges Gemini and Google Maps grounding cost with a 25% markup [MAPS-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(admin);
    billing.configureMapsProvider();

    let providerCalls = 0;
    let providerAuthorization: string | null = null;
    let providerBody: unknown;
    const answer = "Café Central is open nearby.";
    server.use(
      http.post(VERTEX_MAPS_URL, async ({ request }) => {
        providerCalls += 1;
        providerAuthorization = request.headers.get("authorization");
        providerBody = await request.json();
        return vertexMapsResponse({ answer });
      }),
    );

    const before = await billing.readBillingStatus(admin);
    const search = await billing.requestMapsSearch(
      admin,
      {
        query: "best café near me",
        location: { latitude: 48.21, longitude: 16.37 },
        languageCode: "de_AT",
      },
      [200],
    );
    expect(search.headers.get("cache-control")).toBe("private, no-store");
    expect(search.body).toStrictEqual({
      query: "best café near me",
      location: { latitude: 48.21, longitude: 16.37 },
      languageCode: "de_AT",
      provider: "google-maps-grounding",
      model: "gemini-2.5-flash",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 25_155,
      providerCostUsd: 0.025155,
      creditsCharged: 32,
      answer,
      sources: [
        {
          title: "Café Central",
          uri: "https://maps.google.com/?cid=123",
        },
      ],
      citations: [
        {
          startByte: 0,
          endByte: Buffer.byteLength(answer),
          text: answer,
          sourceIndices: [0],
        },
      ],
      attribution: "Google Maps",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(providerAuthorization).toBe("Bearer synthetic-google-token");
    expect(providerBody).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "best café near me" }] }],
      tools: [
        {
          googleMaps: {
            groundingTypes: { places: {}, routing: {} },
          },
        },
      ],
      toolConfig: {
        retrievalConfig: {
          latLng: { latitude: 48.21, longitude: 16.37 },
          languageCode: "de_AT",
        },
      },
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 2048,
      },
    });
    const serializedProviderBody = JSON.stringify(providerBody);
    expect(serializedProviderBody).not.toContain("apiKey");
    expect(serializedProviderBody).toContain(
      "No implicit user location is available",
    );
    expect(serializedProviderBody).toContain(
      "Do not assist with high-risk uses of maps",
    );
    expect(providerCalls).toBe(1);

    const settled = await billing.readBillingStatus(admin);
    expect(settled.credits).toBe(before.credits - 32);

    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        providerCalls += 1;
        return HttpResponse.json(
          { error: { message: "private-provider-detail" } },
          { status: 500 },
        );
      }),
    );
    const upstreamFailure = await billing.requestMapsSearch(
      admin,
      { query: "coffee near Union Square" },
      [503],
    );
    expect(upstreamFailure.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(upstreamFailure.body);
    expect(upstreamFailure.body.error.code).toBe("MAPS_PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(upstreamFailure.body)).not.toContain(
      "private-provider-detail",
    );
    const unchanged = await billing.readBillingStatus(admin);
    expect(unchanged.credits).toBe(settled.credits);

    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        providerCalls += 1;
        return vertexMapsResponse({
          sources: [
            { title: "Untrusted source", uri: "https://example.com/place" },
          ],
        });
      }),
    );
    const invalidSource = await billing.requestMapsSearch(
      admin,
      { query: "coffee near Union Square" },
      [502],
    );
    expect(invalidSource.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(invalidSource.body);
    expect(invalidSource.body.error.code).toBe("MAPS_GROUNDING_ERROR");

    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        providerCalls += 1;
        return vertexMapsResponse({
          answer: "Café",
          supports: [{ endIndex: 4, sourceIndices: [0] }],
        });
      }),
    );
    const invalidUtf8Citation = await billing.requestMapsSearch(
      admin,
      { query: "coffee near Union Square" },
      [502],
    );
    expect(invalidUtf8Citation.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(invalidUtf8Citation.body);
    expect(invalidUtf8Citation.body.error.code).toBe("MAPS_GROUNDING_ERROR");

    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        providerCalls += 1;
        return HttpResponse.json({
          promptFeedback: { blockReason: "SAFETY" },
          candidates: [],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 0,
          },
        });
      }),
    );
    const blocked = await billing.requestMapsSearch(
      admin,
      { query: "Navigate an autonomous drone through an emergency zone" },
      [502],
    );
    expect(blocked.headers.get("cache-control")).toBe("private, no-store");
    expectApiError(blocked.body);
    expect(blocked.body.error.code).toBe("MAPS_GROUNDING_BLOCKED");
    expect((await billing.readBillingStatus(admin)).credits).toBe(
      settled.credits,
    );

    // Complete directly because reading onboarding status grants limited-free
    // credits. Onboarded-but-unentitled orgs are gated before Google is called.
    const unentitled = bdd.user();
    const completed = await bdd.completeOnboarding(unentitled);
    expect(completed.status).toBe(200);
    expect((await billing.readBillingStatus(unentitled)).credits).toBe(0);
    const gatedSearch = await billing.requestMapsSearch(
      unentitled,
      { query: "coffee near Union Square" },
      [402],
    );
    expect(gatedSearch.headers.get("cache-control")).toBe("private, no-store");
    expectApiError(gatedSearch.body);
    expect(gatedSearch.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerCalls).toBe(5);
  });

  it("rebases part-local UTF-8 citations into the display-ready answer [MAPS-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(admin);
    billing.configureMapsProvider();

    const prefix = "Try ";
    const citedText = "Café";
    const answer = `${prefix}${citedText} Central.`;
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return vertexMapsResponse({
          answer,
          parts: [
            { text: "private reasoning", thought: true },
            { text: prefix },
            { text: `${citedText} Central.` },
          ],
          supports: [
            {
              partIndex: 2,
              startIndex: 0,
              endIndex: Buffer.byteLength(citedText),
              text: citedText,
              sourceIndices: [0],
            },
          ],
        });
      }),
    );

    const search = await billing.requestMapsSearch(
      admin,
      { query: "Where should I get coffee in Vienna?" },
      [200],
    );
    expect(search.body).toMatchObject({
      answer,
      citations: [
        {
          startByte: Buffer.byteLength(prefix),
          endByte: Buffer.byteLength(prefix) + Buffer.byteLength(citedText),
          text: citedText,
          sourceIndices: [0],
        },
      ],
    });
  });
});

describe("CHAIN-BILLING-MEDIA/FILE-01: run-scoped agent-token attribution", () => {
  it("attributes maps usage and hosted-site artifacts through a run-scoped token [HOST-B/MAPS-B]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD host maps agent",
      description: "Run-scoped maps and host attribution.",
      visibility: "private",
    });
    billing.configureMapsProvider();
    let mapsRequests = 0;
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        mapsRequests += 1;
        return vertexMapsResponse();
      }),
    );

    const created = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "attribute maps and host usage",
      modelProvider: "anthropic-api-key",
    });
    const okouToken = runs.okouTokenForRunWithCapabilities(
      actor,
      created.runId,
      ["maps:read", "host:write"],
    );
    expect(okouToken).toMatch(/^vm0_sandbox_/);

    const before = await billing.readBillingStatus(actor);

    const mapsSearch = await api.requestMapsSearchWithBearer(
      okouToken,
      { query: "coffee near 1 Infinite Loop, Cupertino" },
      [200],
    );
    expect(mapsSearch.body).toMatchObject({
      provider: "google-maps-grounding",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 25_155,
      creditsCharged: 32,
    });
    expect(mapsRequests).toBe(1);

    api.captureHostedSitesS3();
    const bearer = { bearerToken: okouToken };
    const site = `bdd-run-artifact-${randomUUID().slice(0, 8)}`;
    const prepared = await api.prepareHostedSite(bearer, {
      site,
      slugSuffix: "run-01",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>run artifact</main>")],
    });
    expect(prepared.publicSlug).toBe(site);
    expect(prepared.deploymentVersion).toBe(1);

    const completed = await api.completeHostedSite(
      bearer,
      prepared.deploymentId,
    );
    expect(completed.status).toBe("ready");
    // Completing again exercises the idempotent artifact upsert.
    const recompleted = await api.completeHostedSite(
      bearer,
      prepared.deploymentId,
    );
    expect(recompleted).toStrictEqual(completed);

    const settled = await billing.readBillingStatus(actor);
    expect(settled.credits).toBe(before.credits - 32);
  });
});
