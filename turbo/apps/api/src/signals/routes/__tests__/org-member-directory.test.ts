import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { createRouteMocks } from "./helpers/route-test";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { orgReadRoutes } from "../org-read";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const CREATED_AT = "2026-01-01T00:00:00.000Z";
// One store so every seeded Clerk membership stays visible across workspaces.
const store = createStore();

/** Clerk's response wrapper for a rate-limited Backend API read. */
class ClerkRateLimitedTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly status = 429;
  readonly errors = [
    { code: "rate_limit_exceeded", message: "Too many requests" },
  ];

  constructor(readonly retryAfter: number) {
    super("Clerk Backend API request failed with 429");
    this.name = "ClerkAPIResponseError";
  }
}

interface Person {
  readonly userId: string;
  readonly role: "admin" | "member";
}

function person(role: "admin" | "member" = "member"): Person {
  return { userId: `user_${randomUUID()}`, role };
}

function email(userId: string) {
  return `${userId}@example.test`;
}

function avatar(userId: string) {
  return `https://img.clerk.test/${userId}.png`;
}

/** Clerk holds a profile for each listed user. */
function clerkProfiles(userIds: readonly string[]) {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    const requested =
      typeof args === "object" &&
      args !== null &&
      "userId" in args &&
      Array.isArray(args.userId)
        ? args.userId
        : [];
    return Promise.resolve({
      data: userIds
        .filter((userId) => {
          return requested.includes(userId);
        })
        .map((userId) => {
          return {
            id: userId,
            firstName: "BDD",
            lastName: "Actor",
            imageUrl: avatar(userId),
            primaryEmailAddressId: `idn_${userId}`,
            emailAddresses: [
              { id: `idn_${userId}`, emailAddress: email(userId) },
            ],
          };
        }),
    });
  });
}

/**
 * Clerk also reports each workspace's creation time. The membership seed owns
 * the organization names, so this extends its current organization lookup.
 */
function clerkOrganizations() {
  const seeded =
    context.mocks.clerk.organizations.getOrganization.getMockImplementation();
  context.mocks.clerk.organizations.getOrganization.mockImplementation(
    async (args: unknown) => {
      const organization: unknown = seeded ? await seeded(args) : null;
      return {
        ...(typeof organization === "object" && organization !== null
          ? organization
          : {}),
        createdAt: Date.parse(CREATED_AT),
      };
    },
  );
}

/** A Clerk workspace with its members, their profiles and its creation time. */
async function workspace(name: string, members: readonly Person[]) {
  const orgId = `org_${randomUUID()}`;
  for (const member of members) {
    await store.set(
      seedOrgMembership$,
      { orgId, userId: member.userId, role: member.role, name },
      context.signal,
    );
  }
  clerkOrganizations();
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockRejectedValue(
    new Error("Clerk invitation listing failed"),
  );
  return orgId;
}

/** Clerk's membership-request endpoint answers with the given response. */
function membershipRequests(respond: () => Response) {
  const requested: string[] = [];
  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
      ({ request }) => {
        requested.push(request.url);
        return respond();
      },
    ),
  );
  return requested;
}

function rateLimited() {
  return membershipRequests(() => {
    return new HttpResponse(null, {
      status: 429,
      headers: { "Retry-After": "7" },
    });
  });
}

function members() {
  return setupApp({ context, routes: orgReadRoutes })(orgMembersContract);
}

function signIn(actor: Person, orgId: string | null) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    orgId,
    actor.role === "admin" ? "org:admin" : "org:member",
  );
}

async function membersView(actor: Person, orgId: string) {
  signIn(actor, orgId);
  const response = await accept(
    members().members({ headers, query: { view: "members" } }),
    [200],
  );
  return response.body;
}

function listed(actor: Person) {
  return {
    userId: actor.userId,
    email: email(actor.userId),
    firstName: "BDD",
    lastName: "Actor",
    imageUrl: avatar(actor.userId),
    role: actor.role,
    joinedAt: CREATED_AT,
  };
}

describe("organization member directory", () => {
  it("org-member-directory-006 requires authentication and an active organization for the members view", async () => {
    const user = person();
    await accept(
      members().members({ headers: {}, query: { view: "members" } }),
      [401],
    );
    signIn(user, null);
    await accept(
      members().members({ headers, query: { view: "members" } }),
      [401],
    );

    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.users.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
  });

  it("org-member-directory-001 serves the members view to org:admin without failed management reads", async () => {
    const admin = person("admin");
    const peer = person();
    const orgId = await workspace("Members only workspace", [admin, peer]);
    clerkProfiles([admin.userId, peer.userId]);
    const requests = rateLimited();

    await expect(membersView(admin, orgId)).resolves.toStrictEqual({
      name: "Members only workspace",
      role: "admin",
      createdAt: CREATED_AT,
      members: [listed(admin), listed(peer)],
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).not.toHaveBeenCalled();
    expect(requests).toStrictEqual([]);
  });

  it("org-member-directory-002 serves the members view to org:member without failed management reads", async () => {
    const caller = person();
    const peer = person();
    const orgId = await workspace("Members only workspace", [caller, peer]);
    clerkProfiles([caller.userId, peer.userId]);
    const requests = rateLimited();

    await expect(membersView(caller, orgId)).resolves.toStrictEqual({
      name: "Members only workspace",
      role: "member",
      createdAt: CREATED_AT,
      members: [listed(caller), listed(peer)],
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).not.toHaveBeenCalled();
    expect(requests).toStrictEqual([]);
  });

  it("org-member-directory-003 serves members without admin transport while preserving admin invitation failures", async () => {
    const admin = person("admin");
    const member = person();
    const orgId = await workspace("Directory workspace", [admin, member]);
    clerkProfiles([admin.userId, member.userId]);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockRejectedValue(
      new ClerkRateLimitedTestError(7),
    );
    const requests = rateLimited();

    signIn(member, orgId);
    const memberView = await accept(members().members({ headers }), [200]);
    expect(memberView.body).toMatchObject({
      name: "Directory workspace",
      role: "member",
      pendingInvitations: [],
      membershipRequests: [],
      members: [
        { userId: admin.userId, role: "admin" },
        { userId: member.userId, role: "member" },
      ],
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).not.toHaveBeenCalled();
    expect(requests).toStrictEqual([]);

    signIn(admin, orgId);
    const adminView = await accept(members().members({ headers }), [503]);
    expect(adminView.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Organization members are temporarily unavailable",
      },
    });
    expect(adminView.headers.get("retry-after")).toBe("7");
    expect(adminView.headers.get("cache-control")).toBe("no-store");
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).toHaveBeenCalledTimes(1);
  });

  it("org-member-directory-004 returns every pending invitation page and membership requests for admins", async () => {
    const admin = person("admin");
    const requester = person();
    const orgId = await workspace("Invitations workspace", [admin]);
    clerkProfiles([admin.userId, requester.userId]);
    const invitations = Array.from({ length: 101 }, (_, index) => {
      return {
        id: `orginv_${String(index).padStart(3, "0")}`,
        emailAddress: `invitee-${index}@example.test`,
        role: "org:member",
        createdAt: Date.parse(CREATED_AT) + index * 1000,
      };
    });
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockImplementation(
      (args: unknown) => {
        const offset =
          typeof args === "object" &&
          args !== null &&
          "offset" in args &&
          typeof args.offset === "number"
            ? args.offset
            : 0;
        return Promise.resolve({
          data: invitations.slice(offset, offset + 100),
        });
      },
    );
    membershipRequests(() => {
      return HttpResponse.json({
        data: [
          {
            id: "orgmemreq_1",
            public_user_data: { user_id: requester.userId },
            created_at: Date.parse(CREATED_AT),
          },
        ],
        total_count: 1,
      });
    });

    signIn(admin, orgId);
    const response = await accept(members().members({ headers }), [200]);

    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList.mock
        .calls[0]?.[0],
    ).toMatchObject({ organizationId: orgId, status: ["pending"] });
    expect(response.body.role).toBe("admin");
    expect(response.body.pendingInvitations).toStrictEqual(
      invitations.map((invitation) => {
        return {
          id: invitation.id,
          email: invitation.emailAddress,
          role: "member",
          createdAt: new Date(invitation.createdAt).toISOString(),
        };
      }),
    );
    expect(response.body.membershipRequests).toMatchObject([
      {
        id: "orgmemreq_1",
        userId: requester.userId,
        email: email(requester.userId),
      },
    ]);
  });

  it("org-member-directory-007 scopes a warm profile cache to current membership after changing organizations", async () => {
    const user = person("admin");
    const firstPeer = person();
    const secondPeer = person();
    const first = await workspace("First workspace", [user, firstPeer]);
    const second = await workspace("Second workspace", [user, secondPeer]);
    clerkProfiles([user.userId, firstPeer.userId, secondPeer.userId]);
    await membersView(user, first);

    const response = await membersView(user, second);

    expect(response.name).toBe("Second workspace");
    expect(
      response.members.map((member) => {
        return member.userId;
      }),
    ).toStrictEqual([user.userId, secondPeer.userId]);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList.mock
        .lastCall?.[0],
    ).toMatchObject({ organizationId: second });
  });

  it("org-member-directory-008 omits departed members and refreshes missing profiles after the cache expires", async () => {
    mockNow(new Date("2026-01-02T00:00:00Z"));
    const admin = person("admin");
    const departing = person();
    const vanishing = person();
    const orgId = await workspace("Refresh workspace", [
      admin,
      departing,
      vanishing,
    ]);
    clerkProfiles([admin.userId, departing.userId, vanishing.userId]);
    const initial = await membersView(admin, orgId);
    expect(initial.members).toHaveLength(3);

    mockNow(new Date("2026-01-02T00:15:00Z"));
    await store.set(
      deleteOrgMembership$,
      { orgId, userId: departing.userId },
      context.signal,
    );
    clerkOrganizations();
    clerkProfiles([admin.userId]);

    const refreshed = await membersView(admin, orgId);
    expect(refreshed.members).toStrictEqual([
      listed(admin),
      {
        userId: vanishing.userId,
        email: "",
        firstName: null,
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: CREATED_AT,
      },
    ]);
  });
});
