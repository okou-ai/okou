import { publicChatActor } from "./helpers/public-chat-actor";
import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createMapsBillingApi } from "./helpers/api-bdd-maps-billing";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
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
  it("preserves history and aliases across out-of-order completion [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    const capture = api.captureHostedSitesS3();
    const site = `publication-history-${randomUUID().slice(0, 8)}`;
    const files = [hostedTextFile("/index.html", "<main>published</main>")];
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files,
    };
    const first = await api.prepareHostedSite(actor, body);
    const second = await api.prepareHostedSite(actor, body);
    expect(second.siteId).toBe(first.siteId);
    expect(first.deploymentVersion).toBe(1);
    expect(second.deploymentVersion).toBe(2);
    await api.completeHostedSite(actor, second.deploymentId);
    const completedFirst = await api.completeHostedSite(
      actor,
      first.deploymentId,
    );
    expect(completedFirst).toMatchObject({
      deploymentId: first.deploymentId,
      isActive: false,
      activeDeploymentVersion: 2,
    });
    await expect(api.readHostedSiteFiles(actor, site)).resolves.toMatchObject({
      deploymentId: second.deploymentId,
    });
    for (const deployment of [first, second]) {
      for (const target of [site, `dpl-${deployment.deploymentId}`]) {
        await expect(
          api.readHostedSiteFiles(actor, target, deployment.deploymentVersion),
        ).resolves.toMatchObject({
          deploymentId: deployment.deploymentId,
          artifactUrl: deployment.artifactUrl,
          files,
        });
      }
      expect(capture.puts).toContainEqual(
        expect.objectContaining({
          key: `sites/brands/okou/publications/${deployment.deploymentId}/manifest.json`,
        }),
      );
    }
    const listed = await api.readHostedSiteDeployments(actor, site);
    expect(listed.deployments).toHaveLength(2);
    expect(listed.activeDeploymentId).toBe(second.deploymentId);
  });

  it("refuses completion by another member of the owner's organization", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    api.captureHostedSitesS3();
    const prepared = await api.prepareHostedSite(actor, {
      site: `owned-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>owned</main>")],
    });
    const member = bdd.user({ orgId: actor.orgId });
    await api.requestCompleteHostedSite(member, prepared.deploymentId, [404]);
    await expect(
      api.completeHostedSite(actor, prepared.deploymentId),
    ).resolves.toMatchObject({ isActive: true });
  });

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

  it("publishes browser and claimed Runner sites in the current layout [HOST-A]", async () => {
    mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
    mockEnv("ZERO_HOST_DOMAIN", "sites.vm0.io");
    mockEnv("OKOU_HOST_SCHEME", "https");
    mockEnv("ZERO_HOST_SCHEME", "https");
    const api = createHostMapsBddApi(context);
    const fixture = createChatEventsFixture(context);
    const entitled = await fixture.entitledNativeChatActor();
    const actor = entitled.actor;
    const capture = api.captureHostedSitesS3();

    const browserOkouSite = `bdd-browser-okou-${randomUUID().slice(0, 8)}`;
    const createdOnOkou = await api.prepareHostedSite(actor, {
      site: browserOkouSite,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Browser site</main>")],
    });
    expect(createdOnOkou.url).toBe(`https://${browserOkouSite}.okou.app`);

    const run = await fixture.sendChatRun(actor, {
      agentId: entitled.agentId,
      prompt: "Publish a hosted site from the Runner",
    });
    const { claim } = await fixture.claimChatRun(
      entitled.runnerGroup,
      run.runId,
    );
    const okouToken = okouTokenFromClaim(claim);
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
    await bdd.completeOnboarding(actor);
    const capture = api.captureHostedSitesS3();
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
    const requestedSites = [site, `${site}-pending`];
    const hostedSitesResponder = context.mocks.s3.send.getMockImplementation();
    if (!hostedSitesResponder) {
      throw new Error("Expected hosted site S3 boundary");
    }
    const hostedSiteEnvironment = [
      ["R2_HOSTED_SITES_BUCKET_NAME", env("R2_HOSTED_SITES_BUCKET_NAME")],
      ["R2_HOSTED_SITES_ACCESS_KEY_ID", env("R2_HOSTED_SITES_ACCESS_KEY_ID")],
      [
        "R2_HOSTED_SITES_SECRET_ACCESS_KEY",
        env("R2_HOSTED_SITES_SECRET_ACCESS_KEY"),
      ],
      ["OKOU_PUBLIC_HOST_DOMAIN", env("OKOU_PUBLIC_HOST_DOMAIN")],
      ["OKOU_HOST_SCHEME", env("OKOU_HOST_SCHEME")],
      ["ZERO_HOST_DOMAIN", env("ZERO_HOST_DOMAIN")],
      ["ZERO_HOST_SCHEME", env("ZERO_HOST_SCHEME")],
    ] as const;
    const fixture = createPublicUnfundedProFixture(context, actor, {
      async beforeOrganizationCleanup() {
        for (const [name, value] of hostedSiteEnvironment) {
          mockEnv(name, value);
        }
        capture.missingKeys.clear();
        context.mocks.s3.send.mockImplementation(hostedSitesResponder);
        // Registered names also find a prepare that committed without a response.
        for (const requestedSite of requestedSites) {
          const history = await api.requestHostedSiteDeployments(
            actor,
            requestedSite,
            [200, 404],
          );
          if (history.status === 200) {
            await api.deleteHostedSite(actor, history.body.publicSlug);
          }
        }
        // Public deletion retires serving pointers; deployment history is retained.
        await flushWaitUntilForTest();
      },
    });
    await fixture.run(async () => {
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
      await fixture.initialize();
      await fixture.suspend();
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
      model: "gemini-3.1-flash-lite",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 14_100,
      providerCostUsd: 0.0141,
      creditsCharged: 18,
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
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        mapsQueries: 1,
      },
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
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 2048,
      },
    });
    const serializedProviderBody = JSON.stringify(providerBody);
    expect(serializedProviderBody).not.toContain("apiKey");
    expect(serializedProviderBody).toContain(
      "No implicit user location is available",
    );
    expect(serializedProviderBody).toContain(
      "The user explicitly supplied latitude 48.21 and longitude 16.37",
    );
    expect(serializedProviderBody).toContain(
      "Do not assist with high-risk uses of maps",
    );
    expect(providerCalls).toBe(1);

    const settled = await billing.readBillingStatus(admin);
    expect(settled.credits).toBe(before.credits - 18);

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

  it.each(["content-length", "streamed body"] as const)(
    "explains an oversized Maps response detected by %s without charging credits [MAPS-A]",
    async (sizeDetection) => {
      const bdd = createBddApi(context);
      const billing = createMapsBillingApi(context);
      const runs = createRunsApi(context);
      const admin = bdd.user();
      bdd.acceptAgentStorageWrites();
      await runs.grantProEntitlement(admin);
      billing.configureMapsProvider();

      const providerBody = await vertexMapsResponse({
        answer: "private-provider-answer",
      }).text();
      const bytes = new TextEncoder().encode(
        providerBody.padEnd(512 * 1024 + 1),
      );
      server.use(
        http.post(VERTEX_MAPS_URL, () => {
          if (sizeDetection === "content-length") {
            return new HttpResponse(bytes, {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": String(bytes.byteLength),
              },
            });
          }
          return new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 512 * 1024));
                controller.enqueue(bytes.subarray(512 * 1024));
                controller.close();
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }),
      );

      const before = await billing.readBillingStatus(admin);
      const search = await billing.requestMapsSearch(
        admin,
        { query: "coffee near Union Square" },
        [502],
      );
      expect(search.headers.get("cache-control")).toBe("private, no-store");
      expect(search.body).toStrictEqual({
        error: {
          code: "MAPS_RESPONSE_TOO_LARGE",
          message:
            "Google Maps grounding response exceeded Okou's response size limit. Narrow the search area, request fewer places, or split the query before trying again.",
        },
      });
      expect((await billing.readBillingStatus(admin)).credits).toBe(
        before.credits,
      );
    },
  );

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
    const api = createHostMapsBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const owned = await publicChatActor(context);
    const { actor, agentId, runnerGroup } = owned;
    await owned.run(() => {
      return runs.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    billing.configureMapsProvider();
    let mapsRequests = 0;
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        mapsRequests += 1;
        return vertexMapsResponse();
      }),
    );

    const created = await owned.sendChatRun(actor, {
      agentId,
      prompt: "attribute maps and host usage",
    });
    const { claim } = await owned.claimChatRun(runnerGroup, created.runId);
    await owned.run(async () => {
      const okouToken = claim.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected a claimed agent token");
      }
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
        billingQuantity: 14_100,
        creditsCharged: 18,
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
      expect(settled.credits).toBe(before.credits - 18);
    });
  });
});
