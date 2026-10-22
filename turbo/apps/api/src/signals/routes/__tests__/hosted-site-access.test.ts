import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mockNow, now } from "../../../lib/time";
import { expect, test } from "vitest";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { authMeRoutes } from "../auth-me";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
    context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
      return Promise.resolve({
        isAuthenticated:
          request instanceof Request &&
          request.headers.get("Authorization") === headers.authorization,
        toAuth: () => {
          return {
            userId: user.userId,
            orgId: user.orgId,
            orgRole: user.orgRole,
            sessionId: `sess_${user.userId}`,
          };
        },
      });
    });
    context.mocks.clerk.sessions.getSession.mockImplementation((sessionId) => {
      return Promise.resolve({
        id: sessionId,
        userId: user.userId,
        status: "active",
        expireAt: now() + 86_400_000,
      });
    });
  }
  return setupAppWithRoutes({
    context,
    routes: hostRoutes,
    baseUrl: "https://api.okou.ai",
  })(hostContract);
}

async function enable(user: ApiTestUser, value = true) {
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

test("the visibility switch blocks settings while Public access and downloads remain available", async () => {
  const { owner, api, prepared, request } = await publish();
  await enable(owner, false);
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
  await enable(owner);
  const enabledFiles = await api.requestHostedSiteFiles(
    owner,
    `dpl-${prepared.deploymentId}`,
    [200],
  );
  if (enabledFiles.status !== 200) {
    throw new Error("Expected hosted download files");
  }
  expect(enabledFiles.body.files[0]!.downloadUrl).not.toContain(
    "/.okou/download/",
  );
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

async function authorizeBrowser(
  user: ApiTestUser,
  siteId: string,
  origin: string,
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const result = await accept(
    client(user).authorizeSiteSession({
      headers,
      params: { siteId },
      body: {
        origin,
        state,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      },
    }),
    [200],
  );
  const callback = new URL(result.body.callbackUrl);
  expect(callback.origin).toBe(origin);
  expect(callback.pathname).toBe("/.okou/auth/callback");
  expect(callback.searchParams.get("state")).toBe(state);
  return {
    origin,
    code: callback.searchParams.get("code")!,
    codeVerifier: verifier,
  };
}

async function browserHeaders(
  user: ApiTestUser,
  siteId: string,
  origin: string,
) {
  const body = await authorizeBrowser(user, siteId, origin);
  const exchanged = await accept(
    client().exchangeSiteSession({ params: { siteId }, body }),
    [200],
  );
  expect(exchanged.body.sessionToken).toMatch(/^okou_site_[a-f0-9]{64}$/u);
  return { authorization: `Bearer ${exchanged.body.sessionToken}` };
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
  const origin = `https://${prepared.publicSlug}.okou.app`;
  const otherSession = await browserHeaders(other, prepared.siteId, origin);
  const ownerSession = await browserHeaders(owner, prepared.siteId, origin);
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
        client(other).deliveryAuthorization({
          ...request,
          headers: otherSession,
        }),
        [200],
      )
    ).body.decision,
  ).toBe("deny");
  expect(
    (
      await accept(
        client(owner).deliveryAuthorization({
          ...request,
          headers: ownerSession,
        }),
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
  const viewerSession = await browserHeaders(
    viewer,
    prepared.siteId,
    `https://${prepared.publicSlug}.okou.app`,
  );
  expect(
    (
      await accept(
        client(viewer).deliveryAuthorization({
          ...request,
          headers: viewerSession,
        }),
        [200],
      )
    ).body.allowed,
  ).toBeTruthy();
  const previewRequest = {
    headers,
    params: { publicSlug: prepared.publicSlug },
    query: { hostname: `${prepared.publicSlug}.okou.app` },
  };
  const preview = await accept(
    client(viewer).sitePreview(previewRequest),
    [200],
  );
  expect(preview.body.expiresAt).not.toBeNull();
  member = false;
  await accept(client(viewer).sitePreview(previewRequest), [404]);
  expect(
    (
      await accept(
        client(viewer).deliveryAuthorization({
          ...request,
          headers: viewerSession,
        }),
        [200],
      )
    ).body.decision,
  ).toBe("deny");
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
    new Error("Membership service unavailable"),
  );
  await accept(
    client(viewer).deliveryAuthorization({
      ...request,
      headers: viewerSession,
    }),
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
  const policy = await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "public", expectedRevision: null },
    }),
    [200],
  );
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
      body: { visibility: "private", expectedRevision: policy.body.revision },
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

test("disabling visibility settings preserves Private policy and browser authorization", async () => {
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
  await enable(owner, false);
  expect(
    (
      await accept(
        client().siteAccess({
          params: { siteId: prepared.siteId },
          query: { origin: `https://${prepared.publicSlug}.okou.app` },
        }),
        [200],
      )
    ).body.decision,
  ).toBe("authenticate");
  await authorizeBrowser(
    owner,
    prepared.siteId,
    `https://${prepared.publicSlug}.okou.app`,
  );
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "public", expectedRevision: null },
    }),
    [403],
  );
});

test("authorization codes require the correct proof, Site and origin, and are single-use", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const params = { siteId: prepared.siteId };
  const body = await authorizeBrowser(
    owner,
    prepared.siteId,
    `https://${prepared.publicSlug}.okou.app`,
  );
  await accept(
    client().exchangeSiteSession({
      params,
      body: { ...body, codeVerifier: "a".repeat(43) },
    }),
    [401],
  );
  await accept(
    client().exchangeSiteSession({
      params,
      body: { ...body, origin: "https://other.okou.app" },
    }),
    [401],
  );
  await accept(
    client().exchangeSiteSession({ params: { siteId: randomUUID() }, body }),
    [401],
  );
  const results = await Promise.all([
    client().exchangeSiteSession({ params, body }),
    client().exchangeSiteSession({ params, body }),
  ]);
  expect(
    results
      .map((result) => {
        return result.status;
      })
      .sort(),
  ).toStrictEqual([200, 401]);
  await accept(client().exchangeSiteSession({ params, body }), [401]);
});

test("expired authorization codes cannot be exchanged", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const start = now();
  mockNow(start);
  const body = await authorizeBrowser(
    owner,
    prepared.siteId,
    `https://${prepared.publicSlug}.okou.app`,
  );
  mockNow(start + 121_000);
  const response = await accept(
    client().exchangeSiteSession({ params: { siteId: prepared.siteId }, body }),
    [401],
  );
  expect(response.body.error.code).toBe("UNAUTHORIZED");
});

test("site sessions survive 60 seconds without a Clerk JWT and stop after primary revocation", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const params = { siteId: prepared.siteId };
  const origin = `https://${prepared.publicSlug}.okou.app`;
  const siteHeaders = await browserHeaders(owner, prepared.siteId, origin);
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params,
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  await accept(
    setupAppWithRoutes({ context, routes: authMeRoutes })(authContract).me({
      headers: siteHeaders,
    }),
    [401],
  );
  mockNow(now() + 61_000);
  expect(
    (
      await accept(
        client().siteAccess({
          headers: siteHeaders,
          params,
          query: { origin },
        }),
        [200],
      )
    ).body.decision,
  ).toBe("allow");
  expect(
    (
      await accept(
        client().siteAccess({
          headers: siteHeaders,
          params,
          query: { origin: "https://sibling.okou.app" },
        }),
        [200],
      )
    ).body.decision,
  ).toBe("authenticate");
  expect(
    (
      await accept(
        client(owner).siteAccess({ headers, params, query: { origin } }),
        [200],
      )
    ).body.decision,
  ).toBe("authenticate");
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: `sess_${owner.userId}`,
    userId: owner.userId,
    status: "revoked",
    expireAt: now() + 86_400_000,
  });
  expect(
    (
      await accept(
        client().siteAccess({
          headers: siteHeaders,
          params,
          query: { origin },
        }),
        [200],
      )
    ).body.decision,
  ).toBe("authenticate");
});

test("pending sessions and untrusted return origins cannot mint site authorization codes", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const api = client(owner);
  const input = {
    headers,
    params: { siteId: prepared.siteId },
    body: {
      origin: `https://${prepared.publicSlug}.okou.app`,
      state: "a".repeat(43),
      codeChallenge: "b".repeat(43),
    },
  };
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: `sess_${owner.userId}`,
    userId: owner.userId,
    status: "pending",
    expireAt: now() + 86_400_000,
  });
  const response = await accept(api.authorizeSiteSession(input), [401]);
  expect(response.body.error.code).toBe("UNAUTHORIZED");
  await accept(
    api.authorizeSiteSession({
      ...input,
      body: { ...input.body, origin: "https://attacker.example" },
    }),
    [403],
  );
});

test("one publisher cannot redirect another Site's authorization to its own origin", async () => {
  const { owner, api, input, prepared } = await publish();
  await enable(owner);
  const other = await api.prepareHostedSite(owner, {
    ...input,
    site: `other-${randomUUID().slice(0, 8)}`,
  });
  await api.completeHostedSite(owner, other.deploymentId);
  await accept(
    client(owner).authorizeSiteSession({
      headers,
      params: { siteId: prepared.siteId },
      body: {
        origin: `https://${other.publicSlug}.okou.app`,
        state: "a".repeat(43),
        codeChallenge: "b".repeat(43),
      },
    }),
    [403],
  );
  const origin = `https://dpl-${prepared.deploymentId}.okou.app`;
  const session = await browserHeaders(owner, prepared.siteId, origin);
  await accept(
    client(owner).updateSiteVisibility({
      headers,
      params: { siteId: prepared.siteId },
      body: { visibility: "private", expectedRevision: null },
    }),
    [200],
  );
  expect(
    (
      await accept(
        client().siteAccess({
          headers: session,
          params: { siteId: prepared.siteId },
          query: { origin },
        }),
        [200],
      )
    ).body.decision,
  ).toBe("allow");
});

test("the App bridge rejects a Clerk JWT issued to an untrusted hosted origin", async () => {
  const { owner, prepared } = await publish();
  await enable(owner);
  const api = client(owner);
  const origin = `https://${prepared.publicSlug}.okou.app`;
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (_request, options) => {
      const parties =
        typeof options === "object" &&
        options !== null &&
        "authorizedParties" in options &&
        Array.isArray(options.authorizedParties)
          ? options.authorizedParties
          : null;
      return Promise.resolve({
        isAuthenticated: parties === null || parties.includes(origin),
        toAuth: () => {
          return {
            userId: owner.userId,
            sessionId: `sess_${owner.userId}`,
          };
        },
      });
    },
  );
  const response = await accept(
    api.authorizeSiteSession({
      headers,
      params: { siteId: prepared.siteId },
      body: {
        origin,
        state: "a".repeat(43),
        codeChallenge: "b".repeat(43),
      },
    }),
    [401],
  );
  expect(response.body.error.code).toBe("UNAUTHORIZED");
});

test.each([
  "https://demo.okou.app",
  "https://demo.okou.app.",
  "https://demo.sites.example.com",
])(
  "general API endpoints reject verified Clerk credentials from %s",
  async (origin) => {
    const { owner } = await publish();
    client(owner);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: owner.userId,
          orgId: owner.orgId,
          sessionId: `sess_${owner.userId}`,
          sessionClaims: { azp: origin },
        };
      },
    });
    const response = await accept(
      setupAppWithRoutes({ context, routes: authMeRoutes })(authContract).me({
        headers,
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  },
);

test("restricted previews reuse private-artifact credentials only after current access checks", async () => {
  mockNow(Date.parse("2026-10-22T00:00:00Z"));
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
  await enable(owner, false);
  const request = {
    headers,
    params: { publicSlug: prepared.publicSlug },
    query: { hostname: `${prepared.publicSlug}.okou.app` },
  };
  const issuedAt = now();
  const first = await accept(client(owner).sitePreview(request), [200]);
  expect(first.body.url).toMatch(/^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/u);
  expect(Date.parse(first.body.expiresAt!) - issuedAt).toBe(
    48 * 60 * 60 * 1000,
  );
  const repeated = await accept(client(owner).sitePreview(request), [200]);
  expect(repeated.body).toStrictEqual(first.body);
  const outsider = createBddApi(context).user();
  await accept(client(outsider).sitePreview(request), [404]);
  await accept(
    client(owner).sitePreview({
      ...request,
      query: { hostname: "unrelated.okou.app" },
    }),
    [404],
  );
  const invalidDeployment = `dpl-${"-".repeat(35)}a`;
  await accept(
    client(owner).sitePreview({
      ...request,
      params: { publicSlug: invalidDeployment },
      query: { hostname: `${invalidDeployment}.okou.app` },
    }),
    [404],
  );
  const immutable = await accept(
    client(owner).sitePreview({
      ...request,
      params: { publicSlug: `dpl-${prepared.deploymentId}` },
      query: { hostname: `dpl-${prepared.deploymentId}.okou.app` },
    }),
    [200],
  );
  expect(immutable.body).toStrictEqual(first.body);

  mockNow(issuedAt + 47 * 60 * 60 * 1000 - 1);
  expect(
    (await accept(client(owner).sitePreview(request), [200])).body,
  ).toStrictEqual(first.body);
  mockNow(issuedAt + 47 * 60 * 60 * 1000);
  const renewed = await accept(client(owner).sitePreview(request), [200]);
  expect(renewed.body.url).not.toBe(first.body.url);
  expect(Date.parse(renewed.body.expiresAt!) - now()).toBe(48 * 60 * 60 * 1000);
});

test("public previews keep anonymous addresses without a temporary capability", async () => {
  const { owner, prepared } = await publish();
  const result = await accept(
    client(owner).sitePreview({
      headers,
      params: { publicSlug: prepared.publicSlug },
      query: { hostname: `${prepared.publicSlug}.okou.app` },
    }),
    [200],
  );
  expect(result.body).toStrictEqual({
    url: `https://${prepared.publicSlug}.okou.app/`,
    expiresAt: null,
  });
  const stranger = createBddApi(context).user();
  expect(
    (
      await accept(
        client(stranger).sitePreview({
          headers,
          params: { publicSlug: prepared.publicSlug },
          query: { hostname: `${prepared.publicSlug}.okou.app` },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual(result.body);
});
