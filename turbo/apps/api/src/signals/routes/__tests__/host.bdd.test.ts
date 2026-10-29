import { publicChatActor } from "./helpers/public-chat-actor";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";

/* Host deployments and run-token attribution through public APIs. Provider
 * routing and billing behavior live in Okou Data Router's MCP tests. */

const context = testContext();

describe("FILE-01: hosted-site deployments through host APIs", () => {
  it("preserves history and aliases across out-of-order completion [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostBddApi(context);
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
    const api = createHostBddApi(context);
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

  it("gives concurrent publications distinct versions after resubmitting allocation conflicts [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostBddApi(context);
    const actor = bdd.user();
    api.captureHostedSitesS3();
    const body = {
      site: `bdd-concurrent-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>concurrent</main>")],
    };
    const attempts = await Promise.all(
      Array.from({ length: 3 }, async () => {
        return await api.requestPrepareHostedSite(actor, body, [200, 409]);
      }),
    );
    const results = [];
    for (const attempt of attempts) {
      if (attempt.status === 200) {
        results.push(attempt.body);
      } else {
        expectApiError(attempt.body);
        expect(attempt.body.error.message).toBe(
          "Hosted site allocation changed. Retry publishing the same site.",
        );
        results.push(await api.prepareHostedSite(actor, body));
      }
    }
    expect(
      new Set(
        results.map((result) => {
          return result.siteId;
        }),
      ).size,
    ).toBe(1);
    for (const result of results) {
      expect(result.publicSlug).toBe(body.site);
      expect(result.visibility).toBe("private");
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
    const api = createHostBddApi(context);
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
    const api = createHostBddApi(context);
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
    const api = createHostBddApi(context);
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
  });

  it("adds a four-character hash only when the simple alias is already occupied [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostBddApi(context);
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
    const api = createHostBddApi(context);
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
        visibility: "public" as const,
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
          };
        }),
      ).toStrictEqual([
        {
          path: "/assets/app-4f3a9c12.js",
          size: scriptFile.size,
          contentType: "application/javascript",
        },
        {
          path: "/index.html",
          size: indexFile.size,
          contentType: "text/html; charset=utf-8",
        },
      ]);

      const outsider = bdd.user();
      const crossOrg = await api.requestHostedSiteFiles(
        outsider,
        first.publicSlug,
        [200],
      );
      expect(crossOrg.body).toMatchObject({
        ...listed,
        files: listed.files.map((file) => {
          return { ...file, downloadUrl: expect.any(String) };
        }),
      });
      if (crossOrg.status !== 200) {
        throw new Error("Expected public site files");
      }
      for (const file of crossOrg.body.files) {
        const url = new URL(file.downloadUrl);
        expect(url.hostname).toBe(`dpl-${first.deploymentId}.okou.app`);
        expect(url.pathname).toMatch(/^\/\.okou\/download\//u);
        expect(url.searchParams.get("path")).toBe(file.path);
      }

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

  it("rejects unauthenticated prepares [HOST-D]", async () => {
    const api = createHostBddApi(context);
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
  });
});

describe("CHAIN-BILLING-MEDIA/FILE-01: run-scoped agent-token attribution", () => {
  it("attributes hosted-site artifacts through a run-scoped token [HOST-B]", async () => {
    const api = createHostBddApi(context);
    const runs = createRunsApi(context);
    const owned = await publicChatActor(context);
    const { actor, agentId, runnerGroup } = owned;
    await owned.run(() => {
      return runs.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const created = await owned.sendChatRun(actor, {
      agentId,
      prompt: "attribute hosted-site artifacts",
    });
    const { claim } = await owned.claimChatRun(runnerGroup, created.runId);
    await owned.run(async () => {
      const okouToken = claim.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected a claimed agent token");
      }
      expect(okouToken).toMatch(/^vm0_sandbox_/);

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
    });
  });
});
