import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { insertLegacyHostedSiteFixture } from "../../../test-fixtures/hosted-sites";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createMapsBillingApi } from "./helpers/api-bdd-maps-billing";
import { createRunsApi } from "./helpers/api-bdd-runs";

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

const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GOOGLE_PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACE_DETAILS_URL =
  "https://places.googleapis.com/v1/places/ChIJtest";
const OPENSTREETMAP_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function geocodeOkHandler(requests: URL[]) {
  return http.get(GOOGLE_GEOCODING_URL, ({ request }) => {
    requests.push(new URL(request.url));
    return HttpResponse.json({
      status: "OK",
      results: [
        {
          formatted_address: "1 Infinite Loop, Cupertino, CA",
          geometry: { location: { lat: 37.3317, lng: -122.0301 } },
        },
      ],
    });
  });
}

describe("FILE-01: hosted-site deployments through host APIs", () => {
  it("allocates independent sites when concurrent publications use the same preferred slug [HOST-A]", async () => {
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
    ).toBe(3);
    expect(
      new Set(
        results.map((result) => {
          return result.publicSlug;
        }),
      ).size,
    ).toBe(3);
    expect(
      results.map((result) => {
        return result.publicSlug;
      }),
    ).toContain(body.site);
    for (const prepared of results) {
      const history = await api.readHostedSiteDeployments(
        actor,
        prepared.publicSlug,
      );
      expect(history.deployments).toStrictEqual([
        expect.objectContaining({
          deploymentId: prepared.deploymentId,
          deploymentVersion: 1,
          status: "uploading",
        }),
      ]);
    }
  });

  it("adds a suffix for repeated publications while keeping previous URLs and completion retries stable [HOST-A]", async () => {
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
    expect(replacement.siteId).not.toBe(first.siteId);
    expect(replacement.publicSlug).not.toBe(first.publicSlug);
    expect(replacement.publicSlug.startsWith(`${site}-`)).toBeTruthy();
    expect(replacement.publicSlug.slice(site.length + 1)).toMatch(
      /^[a-z0-9]{4}$/u,
    );
    expect(replacement.artifactUrl).not.toBe(first.artifactUrl);
    expect(replacement.deploymentVersion).toBe(1);
    await expect(
      api.completeHostedSite(actor, first.deploymentId),
    ).resolves.toStrictEqual(completed);

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    for (const target of [site, `dpl-${first.deploymentId}`]) {
      await expect(
        api.readHostedSiteFiles(actor, target),
      ).resolves.toMatchObject({
        deploymentId: first.deploymentId,
        artifactUrl: first.artifactUrl,
        deploymentVersion: 1,
        files: body.files,
      });
    }
    await expect(
      api.readHostedSiteFiles(actor, site, 1),
    ).resolves.toMatchObject({
      deploymentId: first.deploymentId,
    });
    await expect(
      api.readHostedSiteFiles(actor, replacement.publicSlug),
    ).resolves.toMatchObject({
      deploymentId: replacement.deploymentId,
      files: [
        expect.objectContaining({
          sha256: hostedTextFile("/index.html", "<main>updated</main>").sha256,
        }),
      ],
    });
    const history = await api.readHostedSiteDeployments(actor, site);
    expect(history.deployments).toStrictEqual([
      expect.objectContaining({
        deploymentId: first.deploymentId,
        deploymentVersion: 1,
        isActive: true,
      }),
    ]);
  });

  it("can publish the same preferred slug more times than the collision retry limit [HOST-A]", async () => {
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
    ).toBe(8);
    expect(
      new Set(
        publications.map((site) => {
          return site.deploymentId;
        }),
      ).size,
    ).toBe(8);
    expect(
      new Set(
        publications.map((site) => {
          return site.publicSlug;
        }),
      ).size,
    ).toBe(8);
    for (const publication of publications) {
      expect(publication.deploymentVersion).toBe(1);
      const history = await api.readHostedSiteDeployments(
        actor,
        publication.publicSlug,
      );
      expect(history.deployments).toStrictEqual([
        expect.objectContaining({
          deploymentId: publication.deploymentId,
          deploymentVersion: 1,
        }),
      ]);
    }
  });

  it("reserves historical hosted-site identities and creates new sites on Okou [HOST-A]", async () => {
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
      `sites/orgs/${actor.orgId}/${versioned.publicSlug}/versions/1/manifest.json`,
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
      "/assets/app.js",
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
    ).toStrictEqual(["/index.html", "/assets/app.js"]);
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "test-hosted-sites-access-key",
          secretAccessKey: "test-hosted-sites-secret-key",
        },
      }),
    );

    const missingKey = `sites/orgs/${actor.orgId}/${site}/versions/1/assets/app.js`;
    capture.missingKeys.add(missingKey);
    const notUploaded = await api.requestCompleteHostedSite(
      actor,
      first.deploymentId,
      [400],
    );
    expectApiError(notUploaded.body);
    expect(notUploaded.body.error.message).toBe(
      "Hosted deployment file was not uploaded: /assets/app.js",
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
        path: "/assets/app.js",
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
      tier: "pro-suspend",
      credits: 0,
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

  it("charges marked-up Google Maps prices across geocode, directions, places, and details [MAPS-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(admin);
    billing.configureMapsProvider();

    const geocodeRequests: URL[] = [];
    const directionsRequests: URL[] = [];
    const searchMasks: (string | null)[] = [];
    const searchBodies: unknown[] = [];
    const detailMasks: (string | null)[] = [];
    server.use(
      geocodeOkHandler(geocodeRequests),
      http.get(GOOGLE_DIRECTIONS_URL, ({ request }) => {
        directionsRequests.push(new URL(request.url));
        return HttpResponse.json({
          status: "OK",
          routes: [{ legs: [], overview_polyline: { points: "encoded" } }],
        });
      }),
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, async ({ request }) => {
        searchMasks.push(request.headers.get("x-goog-fieldmask"));
        searchBodies.push(await request.json());
        return HttpResponse.json({
          places: [{ id: "ChIJtest", displayName: { text: "Coffee" } }],
        });
      }),
      http.get(GOOGLE_PLACE_DETAILS_URL, ({ request }) => {
        detailMasks.push(request.headers.get("x-goog-fieldmask"));
        return HttpResponse.json({
          id: "ChIJtest",
          displayName: { text: "Coffee" },
        });
      }),
    );

    const before = await billing.readBillingStatus(admin);

    const geocode = await billing.requestMapsGeocode(
      admin,
      { address: "1 Infinite Loop, Cupertino", region: "US" },
      [200],
    );
    expect(geocode.body).toMatchObject({
      operation: "geocode",
      provider: "google-maps",
      billingCategory: "geocoding",
      billingQuantity: 1,
      creditsCharged: 6,
    });
    const geocodeUrl = geocodeRequests.at(0);
    expect(geocodeUrl?.searchParams.get("key")).toBe("test-google-maps-key");
    expect(geocodeUrl?.searchParams.get("address")).toBe(
      "1 Infinite Loop, Cupertino",
    );
    expect(geocodeUrl?.searchParams.get("region")).toBe("US");

    const reverse = await billing.requestMapsReverseGeocode(
      admin,
      { lat: 37.7749, lng: -122.4194 },
      [200],
    );
    expect(reverse.body).toMatchObject({
      operation: "reverse-geocode",
      billingCategory: "geocoding",
      creditsCharged: 6,
    });
    expect(geocodeRequests.at(1)?.searchParams.get("latlng")).toBe(
      "37.7749,-122.4194",
    );

    const advanced = await billing.requestMapsDirections(
      admin,
      {
        origin: "SFO",
        destination: "Mountain View",
        mode: "driving",
        departureTime: "now",
      },
      [200],
    );
    expect(advanced.body).toMatchObject({
      operation: "directions",
      billingCategory: "routes.directions.advanced",
      creditsCharged: 12,
    });
    expect(directionsRequests.at(0)?.searchParams.get("departure_time")).toBe(
      "now",
    );

    const base = await billing.requestMapsDirections(
      admin,
      { origin: "SFO", destination: "Mountain View" },
      [200],
    );
    expect(base.body).toMatchObject({
      billingCategory: "routes.directions",
      creditsCharged: 6,
    });
    expect(
      directionsRequests.at(1)?.searchParams.get("departure_time"),
    ).toBeNull();

    const proSearch = await billing.requestMapsPlacesSearch(
      admin,
      {
        query: "coffee",
        location: "37.7749,-122.4194",
        radius: 1000,
        limit: 3,
        region: "US",
      },
      [200],
    );
    expect(proSearch.body).toMatchObject({
      operation: "places.search",
      billingCategory: "places.text_search.pro",
      creditsCharged: 39,
    });
    const proMask = searchMasks.at(0) ?? "";
    expect(proMask).toContain("places.displayName");
    expect(proMask).not.toContain("places.priceLevel");
    expect(searchBodies.at(0)).toStrictEqual({
      textQuery: "coffee",
      maxResultCount: 3,
      regionCode: "US",
      locationBias: {
        circle: {
          center: { latitude: 37.7749, longitude: -122.4194 },
          radius: 1000,
        },
      },
    });

    const enterpriseSearch = await billing.requestMapsPlacesSearch(
      admin,
      { query: "coffee", limit: 3, fields: "enterprise" },
      [200],
    );
    expect(enterpriseSearch.body).toMatchObject({
      billingCategory: "places.text_search.enterprise",
      creditsCharged: 42,
    });
    expect((searchMasks.at(1) ?? "").split(",")).toStrictEqual(
      expect.arrayContaining([
        "places.displayName",
        "places.googleMapsUri",
        "places.priceLevel",
        "places.priceRange",
      ]),
    );

    const proDetails = await billing.requestMapsPlacesDetails(
      admin,
      { placeId: "places/ChIJtest", fields: "pro" },
      [200],
    );
    expect(proDetails.body).toMatchObject({
      operation: "places.details",
      billingCategory: "places.details.pro",
      creditsCharged: 21,
    });
    expect(detailMasks.at(0)).toContain("displayName");
    expect(detailMasks.at(0)).not.toContain("priceLevel");

    const enterpriseDetails = await billing.requestMapsPlacesDetails(
      admin,
      { placeId: "places/ChIJtest", fields: "enterprise" },
      [200],
    );
    expect(enterpriseDetails.body).toMatchObject({
      billingCategory: "places.details.enterprise",
      creditsCharged: 24,
    });
    expect((detailMasks.at(1) ?? "").split(",")).toStrictEqual(
      expect.arrayContaining([
        "displayName",
        "googleMapsUri",
        "priceLevel",
        "priceRange",
        "rating",
        "userRatingCount",
        "regularOpeningHours",
        "currentOpeningHours",
        "websiteUri",
        "nationalPhoneNumber",
      ]),
    );

    const settled = await billing.readBillingStatus(admin);
    expect(settled.credits).toBe(
      before.credits - (6 + 6 + 12 + 6 + 39 + 42 + 21 + 24),
    );

    server.use(
      http.get(GOOGLE_GEOCODING_URL, () => {
        return HttpResponse.json(
          { error_message: "API key quota exceeded" },
          { status: 500 },
        );
      }),
    );
    const upstreamFailure = await billing.requestMapsGeocode(
      admin,
      { address: "1 Infinite Loop, Cupertino" },
      [502],
    );
    expectApiError(upstreamFailure.body);
    expect(upstreamFailure.body.error.code).toBe("GOOGLE_MAPS_ERROR");
    expect(upstreamFailure.body.error.message).toBe("API key quota exceeded");

    const unchanged = await billing.readBillingStatus(admin);
    expect(unchanged.credits).toBe(settled.credits);

    // Complete directly because reading onboarding status grants limited-free
    // credits. Onboarded-but-unentitled orgs are gated before Google is called.
    const unentitled = bdd.user();
    const completed = await bdd.completeOnboarding(unentitled);
    expect(completed.status).toBe(200);
    expect((await billing.readBillingStatus(unentitled)).credits).toBe(0);
    const gatedSearch = await billing.requestMapsPlacesSearch(
      unentitled,
      { query: "coffee", limit: 3 },
      [402],
    );
    expectApiError(gatedSearch.body);
    expect(gatedSearch.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(searchMasks).toHaveLength(2);
  });

  it("charges OpenStreetMap download and PNG render usage [MAPS-OSM-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(admin);

    const overpassBodies: string[] = [];
    server.use(
      http.post(OPENSTREETMAP_OVERPASS_URL, async ({ request }) => {
        overpassBodies.push(await request.text());
        return HttpResponse.json({
          elements: [
            {
              type: "way",
              id: 1,
              tags: { highway: "residential" },
              geometry: [
                { lat: 37.76, lon: -122.43 },
                { lat: 37.79, lon: -122.4 },
              ],
            },
            {
              type: "way",
              id: 2,
              tags: { building: "yes" },
              geometry: [
                { lat: 37.765, lon: -122.425 },
                { lat: 37.765, lon: -122.42 },
                { lat: 37.77, lon: -122.42 },
                { lat: 37.77, lon: -122.425 },
                { lat: 37.765, lon: -122.425 },
              ],
            },
          ],
        });
      }),
    );

    const before = await billing.readBillingStatus(admin);
    const bbox = {
      west: -122.43,
      south: 37.76,
      east: -122.4,
      north: 37.79,
    };

    const download = await billing.requestMapsOsmDownload(
      admin,
      { bbox, layers: ["roads", "buildings"] },
      [200],
    );
    expect(download.body).toMatchObject({
      operation: "osm.download",
      provider: "openstreetmap",
      billingCategory: "osm.download",
      billingQuantity: 1,
      creditsCharged: 1,
      result: {
        bbox,
        layers: ["roads", "buildings"],
        attribution: "© OpenStreetMap contributors",
        featureCount: 2,
        geojson: {
          type: "FeatureCollection",
        },
      },
    });
    const downloadQuery = new URLSearchParams(overpassBodies.at(0)).get("data");
    expect(downloadQuery).toContain('way["highway"]');
    expect(downloadQuery).toContain('way["building"]');

    const render = await billing.requestMapsOsmRender(
      admin,
      {
        bbox,
        layers: ["roads", "buildings"],
        width: 640,
        height: 480,
        style: "guide",
        markers: [{ lat: 37.7749, lng: -122.4194, label: "Market" }],
      },
      [200],
    );
    expect(render.body).toMatchObject({
      operation: "osm.render",
      provider: "openstreetmap",
      billingCategory: "osm.render.png",
      billingQuantity: 1,
      creditsCharged: 2,
      result: {
        bbox,
        layers: ["roads", "buildings"],
        width: 640,
        height: 480,
        style: "guide",
        attribution: "© OpenStreetMap contributors",
        featureCount: 2,
        image: {
          mimeType: "image/png",
        },
      },
    });
    if (!("result" in render.body)) {
      throw new Error("Expected OSM render to return a maps result");
    }
    const renderResult = render.body.result as {
      readonly image?: { readonly base64?: string };
    };
    expect(typeof renderResult.image?.base64).toBe("string");
    expect(
      Buffer.from(renderResult.image?.base64 ?? "", "base64")
        .subarray(1, 4)
        .toString("utf8"),
    ).toBe("PNG");
    const renderQuery = new URLSearchParams(overpassBodies.at(1)).get("data");
    expect(renderQuery).toContain('way["highway"]');
    expect(renderQuery).toContain('way["building"]');

    const settled = await billing.readBillingStatus(admin);
    expect(settled.credits).toBe(before.credits - (1 + 2));
  });
});

describe("CHAIN-BILLING-MEDIA/FILE-01: run-scoped agent-token attribution", () => {
  it("attributes maps usage and hosted-site artifacts to a claimed run through its real agent token [HOST-B/MAPS-B]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD host maps agent",
      description: "Run-scoped maps and host attribution.",
      visibility: "private",
    });
    billing.configureMapsProvider();
    const geocodeRequests: URL[] = [];
    server.use(geocodeOkHandler(geocodeRequests));

    const created = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "attribute maps and host usage",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const poll = await runs.pollRunner(runnerGroup);
    expect(poll.body.job?.runId).toBe(created.runId);
    const claim = await runs.claimRunnerJob(created.runId);

    // The default agent compose maps OKOU_TOKEN from the run secrets, so the
    // claimed execution context exposes the real run-scoped Okou token.
    const okouToken = claim.platformEnvironment.OKOU_TOKEN;
    if (!okouToken) {
      throw new Error(
        "Expected claim.platformEnvironment.OKOU_TOKEN to carry the run-scoped Okou token",
      );
    }
    expect(okouToken).toMatch(/^vm0_sandbox_/);
    expect(claim.secretValues ?? []).toContain(okouToken);

    const before = await billing.readBillingStatus(actor);

    const geocode = await api.requestMapsGeocodeWithBearer(
      okouToken,
      { address: "1 Infinite Loop, Cupertino" },
      [200],
    );
    expect(geocode.body).toMatchObject({
      operation: "geocode",
      billingCategory: "geocoding",
      creditsCharged: 6,
    });
    expect(geocodeRequests).toHaveLength(1);

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
    expect(settled.credits).toBe(before.credits - 6);

    await runs.requestCancelRun(actor, created.runId, [200]);
    const cancelled = await runs.readRun(actor, created.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});
