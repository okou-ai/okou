import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { array, number, object, record, string } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostedSiteSharingContract } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

beforeEach(() => {
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
});

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
    username: `nickname_${user.userId}`,
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

function directory(
  profiles: readonly ReturnType<typeof profile>[],
  members: readonly ApiTestUser[] = [],
) {
  mockClerkUsers(context, profiles);
  context.mocks.clerk.users.getUserList.mockImplementation((input) => {
    const params = object({
      userId: array(string()),
      limit: number().optional(),
    })
      .strict()
      .parse(input);
    const data = profiles.filter((user) => {
      return params.userId.includes(user.id);
    });
    return Promise.resolve({ data });
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = object({
        organizationId: string(),
        userId: array(string()).optional(),
        emailAddress: array(string()).optional(),
        query: string().optional(),
      }).parse(input);
      const data = members
        .filter((member) => {
          const user = profiles.find((entry) => {
            return entry.id === member.userId;
          });
          return (
            member.orgId === params.organizationId &&
            (!params.userId || params.userId.includes(member.userId)) &&
            (!params.emailAddress ||
              params.emailAddress.includes(member.email)) &&
            (!params.query ||
              `${user?.firstName} ${user?.lastName} ${user?.username} ${member.email}`
                .toLowerCase()
                .includes(params.query.toLowerCase()))
          );
        })
        .map((member) => {
          return {
            id: `membership_${member.userId}_${member.orgId}`,
            role: "org:member",
            createdAt: now(),
            organization: {
              id: member.orgId,
              name: "Sharing workspace",
              slug: "sharing",
              imageUrl: "",
              hasImage: false,
            },
            publicUserData: { userId: member.userId },
          };
        });
      return Promise.resolve({ data });
    },
  );
}

async function publish(enabled = true, existingOwner?: ApiTestUser) {
  const orgId = existingOwner?.orgId ?? `org_${randomUUID()}`;
  const owner = {
    ...(existingOwner ?? createBddApi(context).user({ orgId })),
    orgId,
  };
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
  const viewer = createBddApi(context).user({
    email: "viewer@example.com",
    orgId: owner.orgId,
  });
  const stranger = createBddApi(context).user({
    email: "stranger@example.com",
  });
  directory(
    [profile(owner), profile(viewer), profile(stranger, false)],
    [owner, viewer],
  );
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
  expect(shared.body).toStrictEqual({
    share: { id: shared.body.share.id, email: viewer.email },
  });
  await flushWaitUntilForTest();
  const repeated = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: viewer.email },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(repeated.body).toStrictEqual(shared.body);
  expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
  expect(context.mocks.resend.send.mock.calls[0]?.[0]).toMatchObject({
    from: "Okou <noreply@okou.ai>",
    to: viewer.email,
    template: {
      id: "okou-hosted-site-invitation-v1",
      variables: {
        INVITER_NAME: "Website Viewer",
        RECIPIENT_EMAIL: viewer.email,
        SITE_URL: `https://${site.publicSlug}.okou.app/`,
      },
    },
  });
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
  expect(first.body).toStrictEqual({
    share: { id: first.body.share.id, email: invitee.email },
  });
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
      from: string(),
      to: string(),
      template: object({ id: string(), variables: record(string(), string()) }),
    }).parse(call[0]);
  });
  expect(sent).toStrictEqual([
    {
      from: "Okou <noreply@okou.ai>",
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
  expect(listing.body.shares).toStrictEqual([first.body.share]);
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
  directory([profile(owner), profile(peer)], [owner, peer]);
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

test("account lookup returns only verified current workspace members for names, nicknames, and full emails", async () => {
  const { owner, params } = await publish();
  const member = createBddApi(context).user({
    orgId: owner.orgId,
    email: "member@example.com",
  });
  const external = createBddApi(context).user({
    email: "external@example.com",
  });
  const unverified = createBddApi(context).user({
    orgId: owner.orgId,
    email: "unverified@example.com",
  });
  const banned = createBddApi(context).user({
    orgId: owner.orgId,
    email: "banned@example.com",
  });
  directory(
    [
      profile(owner),
      profile(member),
      profile(external),
      profile(unverified, false),
      { ...profile(banned), banned: true },
    ],
    [owner, member, external, unverified, banned],
  );
  const search = (query: string) => {
    return app(owner)(hostedSiteSharingContract).search({
      headers,
      params,
      query: { query },
    });
  };
  for (const query of [
    "Website Viewer",
    `nickname_${member.userId}`,
    member.email,
  ]) {
    const result = await accept(search(query), [200]);
    expect(result.body.accounts).toStrictEqual([
      { userId: member.userId, email: member.email, name: "Website Viewer" },
    ]);
  }
  for (const query of [
    external.email,
    `nickname_${external.userId}`,
    "external",
  ]) {
    expect((await accept(search(query), [200])).body.accounts).toStrictEqual(
      [],
    );
  }
});

test("external registered and unregistered emails have the same invitation response and list representation", async () => {
  const { owner, site, params } = await publish();
  const registered = createBddApi(context).user({
    email: "registered@external.example",
  });
  const unregistered = createBddApi(context).user({
    email: "unregistered@external.example",
    orgId: null,
  });
  directory([profile(owner), profile(registered)], [owner]);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: "external-invitation" },
    error: null,
  });
  for (const recipient of [registered, unregistered]) {
    const result = await accept(
      app(owner)(hostedSiteSharingContract).share({
        headers,
        params,
        body: { email: recipient.email },
      }),
      [200],
    );
    expect(result.body).toStrictEqual({
      share: { id: expect.any(String), email: recipient.email },
    });
    await flushWaitUntilForTest();
  }
  const sentTo = context.mocks.resend.send.mock.calls.map((call) => {
    return object({ to: string() }).parse(call[0]).to;
  });
  expect(sentTo.sort()).toStrictEqual(
    [registered.email, unregistered.email].sort(),
  );
  const before = await accept(
    app(owner)(hostedSiteSharingContract).list({ headers, params }),
    [200],
  );
  await accept(authorization(registered, site), [200]);
  await accept(authorization(unregistered, site), [403]);
  directory(
    [profile(owner), profile(registered), profile(unregistered)],
    [owner],
  );
  await accept(authorization(unregistered, site), [200]);
  const after = await accept(
    app(owner)(hostedSiteSharingContract).list({ headers, params }),
    [200],
  );
  expect(after.body).toStrictEqual(before.body);
});

test("search admission is atomic across concurrent requests and shared across owned websites", async () => {
  await withMockNowForTest(new Date("2026-11-23T00:00:00Z"), async () => {
    const first = await publish();
    const second = await publish(true, first.owner);
    directory([profile(first.owner)], [first.owner]);
    const search = (params: { siteId: string }) => {
      return app(first.owner)(hostedSiteSharingContract).search({
        headers,
        params,
        query: { query: "nobody" },
      });
    };
    const results = await Promise.all(
      Array.from({ length: 31 }, (_, index) => {
        return search(index % 2 === 0 ? first.params : second.params);
      }),
    );
    expect(
      results.filter((result) => {
        return result.status === 200;
      }),
    ).toHaveLength(30);
    expect(
      results.filter((result) => {
        return result.status === 429;
      }),
    ).toHaveLength(1);
    const limited = await accept(search(second.params), [429]);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    mockNow(now() + 60_000);
    await accept(search(second.params), [200]);
  });
});

test("sharing attempts are limited per user before creating another invitation", async () => {
  await withMockNowForTest(new Date("2026-11-23T00:00:00Z"), async () => {
    const { owner, params } = await publish();
    directory([profile(owner)], [owner]);
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "limited-invitation" },
      error: null,
    });
    const share = (email: string) => {
      return app(owner)(hostedSiteSharingContract).share({
        headers,
        params,
        body: { email },
      });
    };
    for (let index = 0; index < 10; index++) {
      await accept(share(`recipient-${index}@example.com`), [200]);
    }
    await accept(share("blocked@example.com"), [429]);
    expect(
      (
        await accept(
          app(owner)(hostedSiteSharingContract).list({ headers, params }),
          [200],
        )
      ).body.shares,
    ).toHaveLength(10);
    mockNow(now() + 60_000);
    await accept(share("after-reset@example.com"), [200]);
  });
});

test("recipient quotas survive revocation and switching websites", async () => {
  const first = await publish();
  const second = await publish(true, first.owner);
  directory([profile(first.owner)], [first.owner]);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: "recipient-limited-invitation" },
    error: null,
  });
  const email = "recipient@example.com";
  const share = (params: { siteId: string }) => {
    return app(first.owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email },
    });
  };
  for (let index = 0; index < 3; index++) {
    const params = index % 2 === 0 ? first.params : second.params;
    const result = await accept(share(params), [200]);
    await accept(
      app(first.owner)(hostedSiteSharingContract).remove({
        headers,
        params: { ...params, shareId: result.body.share.id },
      }),
      [200],
    );
  }
  await accept(
    app(first.owner)(hostedSiteSharingContract).share({
      headers,
      params: second.params,
      body: { email: " RECIPIENT@EXAMPLE.COM " },
    }),
    [429],
  );
  expect(
    (
      await accept(
        app(first.owner)(hostedSiteSharingContract).list({
          headers,
          params: second.params,
        }),
        [200],
      )
    ).body.shares,
  ).toStrictEqual([]);
});

test("workspace search quotas cannot be bypassed by using another owner", async () => {
  const first = await publish();
  const owners = [first];
  for (let index = 0; index < 4; index++) {
    owners.push(
      await publish(
        true,
        createBddApi(context).user({ orgId: first.owner.orgId }),
      ),
    );
  }
  directory(
    owners.map(({ owner }) => {
      return profile(owner);
    }),
    owners.map(({ owner }) => {
      return owner;
    }),
  );
  for (const { owner, params } of owners.slice(0, 4)) {
    for (let index = 0; index < 30; index++) {
      await accept(
        app(owner)(hostedSiteSharingContract).search({
          headers,
          params,
          query: { query: "nobody" },
        }),
        [200],
      );
    }
  }
  const last = owners[4]!;
  const limited = await accept(
    app(last.owner)(hostedSiteSharingContract).search({
      headers,
      params: last.params,
      query: { query: "nobody" },
    }),
    [429],
  );
  expect(limited.body.error.code).toBe("RATE_LIMITED");
});

test("workspace sharing quotas apply across owners and do not create a grant when exhausted", async () => {
  const first = await publish();
  const owners = [first];
  for (let index = 0; index < 6; index++) {
    owners.push(
      await publish(
        true,
        createBddApi(context).user({ orgId: first.owner.orgId }),
      ),
    );
  }
  const recipients = Array.from({ length: 60 }, (_, index) => {
    return createBddApi(context).user({
      orgId: first.owner.orgId,
      email: `member-${index}@example.com`,
    });
  });
  const members = [
    ...owners.map(({ owner }) => {
      return owner;
    }),
    ...recipients,
  ];
  directory(
    members.map((member) => {
      return profile(member);
    }),
    members,
  );
  for (const [index, recipient] of recipients.entries()) {
    const { owner, params } = owners[Math.floor(index / 10)]!;
    await accept(
      app(owner)(hostedSiteSharingContract).share({
        headers,
        params,
        body: { email: recipient.email },
      }),
      [200],
    );
  }
  const last = owners[6]!;
  await accept(
    app(last.owner)(hostedSiteSharingContract).share({
      headers,
      params: last.params,
      body: { email: "blocked@example.com" },
    }),
    [429],
  );
  expect(
    (
      await accept(
        app(last.owner)(hostedSiteSharingContract).list({
          headers,
          params: last.params,
        }),
        [200],
      )
    ).body.shares,
  ).toStrictEqual([]);
});

test("a partial name cannot be submitted as an external invitation address", async () => {
  const { owner, params } = await publish();
  await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params,
      body: { email: "External Viewer" },
    }),
    [400],
  );
  expect(
    (
      await accept(
        app(owner)(hostedSiteSharingContract).list({ headers, params }),
        [200],
      )
    ).body.shares,
  ).toStrictEqual([]);
});
