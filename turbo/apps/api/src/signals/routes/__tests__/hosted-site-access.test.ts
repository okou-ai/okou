import { createHash, randomBytes, randomUUID } from "node:crypto";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { HostedSiteVisibility } from "@okouai/api-contracts/contracts/hosted-site-access";
import { describe, expect, it } from "vitest";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { artifactAccessRoutes } from "../artifact-access";
import { artifactOgRoutes } from "../artifact-og";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

function hostApi() {
  return setupApp({ context, routes: hostRoutes })(hostContract);
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

/** A real App browser session: Clerk reports a live session id for the user. */
function signInWithAppSession(actor: ApiTestUser) {
  const sessionId = `sess_${actor.userId}`;
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId: actor.userId,
        orgId: actor.orgId,
        orgRole: actor.orgRole,
        sessionId,
      };
    },
  });
  context.mocks.clerk.sessions.getSession.mockImplementation((id) => {
    return Promise.resolve({
      id,
      userId: String(id).slice("sess_".length),
      status: "active",
      expireAt: Date.parse("2100-01-01T00:00:00Z"),
    });
  });
  return { authorization: "Bearer clerk-session" };
}

function anonymous() {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  return {};
}

function htmlFile(content: string) {
  return {
    path: "/index.html",
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

interface Storage {
  readonly puts: readonly { readonly key: string; readonly body: string }[];
}

interface Published {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly publicSlug: string;
  readonly site: string;
  readonly visibility: HostedSiteVisibility | undefined;
}

async function publishSite(
  owner: ApiTestUser,
  options: {
    readonly site?: string;
    readonly visibility?: HostedSiteVisibility;
    readonly content?: string;
  } = {},
): Promise<Published> {
  const site = options.site ?? `site-${randomUUID().slice(0, 8)}`;
  const prepared = await host.prepareHostedSite(owner, {
    site,
    title: "Hosted page",
    ...(options.visibility ? { visibility: options.visibility } : {}),
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [htmlFile(options.content ?? "<h1>Hello</h1>")],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);
  return {
    siteId: prepared.siteId,
    deploymentId: prepared.deploymentId,
    publicSlug: prepared.publicSlug,
    site,
    visibility: prepared.visibility,
  };
}

/** The delivery pointer the Worker reads from hosted-sites storage. */
function deliveryPointer(storage: Storage, deploymentId: string) {
  for (const put of storage.puts) {
    if (!put.key.endsWith(".json")) {
      continue;
    }
    const parsed: unknown = JSON.parse(put.body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "deploymentId" in parsed &&
      parsed.deploymentId === deploymentId &&
      "prefix" in parsed &&
      typeof parsed.prefix === "string" &&
      "manifestKey" in parsed &&
      typeof parsed.manifestKey === "string" &&
      "publicSlug" in parsed &&
      typeof parsed.publicSlug === "string"
    ) {
      return {
        prefix: parsed.prefix,
        manifestKey: parsed.manifestKey,
        publicSlug: parsed.publicSlug,
      };
    }
  }
  throw new Error(`Expected a delivery pointer for ${deploymentId}`);
}

interface DeliveryOptions {
  readonly alias?: string;
  readonly deploymentId?: string;
  readonly presentation?: "banner";
  readonly publicBrand?: "okou" | "vm0";
  readonly sessionToken?: string;
}

function deliveryRequest(
  storage: Storage,
  site: Published,
  options: DeliveryOptions = {},
) {
  const deploymentId = options.deploymentId ?? site.deploymentId;
  const pointer = deliveryPointer(storage, deploymentId);
  return hostApi().deliveryAuthorization({
    headers: options.sessionToken
      ? (anonymous(), { authorization: `Bearer ${options.sessionToken}` })
      : anonymous(),
    params: { siteId: site.siteId, deploymentId },
    query: {
      alias: options.alias ?? site.publicSlug,
      publicSlug: pointer.publicSlug,
      publicBrand: options.publicBrand ?? "okou",
      prefix: pointer.prefix,
      manifestKey: pointer.manifestKey,
      ...(options.presentation ? { presentation: options.presentation } : {}),
    },
  });
}

async function deliveryDecision(
  storage: Storage,
  site: Published,
  options: DeliveryOptions = {},
) {
  const response = await accept(deliveryRequest(storage, site, options), [200]);
  return response.body;
}

async function proOwner() {
  const owner = bdd.user();
  await publicPlanLifecycle(context, owner, "pro").update("active");
  return owner;
}

/** The owner's download URL for `/index.html` of an immutable deployment. */
async function indexDownloadUrl(owner: ApiTestUser, deploymentId: string) {
  const listed = await host.readHostedSiteFiles(owner, `dpl-${deploymentId}`);
  const index = listed.files.find((file) => {
    return file.path === "/index.html";
  });
  if (!index) {
    throw new Error("Expected /index.html in the listed files");
  }
  return new URL(index.downloadUrl);
}

async function redeemDownload(
  downloadUrl: URL,
  deploymentId: string,
  path = "/index.html",
) {
  const token = downloadUrl.pathname.split("/").at(-1) ?? "";
  const response = await accept(
    hostApi().downloadAuthorization({
      params: { token },
      query: { deploymentId, path },
    }),
    [200],
  );
  return response.body.file;
}

function clerkLists(orgId: string, members: readonly string[]) {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: members.map((userId) => {
        return {
          role: "org:member",
          organization: { id: orgId },
          publicUserData: { userId },
        };
      }),
      totalCount: members.length,
    },
  );
}

async function anonymousAccess(site: Published) {
  const response = await accept(
    hostApi().siteAccess({
      headers: anonymous(),
      params: { siteId: site.siteId },
      query: { origin: `https://${site.publicSlug}.okou.app` },
    }),
    [200],
  );
  return response.body;
}

function accessApi() {
  return setupApp({ context, routes: artifactAccessRoutes })(
    artifactAccessContract,
  );
}

async function readVisibility(owner: ApiTestUser, siteId: string) {
  const response = await accept(
    accessApi().getVisibility({
      headers: signIn(owner),
      params: { artifactId: siteId },
    }),
    [200],
  );
  return response.body;
}

async function setVisibility(
  owner: ApiTestUser,
  siteId: string,
  visibility: HostedSiteVisibility,
) {
  const response = await accept(
    accessApi().updateVisibility({
      headers: signIn(owner),
      params: { artifactId: siteId },
      body: { visibility },
    }),
    [200],
  );
  return response.body;
}

async function makePrivate(owner: ApiTestUser, siteId: string) {
  return await setVisibility(owner, siteId, "private");
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

async function authorizationCode(viewer: ApiTestUser, site: Published) {
  const proof = pkce();
  const origin = `https://${site.publicSlug}.okou.app`;
  const authorized = await accept(
    hostApi().authorizeSiteSession({
      headers: signInWithAppSession(viewer),
      params: { siteId: site.siteId },
      body: { origin, codeChallenge: proof.challenge, state: proof.state },
    }),
    [200],
  );
  const callback = new URL(authorized.body.callbackUrl);
  expect(callback.origin).toBe(origin);
  expect(callback.pathname).toBe("/.okou/auth/callback");
  expect(callback.searchParams.get("state")).toBe(proof.state);
  return {
    code: callback.searchParams.get("code") ?? "",
    origin,
    verifier: proof.verifier,
  };
}

async function siteSession(viewer: ApiTestUser, site: Published) {
  const grant = await authorizationCode(viewer, site);
  const exchanged = await accept(
    hostApi().exchangeSiteSession({
      headers: anonymous(),
      params: { siteId: site.siteId },
      body: {
        origin: grant.origin,
        code: grant.code,
        codeVerifier: grant.verifier,
      },
    }),
    [200],
  );
  expect(exchanged.body.sessionToken).toMatch(/^okou_site_[a-f0-9]{64}$/u);
  return exchanged.body.sessionToken;
}

describe("hosted site access", () => {
  it("hosted-site-access-001 creates a private site when visibility is omitted", async () => {
    host.captureHostedSitesS3();
    const member = bdd.user();
    const prepared = await host.prepareHostedSite(member, {
      site: `site-${randomUUID().slice(0, 8)}`,
      title: "Hosted page",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>Hello</h1>")],
    });
    expect(prepared.visibility).toBe("private");
    const site = {
      siteId: prepared.siteId,
      deploymentId: prepared.deploymentId,
      publicSlug: prepared.publicSlug,
      site: "",
      visibility: prepared.visibility,
    };
    await expect(anonymousAccess(site)).resolves.toMatchObject({
      decision: "authenticate",
    });
    await host.completeHostedSite(member, prepared.deploymentId);

    const current = await readVisibility(member, prepared.siteId);
    expect(current.visibility).toBe("private");
    await expect(
      setVisibility(member, prepared.siteId, "public"),
    ).resolves.toMatchObject({ visibility: "public" });
  });

  it("hosted-site-access-004 creates a public site when public visibility is requested", async () => {
    host.captureHostedSitesS3();
    const member = bdd.user();
    const prepared = await host.prepareHostedSite(member, {
      site: `site-${randomUUID().slice(0, 8)}`,
      title: "Hosted page",
      visibility: "public",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>Hello</h1>")],
    });
    expect(prepared.visibility).toBe("public");
    const site = {
      siteId: prepared.siteId,
      deploymentId: prepared.deploymentId,
      publicSlug: prepared.publicSlug,
      site: "",
      visibility: prepared.visibility,
    };
    await expect(anonymousAccess(site)).resolves.toMatchObject({
      decision: "allow",
    });
    await host.completeHostedSite(member, prepared.deploymentId);

    const current = await readVisibility(member, prepared.siteId);
    expect(current.visibility).toBe("public");
    await expect(
      setVisibility(member, prepared.siteId, "public"),
    ).resolves.toMatchObject({ visibility: "public" });
  });

  it("hosted-site-access-005 keeps a public site public across a redeployment", async () => {
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const first = await publishSite(owner, { visibility: "public" });

    const redeployed = await host.prepareHostedSite(owner, {
      site: first.site,
      title: "Hosted page",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>Updated</h1>")],
    });
    await host.completeHostedSite(owner, redeployed.deploymentId);

    expect(redeployed.visibility).toBe("public");
    await expect(anonymousAccess(first)).resolves.toMatchObject({
      decision: "allow",
    });
  });

  it("hosted-site-access-008 hides banner management from other members and presentation from anonymous viewers", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = bdd.user();
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const site = await publishSite(owner, { visibility: "public" });

    await accept(
      hostApi().siteBanner({
        headers: signIn(peer),
        params: { siteId: site.siteId },
      }),
      [404],
    );
    await accept(
      hostApi().updateSiteBanner({
        headers: signIn(peer),
        params: { siteId: site.siteId },
        body: { showBanner: false, expectedRevision: null },
      }),
      [404],
    );
    await makePrivate(owner, site.siteId);

    await expect(
      deliveryDecision(storage, site, { presentation: "banner" }),
    ).resolves.toStrictEqual({ allowed: false, decision: "authenticate" });
    await expect(deliveryDecision(storage, site)).resolves.toMatchObject({
      decision: "authenticate",
    });
  });

  it("hosted-site-access-012 keeps an explicit private policy for immutable addresses after redeployment", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = bdd.user();
    const first = await publishSite(owner, { visibility: "public" });
    await makePrivate(owner, first.siteId);

    const redeployed = await host.prepareHostedSite(owner, {
      site: first.site,
      title: "Hosted page",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [htmlFile("<h1>Updated</h1>")],
    });
    await host.completeHostedSite(owner, redeployed.deploymentId);

    await expect(
      deliveryDecision(storage, first, {
        alias: `dpl-${first.deploymentId}`,
      }),
    ).resolves.toMatchObject({ decision: "authenticate" });
    await expect(readVisibility(owner, first.siteId)).resolves.toMatchObject({
      visibility: "private",
    });
  });

  it("hosted-site-access-016 stops anonymous OG metadata once a site becomes private", async () => {
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const site = await publishSite(owner, { visibility: "public" });
    const og = setupApp({ context, routes: artifactOgRoutes })(
      artifactOgContract,
    );

    const before = await accept(
      og.metadata({ query: { kind: "host", id: site.deploymentId } }),
      [200],
    );
    expect(before.body.available).toBeTruthy();
    await makePrivate(owner, site.siteId);
    const after = await accept(
      og.metadata({ query: { kind: "host", id: site.deploymentId } }),
      [200],
    );
    expect(after.body.available).toBeFalsy();
  });

  it("hosted-site-access-028 gives owners a preview capability and strangers the public address", async () => {
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const stranger = bdd.user();
    const site = await publishSite(owner, { visibility: "public" });
    const hostname = `${site.publicSlug}.okou.app`;

    const ownerPreview = await accept(
      hostApi().sitePreview({
        headers: signIn(owner),
        params: { publicSlug: site.publicSlug },
        query: { hostname },
      }),
      [200],
    );
    expect(ownerPreview.body.url).toMatch(
      /^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/u,
    );
    expect(ownerPreview.body.expiresAt).not.toBeNull();
    const strangerPreview = await accept(
      hostApi().sitePreview({
        headers: signIn(stranger),
        params: { publicSlug: site.publicSlug },
        query: { hostname },
      }),
      [200],
    );
    expect(strangerPreview.body).toStrictEqual({
      url: `https://${hostname}/`,
      expiresAt: null,
    });
  });
  it("hosted-site-access-010 lets only the owner change visibility and rejects stale edits", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = bdd.user();
    const outsider = bdd.user();
    const site = await publishSite(owner, { visibility: "public" });
    const outsiderSession = await siteSession(outsider, site);
    const ownerSession = await siteSession(owner, site);
    await accept(
      accessApi().updateVisibility({
        headers: signIn(outsider),
        params: { artifactId: site.siteId },
        body: { visibility: "private" },
      }),
      [404],
    );
    const hidden = await setVisibility(owner, site.siteId, "private");
    expect(hidden.visibility).toBe("private");

    await expect(deliveryDecision(storage, site)).resolves.toStrictEqual({
      allowed: false,
      decision: "authenticate",
    });
    await expect(
      deliveryDecision(storage, site, { sessionToken: outsiderSession }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      deliveryDecision(storage, site, { sessionToken: ownerSession }),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      deliveryDecision(storage, site, { publicBrand: "vm0" }),
    ).resolves.toMatchObject({ decision: "deny" });

    await expect(
      setVisibility(owner, site.siteId, "public"),
    ).resolves.toMatchObject({ visibility: "public" });
    await expect(deliveryDecision(storage, site)).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(
      deliveryDecision(storage, site, { publicBrand: "vm0" }),
    ).resolves.toMatchObject({ decision: "deny" });
  });

  it("hosted-site-access-018 accepts an authorization code once with the right proof, site and origin", async () => {
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const site = await publishSite(owner, { visibility: "public" });
    const grant = await authorizationCode(owner, site);
    const exchange = (
      body: { origin: string; codeVerifier: string },
      siteId = site.siteId,
    ) => {
      return hostApi().exchangeSiteSession({
        headers: anonymous(),
        params: { siteId },
        body: { ...body, code: grant.code },
      });
    };

    await accept(
      exchange({
        origin: grant.origin,
        codeVerifier: randomBytes(32).toString("base64url"),
      }),
      [401],
    );
    await accept(
      exchange({
        origin: "https://other.okou.app",
        codeVerifier: grant.verifier,
      }),
      [401],
    );
    await accept(
      exchange(
        { origin: grant.origin, codeVerifier: grant.verifier },
        randomUUID(),
      ),
      [401],
    );
    const correct = { origin: grant.origin, codeVerifier: grant.verifier };
    const concurrent = await Promise.all([
      exchange(correct),
      exchange(correct),
    ]);
    expect(
      concurrent
        .map((response) => {
          return response.status;
        })
        .slice()
        .sort((left, right) => {
          return left - right;
        }),
    ).toStrictEqual([200, 401]);
    await accept(exchange(correct), [401]);
  });

  it("hosted-site-access-027 reuses a restricted preview until it nears expiry and only after current access checks", async () => {
    const issuedAt = Date.parse("2026-10-22T00:00:00Z");
    mockNow(issuedAt);
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const outsider = bdd.user();
    const site = await publishSite(owner, { visibility: "public" });
    await makePrivate(owner, site.siteId);
    const preview = (
      actor: ApiTestUser,
      publicSlug: string,
      hostname: string,
    ) => {
      return hostApi().sitePreview({
        headers: signIn(actor),
        params: { publicSlug },
        query: { hostname },
      });
    };
    const hostname = `${site.publicSlug}.okou.app`;

    const first = await accept(
      preview(owner, site.publicSlug, hostname),
      [200],
    );
    expect(first.body.url).toMatch(/^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/u);
    expect(first.body.expiresAt).toBe(
      new Date(issuedAt + 48 * 3_600_000).toISOString(),
    );
    await expect(
      preview(owner, site.publicSlug, hostname),
    ).resolves.toMatchObject({ status: 200, body: first.body });
    await accept(preview(outsider, site.publicSlug, hostname), [404]);
    await accept(preview(owner, site.publicSlug, "unrelated.okou.app"), [404]);
    await accept(
      preview(owner, "dpl-not-a-deployment", `dpl-not-a-deployment.okou.app`),
      [404],
    );
    const immutable = `dpl-${site.deploymentId}`;
    await expect(
      preview(owner, immutable, `${immutable}.okou.app`),
    ).resolves.toMatchObject({ status: 200, body: first.body });

    mockNow(issuedAt + 47 * 3_600_000 - 1);
    await expect(
      preview(owner, site.publicSlug, hostname),
    ).resolves.toMatchObject({ status: 200, body: first.body });
    const renewedAt = issuedAt + 47 * 3_600_000;
    mockNow(renewedAt);
    const renewed = await accept(
      preview(owner, site.publicSlug, hostname),
      [200],
    );
    expect(renewed.body.url).not.toBe(first.body.url);
    expect(renewed.body.expiresAt).toBe(
      new Date(renewedAt + 48 * 3_600_000).toISOString(),
    );
  });

  it("hosted-site-access-011 grants organization access only while Clerk lists the viewer as a member", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = bdd.user();
    const viewer = bdd.user();
    const site = await publishSite(owner, { visibility: "public" });
    await setVisibility(owner, site.siteId, "organization");
    clerkLists(owner.orgId ?? "", [viewer.userId]);
    const session = await siteSession(viewer, site);
    const hostname = `${site.publicSlug}.okou.app`;
    const preview = () => {
      return hostApi().sitePreview({
        headers: signIn(viewer),
        params: { publicSlug: site.publicSlug },
        query: { hostname },
      });
    };

    await expect(
      deliveryDecision(storage, site, { sessionToken: session }),
    ).resolves.toMatchObject({ allowed: true, decision: "allow" });
    const granted = await accept(preview(), [200]);
    expect(granted.body.expiresAt).not.toBeNull();

    clerkLists(owner.orgId ?? "", []);
    await accept(preview(), [404]);
    await expect(
      deliveryDecision(storage, site, { sessionToken: session }),
    ).resolves.toMatchObject({ decision: "deny" });

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk is unavailable"),
    );
    await accept(
      deliveryRequest(storage, site, { sessionToken: session }),
      [500],
    );
  });

  it("hosted-site-access-013 stops honoring an issued download grant after the policy revision changes", async () => {
    host.captureHostedSitesS3();
    const owner = await proOwner();
    const site = await publishSite(owner, { visibility: "public" });
    await setVisibility(owner, site.siteId, "public");
    const downloadUrl = await indexDownloadUrl(owner, site.deploymentId);

    await expect(
      redeemDownload(downloadUrl, site.deploymentId),
    ).resolves.toMatchObject({ contentType: "text/html; charset=utf-8" });
    await setVisibility(owner, site.siteId, "private");
    await expect(
      redeemDownload(downloadUrl, site.deploymentId),
    ).resolves.toBeNull();
  });

  it("hosted-site-access-017 keeps private downloads bound to their deployment and path until deletion", async () => {
    host.captureHostedSitesS3();
    const owner = await proOwner();
    const site = await publishSite(owner, { visibility: "public" });
    await makePrivate(owner, site.siteId);
    const downloadUrl = await indexDownloadUrl(owner, site.deploymentId);

    expect(downloadUrl.host).toBe(`dpl-${site.deploymentId}.okou.app`);
    await expect(
      redeemDownload(downloadUrl, site.deploymentId),
    ).resolves.not.toBeNull();
    await expect(redeemDownload(downloadUrl, randomUUID())).resolves.toBeNull();
    await expect(
      redeemDownload(downloadUrl, site.deploymentId, "/missing.html"),
    ).resolves.toBeNull();
    await host.deleteHostedSite(owner, site.publicSlug);
    await expect(
      redeemDownload(downloadUrl, site.deploymentId),
    ).resolves.toBeNull();
  });
});
