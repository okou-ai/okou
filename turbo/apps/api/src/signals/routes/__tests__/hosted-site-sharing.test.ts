import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { array, object, record, string } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostedSiteSharingContract } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../../lib/time";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function app(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId: user.userId,
        orgId: user.orgId,
        orgRole: user.orgRole,
        sessionId: `sess_${user.userId}`,
      };
    },
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: `sess_${user.userId}`,
    userId: user.userId,
    status: "active",
    expireAt: now() + 86_400_000,
  });
  return setupAppWithRoutes({
    context,
    routes: hostRoutes,
    baseUrl: "https://api.okou.ai",
  });
}

function profile(user: ApiTestUser, verified = true) {
  return {
    id: user.userId,
    firstName: "Website",
    lastName: "Viewer",
    banned: false,
    primaryEmailAddressId: `email_${user.userId}`,
    emailAddresses: [
      {
        id: `email_${user.userId}`,
        emailAddress: user.email,
        verification: { status: verified ? "verified" : "unverified" },
      },
    ],
  };
}

function directory(profiles: readonly ReturnType<typeof profile>[]) {
  mockClerkUsers(context, profiles);
  context.mocks.clerk.users.getUserList.mockImplementation((input) => {
    const params = object({
      emailAddress: array(string()).optional(),
      query: string().optional(),
    }).parse(input);
    const data = profiles.filter((user) => {
      return params.emailAddress
        ? user.emailAddresses.some((address) => {
            return params.emailAddress?.includes(
              address.emailAddress.toLowerCase(),
            );
          })
        : `${user.firstName} ${user.lastName} ${user.emailAddresses[0]?.emailAddress}`
            .toLowerCase()
            .includes(params.query?.toLowerCase() ?? "");
    });
    return Promise.resolve({ data });
  });
}

async function publish(enabled = true) {
  const orgId = `org_${randomUUID()}`;
  const owner = { ...createBddApi(context).user({ orgId }), orgId };
  if (enabled) {
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.HostedSiteEmailSharing]: true,
    });
  }
  const host = createHostBddApi(context);
  host.captureHostedSitesS3();
  const site = await host.prepareHostedSite(owner, {
    site: `sharing-${randomUUID().slice(0, 8)}`,
    title: "Shared website",
    artifactKind: "hosted-site",
    spaFallback: false,
    visibility: "private",
    files: [hostedTextFile("/index.html", "<p>Named viewers only</p>")],
  });
  await host.completeHostedSite(owner, site.deploymentId);
  return { owner, site, params: { siteId: site.siteId } };
}

function authorization(
  user: ApiTestUser,
  site: { readonly siteId: string; readonly publicSlug: string },
) {
  return app(user)(hostContract).authorizeSiteSession({
    headers,
    params: { siteId: site.siteId },
    body: {
      origin: `https://${site.publicSlug}.okou.app`,
      state: "s".repeat(43),
      codeChallenge: "c".repeat(43),
    },
  });
}

async function browserSession(
  user: ApiTestUser,
  site: { readonly siteId: string; readonly publicSlug: string },
) {
  const verifier = randomBytes(32).toString("base64url");
  const params = { siteId: site.siteId };
  const origin = `https://${site.publicSlug}.okou.app`;
  const authorized = await accept(
    app(user)(hostContract).authorizeSiteSession({
      headers,
      params,
      body: {
        origin,
        state: "s".repeat(43),
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      },
    }),
    [200],
  );
  const code = new URL(authorized.body.callbackUrl).searchParams.get("code")!;
  const exchanged = await accept(
    app(user)(hostContract).exchangeSiteSession({
      params,
      body: { code, codeVerifier: verifier, origin },
    }),
    [200],
  );
  return { authorization: `Bearer ${exchanged.body.sessionToken}` };
}

test("an owner searches verified accounts, shares privately, and revokes an existing browser session", async () => {
  const { owner, site, params } = await publish();
  const viewer = createBddApi(context).user({ email: "viewer@example.com" });
  const stranger = createBddApi(context).user({
    email: "stranger@example.com",
  });
  directory([profile(owner), profile(viewer), profile(stranger, false)]);
  const results = await accept(
    app(owner)(hostedSiteSharingContract).search({
      headers,
      params,
      query: { query: "viewer" },
    }),
    [200],
  );
  expect(results.body.accounts).toStrictEqual([
    { userId: viewer.userId, email: viewer.email, name: "Website Viewer" },
  ]);
  const shared = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: " VIEWER@EXAMPLE.COM " },
    }),
    [200],
  );
  expect(shared.body.outcome).toBe("shared");
  expect(shared.body.share.userId).toBe(viewer.userId);
  const sessionHeaders = await browserSession(viewer, site);
  const access = () => {
    return app(viewer)(hostContract).siteAccess({
      headers: sessionHeaders,
      params,
      query: { origin: `https://${site.publicSlug}.okou.app` },
    });
  };
  expect((await accept(access(), [200])).body.decision).toBe("allow");
  await accept(authorization(stranger, site), [403]);
  await accept(
    app(owner)(hostedSiteSharingContract).remove({
      headers,
      params: { ...params, shareId: shared.body.share.id },
    }),
    [200],
  );
  expect((await accept(access(), [200])).body.decision).toBe("deny");
  await accept(
    app(viewer)(hostContract).sitePreview({
      headers,
      params: { publicSlug: site.publicSlug },
      query: { hostname: `${site.publicSlug}.okou.app` },
    }),
    [404],
  );
});

test("an email invitation uses the Resend template once and can only be claimed by its verified recipient", async () => {
  const { owner, site, params } = await publish();
  const invitee = createBddApi(context).user({
    email: "invited@example.com",
    orgId: null,
  });
  const stranger = createBddApi(context).user({ email: "other@example.com" });
  directory([profile(owner)]);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: "resend-invitation" },
    error: null,
  });
  const first = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: invitee.email },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(first.body.outcome).toBe("invited");
  const duplicate = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: invitee.email },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(duplicate.body.share.id).toBe(first.body.share.id);
  const sent = context.mocks.resend.send.mock.calls.map((call) => {
    return object({
      to: string(),
      template: object({ id: string(), variables: record(string(), string()) }),
    }).parse(call[0]);
  });
  expect(sent).toStrictEqual([
    {
      to: invitee.email,
      template: {
        id: "okou-hosted-site-invitation-v1",
        variables: {
          INVITER_NAME: "Website Viewer",
          RECIPIENT_EMAIL: invitee.email,
          SITE_URL: `https://${site.publicSlug}.okou.app/`,
        },
      },
    },
  ]);
  directory([profile(owner), profile(invitee, false), profile(stranger)]);
  await accept(authorization(invitee, site), [403]);
  await accept(authorization(stranger, site), [403]);
  directory([profile(owner), profile(invitee), profile(stranger)]);
  const claims = await Promise.all([
    authorization(invitee, site),
    authorization(invitee, site),
  ]);
  expect(
    claims.map((result) => {
      return result.status;
    }),
  ).toStrictEqual([200, 200]);
  const listing = await accept(
    app(owner)(hostedSiteSharingContract).list({ headers, params }),
    [200],
  );
  expect(listing.body.shares).toStrictEqual([
    { ...first.body.share, userId: invitee.userId },
  ]);
});

test("sharing management is owner-only and disabled features cannot search or grant access", async () => {
  const { owner, site, params } = await publish(false);
  const peer = {
    ...createBddApi(context).user({ orgId: owner.orgId }),
    orgId: owner.orgId,
  };
  await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: "invited@example.com" },
    }),
    [404],
  );
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.HostedSiteEmailSharing]: true,
  });
  await updateFeatureSwitchesForUser(context, peer, {
    [FeatureSwitchKey.HostedSiteEmailSharing]: true,
  });
  await accept(
    app(peer)(hostedSiteSharingContract).search({
      headers,
      params,
      query: { query: "viewer" },
    }),
    [404],
  );
  await accept(
    app(peer)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: "invited@example.com" },
    }),
    [404],
  );
  directory([profile(owner), profile(peer)]);
  const shared = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: peer.email },
    }),
    [200],
  );
  await accept(
    app(peer)(hostedSiteSharingContract).list({ headers, params }),
    [404],
  );
  await accept(
    app(peer)(hostedSiteSharingContract).remove({
      headers,
      params: { ...params, shareId: shared.body.share.id },
    }),
    [404],
  );
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.HostedSiteEmailSharing]: false,
  });
  // A rollout switch controls management, not already-granted access.
  await expect(authorization(peer, site)).resolves.toMatchObject({
    status: 200,
  });
});

test("revoking a pending invitation prevents a later verified sign-up from claiming it", async () => {
  const { owner, site, params } = await publish();
  const invitee = createBddApi(context).user({ email: "later@example.com" });
  directory([profile(owner)]);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: "resend-pending-invitation" },
    error: null,
  });
  const shared = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: invitee.email },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  await accept(
    app(owner)(hostedSiteSharingContract).remove({
      headers,
      params: { ...params, shareId: shared.body.share.id },
    }),
    [200],
  );
  directory([profile(owner), profile(invitee)]);
  await expect(authorization(invitee, site)).resolves.toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});
