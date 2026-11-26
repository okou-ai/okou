import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { hostedSiteSharingContract } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { hostRoutes } from "../host";
import { hostedSiteSharingRoutes } from "../hosted-site-sharing";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

interface Person {
  readonly user: ApiTestUser;
  readonly verified: boolean;
  readonly banned?: boolean;
  readonly username?: string;
}

interface Site {
  readonly siteId: string;
  readonly publicSlug: string;
}

function hostApi() {
  return setupApp({ context, routes: hostRoutes })(hostContract);
}

function sharingApi() {
  return setupApp({ context, routes: hostedSiteSharingRoutes })(
    hostedSiteSharingContract,
  );
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

/** A trusted App browser session: Clerk reports a live session for the user. */
function signInWithAppSession(actor: ApiTestUser) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId: actor.userId,
        orgId: actor.orgId,
        orgRole: actor.orgRole,
        sessionId: `sess_${actor.userId}`,
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

/** Clerk's user directory: every account is named "Website Viewer". */
function clerkDirectory(people: readonly Person[]) {
  mockClerkUsers(
    context,
    people.map((person) => {
      const emailId = `email_${person.user.userId}`;
      return {
        id: person.user.userId,
        username: person.username ?? null,
        banned: person.banned ?? false,
        firstName: "Website",
        lastName: "Viewer",
        primaryEmailAddressId: emailId,
        emailAddresses: [
          {
            id: emailId,
            emailAddress: person.user.email,
            verification: {
              status: person.verified ? "verified" : "unverified",
            },
          },
        ],
      };
    }),
  );
}

async function member(
  orgId?: string,
  options: { readonly email?: string } = {},
): Promise<ApiTestUser> {
  const user = bdd.user({
    ...(orgId ? { orgId, orgRole: "org:member" } : {}),
    ...(options.email ? { email: options.email } : {}),
  });
  if (user.orgId) {
    await store.set(
      seedOrgMembership$,
      {
        orgId: user.orgId,
        userId: user.userId,
        role: user.orgRole === "org:admin" ? "admin" : "member",
        emailAddresses: [user.email],
      },
      context.signal,
    );
  }
  return user;
}

async function setSharing(actor: ApiTestUser, enabled: boolean) {
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId ?? "", orgRole: actor.orgRole },
    { [FeatureSwitchKey.HostedSiteEmailSharing]: enabled },
  );
}

function acceptEmails() {
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `email-${randomUUID()}` },
    error: null,
  });
}

async function publishPrivateSite(owner: ApiTestUser): Promise<Site> {
  host.captureHostedSitesS3();
  const html = "<h1>Private</h1>";
  const prepared = await host.prepareHostedSite(owner, {
    site: `site-${randomUUID().slice(0, 8)}`,
    title: "Private page",
    visibility: "private",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [
      {
        path: "/index.html",
        size: Buffer.byteLength(html),
        sha256: createHash("sha256").update(html).digest("hex"),
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);
  return { siteId: prepared.siteId, publicSlug: prepared.publicSlug };
}

function share(owner: ApiTestUser, site: Site, email: string) {
  return sharingApi().share({
    headers: signIn(owner),
    params: { siteId: site.siteId },
    body: { email },
  });
}

function removeShare(actor: ApiTestUser, site: Site, shareId: string) {
  return sharingApi().remove({
    headers: signIn(actor),
    params: { siteId: site.siteId, shareId },
    body: undefined,
  });
}

function listShares(actor: ApiTestUser, site: Site) {
  return sharingApi().list({
    headers: signIn(actor),
    params: { siteId: site.siteId },
  });
}

function searchAccounts(actor: ApiTestUser, site: Site, query: string) {
  return sharingApi().search({
    headers: signIn(actor),
    params: { siteId: site.siteId },
    query: { query },
  });
}

function authorizeSession(viewer: ApiTestUser, site: Site) {
  const verifier = randomBytes(32).toString("base64url");
  const proof = {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
  const origin = `https://${site.publicSlug}.okou.app`;
  return {
    origin,
    verifier,
    request: hostApi().authorizeSiteSession({
      headers: signInWithAppSession(viewer),
      params: { siteId: site.siteId },
      body: { origin, codeChallenge: proof.challenge, state: proof.state },
    }),
  };
}

async function siteSession(viewer: ApiTestUser, site: Site) {
  const authorization = authorizeSession(viewer, site);
  const authorized = await accept(authorization.request, [200]);
  const code = new URL(authorized.body.callbackUrl).searchParams.get("code");
  const exchanged = await accept(
    hostApi().exchangeSiteSession({
      headers: anonymous(),
      params: { siteId: site.siteId },
      body: {
        origin: authorization.origin,
        code: code ?? "",
        codeVerifier: authorization.verifier,
      },
    }),
    [200],
  );
  return exchanged.body.sessionToken;
}

async function sessionAccess(sessionToken: string, site: Site) {
  anonymous();
  const response = await accept(
    hostApi().siteAccess({
      headers: { authorization: `Bearer ${sessionToken}` },
      params: { siteId: site.siteId },
      query: { origin: `https://${site.publicSlug}.okou.app` },
    }),
    [200],
  );
  return response.body;
}

function sentInvitations() {
  return context.mocks.resend.send.mock.calls.map((call) => {
    return call[0];
  });
}

function expectOneInvitation(recipient: string, site: Site) {
  const sent = sentInvitations();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ from: "Okou <noreply@okou.ai>" });
  const payload = JSON.stringify(sent[0]);
  expect(payload).toContain(recipient);
  expect(payload).toContain("okou-hosted-site-invitation-v1");
  expect(payload).toContain("Website Viewer");
  expect(payload).toContain(`https://${site.publicSlug}.okou.app/`);
}

/** A sharing owner's private site, a verified workspace viewer and an unverified stranger. */
async function viewerScenario() {
  acceptEmails();
  const owner = await member();
  const viewer = await member(owner.orgId ?? undefined, {
    email: "viewer@example.com",
  });
  const stranger = await member();
  clerkDirectory([
    { user: owner, verified: true },
    { user: viewer, verified: true },
    { user: stranger, verified: false },
  ]);
  await setSharing(owner, true);
  const site = await publishPrivateSite(owner);
  return { owner, viewer, stranger, site };
}

describe("hosted site sharing", () => {
  it("hosted-site-sharing-004 keeps a revoked pending invitation from being claimed", async () => {
    acceptEmails();
    const owner = await member();
    const invitee = await member(undefined, { email: "later@example.com" });
    clerkDirectory([
      { user: owner, verified: true },
      { user: invitee, verified: false },
    ]);
    await setSharing(owner, true);
    const site = await publishPrivateSite(owner);
    const invited = await accept(
      share(owner, site, "later@example.com"),
      [200],
    );

    await accept(removeShare(owner, site, invited.body.share.id), [200]);
    clerkDirectory([
      { user: owner, verified: true },
      { user: invitee, verified: true },
    ]);
    const denied = await accept(authorizeSession(invitee, site).request, [403]);

    expect(denied.body.error.code).toBe("FORBIDDEN");
  });

  it("hosted-site-sharing-001 (1/2) finds the verified member and invites them once", async () => {
    const { owner, viewer, site } = await viewerScenario();

    const search = await accept(searchAccounts(owner, site, "viewer"), [200]);
    const shared = await accept(
      share(owner, site, "VIEWER@EXAMPLE.COM"),
      [200],
    );
    const repeated = await accept(
      share(owner, site, "viewer@example.com"),
      [200],
    );

    expect(search.body.accounts).toStrictEqual([
      {
        userId: viewer.userId,
        email: "viewer@example.com",
        name: "Website Viewer",
      },
    ]);
    expect(shared.body.share.email).toBe("viewer@example.com");
    expect(repeated.body).toStrictEqual(shared.body);
    expectOneInvitation("viewer@example.com", site);
  });

  it("hosted-site-sharing-001 (2/2) allows the shared viewer and revokes the existing session", async () => {
    const { owner, viewer, stranger, site } = await viewerScenario();
    const shared = await accept(
      share(owner, site, "viewer@example.com"),
      [200],
    );

    const session = await siteSession(viewer, site);
    const allowed = await sessionAccess(session, site);
    await accept(authorizeSession(stranger, site).request, [403]);
    await accept(removeShare(owner, site, shared.body.share.id), [200]);
    const revoked = await sessionAccess(session, site);
    const preview = await accept(
      hostApi().sitePreview({
        headers: signIn(viewer),
        params: { publicSlug: site.publicSlug },
        query: { hostname: `${site.publicSlug}.okou.app` },
      }),
      [404],
    );

    expect(allowed).toMatchObject({ decision: "allow" });
    expect(revoked).toMatchObject({ decision: "deny" });
    expect(preview.status).toBe(404);
  });

  it("hosted-site-sharing-002 sends one invitation that only its verified recipient can claim", async () => {
    acceptEmails();
    const owner = await member();
    const invitee = bdd.user({ orgId: null, email: "invited@example.com" });
    const stranger = await member();
    clerkDirectory([
      { user: owner, verified: true },
      { user: invitee, verified: false },
      { user: stranger, verified: true },
    ]);
    await setSharing(owner, true);
    const site = await publishPrivateSite(owner);

    const first = await accept(
      share(owner, site, "invited@example.com"),
      [200],
    );
    const second = await accept(
      share(owner, site, "invited@example.com"),
      [200],
    );
    await accept(authorizeSession(invitee, site).request, [403]);
    await accept(authorizeSession(stranger, site).request, [403]);
    clerkDirectory([
      { user: owner, verified: true },
      { user: invitee, verified: true },
      { user: stranger, verified: true },
    ]);
    const concurrent = await Promise.all([
      accept(authorizeSession(invitee, site).request, [200]),
      accept(authorizeSession(invitee, site).request, [200]),
    ]);
    const listed = await accept(listShares(owner, site), [200]);

    expect(second.body.share.id).toBe(first.body.share.id);
    expectOneInvitation("invited@example.com", site);
    expect(
      concurrent.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    expect(listed.body.shares).toStrictEqual([first.body.share]);
  });

  it("hosted-site-sharing-003 keeps sharing owner-only and the switch off does not revoke grants", async () => {
    acceptEmails();
    const owner = await member();
    const peer = await member(owner.orgId ?? undefined);
    clerkDirectory([
      { user: owner, verified: true },
      { user: peer, verified: true },
    ]);
    const site = await publishPrivateSite(owner);

    const disabled = await accept(share(owner, site, peer.email), [404]);
    await setSharing(owner, true);
    await setSharing(peer, true);
    const peerSearch = await accept(
      searchAccounts(peer, site, "Website"),
      [404],
    );
    const peerShare = await accept(share(peer, site, "x@example.com"), [404]);
    const granted = await accept(share(owner, site, peer.email), [200]);
    const peerList = await accept(listShares(peer, site), [404]);
    const peerRemove = await accept(
      removeShare(peer, site, granted.body.share.id),
      [404],
    );
    await setSharing(owner, false);
    const authorized = await accept(
      authorizeSession(peer, site).request,
      [200],
    );

    expect(
      [disabled, peerSearch, peerShare, peerList, peerRemove].map(
        (response) => {
          return response.status;
        },
      ),
    ).toStrictEqual([404, 404, 404, 404, 404]);
    expect(authorized.status).toBe(200);
  });

  it("hosted-site-sharing-005 finds only verified current workspace members", async () => {
    const owner = await member();
    const verified = await member(owner.orgId ?? undefined, {
      email: "member@example.com",
    });
    const unverified = await member(owner.orgId ?? undefined);
    const banned = await member(owner.orgId ?? undefined);
    const external = await member(undefined, {
      email: "external@example.com",
    });
    clerkDirectory([
      { user: owner, verified: true },
      { user: verified, verified: true, username: "memberhandle" },
      { user: unverified, verified: false, username: "memberhandle2" },
      { user: banned, verified: true, banned: true, username: "memberhandle3" },
      { user: external, verified: true, username: "externalhandle" },
    ]);
    await setSharing(owner, true);
    const site = await publishPrivateSite(owner);
    const lookup = async (query: string) => {
      const response = await accept(searchAccounts(owner, site, query), [200]);
      return response.body.accounts;
    };
    const expected = [
      {
        userId: verified.userId,
        email: "member@example.com",
        name: "Website Viewer",
      },
    ];

    await expect(lookup("Website Viewer")).resolves.toStrictEqual(expected);
    await expect(lookup("memberhandle")).resolves.toStrictEqual(expected);
    await expect(lookup("member@example.com")).resolves.toStrictEqual(expected);
    await expect(lookup("external@example.com")).resolves.toStrictEqual([]);
    await expect(lookup("externalhandle")).resolves.toStrictEqual([]);
    await expect(lookup("external")).resolves.toStrictEqual([]);
  });

  it("hosted-site-sharing-008 limits sharing attempts per user before creating another invitation", async () => {
    const startMs = Date.parse("2026-11-23T00:00:00Z");
    mockNow(startMs);
    acceptEmails();
    const owner = await member();
    clerkDirectory([{ user: owner, verified: true }]);
    const [, site] = await Promise.all([
      setSharing(owner, true),
      publishPrivateSite(owner),
    ]);

    const firstTen = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        return accept(
          share(owner, site, `recipient-${index}@example.com`),
          [200],
        );
      }),
    );
    const eleventh = await accept(
      share(owner, site, "recipient-10@example.com"),
      [429],
    );
    const listed = await accept(listShares(owner, site), [200]);
    mockNow(startMs + 60_000);
    const afterWindow = await accept(
      share(owner, site, "recipient-11@example.com"),
      [200],
    );

    expect(
      firstTen.map((response) => {
        return response.status;
      }),
    ).toStrictEqual(
      Array.from({ length: 10 }, () => {
        return 200;
      }),
    );
    expect(eleventh.status).toBe(429);
    expect(listed.body.shares).toHaveLength(10);
    expect(afterWindow.status).toBe(200);
  });
});
