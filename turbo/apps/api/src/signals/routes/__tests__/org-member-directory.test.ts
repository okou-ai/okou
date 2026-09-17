import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const invitationListParams = z.object({
  organizationId: z.string(),
  status: z.array(z.literal("pending")),
  limit: z.number(),
  offset: z.number(),
});

async function useInvitationTransport(): Promise<void> {
  const sdk =
    await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
  const client = sdk.createClerkClient({
    secretKey: "sk_test_member_directory",
  });
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockImplementation(
    (params) => {
      return client.organizations.getOrganizationInvitationList(
        invitationListParams.parse(params),
      );
    },
  );
}

async function useDirectoryTransport(): Promise<void> {
  const sdk =
    await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
  const client = sdk.createClerkClient({
    secretKey: "sk_test_member_directory",
  });
  const organizationParams = z.object({ organizationId: z.string() });
  const membershipParams = organizationParams.extend({
    limit: z.number(),
    offset: z.number(),
  });
  const userParams = z.object({
    userId: z.array(z.string()),
    limit: z.number(),
  });
  context.mocks.clerk.organizations.getOrganization.mockImplementation(
    (params) => {
      return client.organizations.getOrganization(
        organizationParams.parse(params),
      );
    },
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (params) => {
      return client.organizations.getOrganizationMembershipList(
        membershipParams.parse(params),
      );
    },
  );
  context.mocks.clerk.users.getUserList.mockImplementation((params) => {
    return client.users.getUserList(userParams.parse(params));
  });
}

describe("organization member directory", () => {
  it.each(["org:admin", "org:member"] as const)(
    "serves the members view to %s without failed management reads",
    async (orgRole) => {
      const actor = api.user({ orgRole });
      const peer = api.user({ orgId: actor.orgId, orgRole: "org:member" });
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      api.mockClerkOrg(actor, {
        name: "Members only workspace",
        members: [{ actor }, { actor: peer }],
      });
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockRejectedValue(
        new Error("Invitations are unavailable"),
      );
      const requests = api.mockClerkMembershipRequestHandlers(actor.orgId, {
        listStatus: 429,
        retryAfterSeconds: 7,
      });

      const directory = await api.listMembers(actor, { view: "members" });

      expect(directory).toMatchObject({
        name: "Members only workspace",
        role: orgRole === "org:admin" ? "admin" : "member",
        createdAt: "2026-01-01T00:00:00.000Z",
        members: [
          {
            userId: actor.userId,
            email: actor.email,
            firstName: "BDD",
            lastName: "Actor",
            imageUrl: `https://example.test/${actor.userId}.png`,
            role: orgRole === "org:admin" ? "admin" : "member",
            joinedAt: "2026-01-01T00:00:00.000Z",
          },
          { userId: peer.userId, email: peer.email, role: "member" },
        ],
      });
      expect(directory).not.toHaveProperty("pendingInvitations");
      expect(directory).not.toHaveProperty("membershipRequests");
      expect(
        context.mocks.clerk.organizations.getOrganizationInvitationList,
      ).not.toHaveBeenCalled();
      expect(requests.listCalls()).toBe(0);
    },
  );

  it("serves members without admin transport while preserving admin invitation failures", async () => {
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    if (!admin.orgId) {
      throw new Error("Expected an organization");
    }
    api.mockClerkOrg(admin, {
      name: "Directory workspace",
      members: [{ actor: admin }, { actor: member }],
    });
    const requests = api.mockClerkMembershipRequestHandlers(admin.orgId, {
      listStatus: 429,
      retryAfterSeconds: 7,
    });
    await useInvitationTransport();
    let invitationCalls = 0;
    server.use(
      http.get(
        `https://api.clerk.com/v1/organizations/${admin.orgId}/invitations`,
        () => {
          invitationCalls++;
          return HttpResponse.json(
            {
              errors: [
                { code: "rate_limit_exceeded", message: "Too many requests" },
              ],
            },
            { status: 429, headers: { "Retry-After": "7" } },
          );
        },
      ),
    );

    const directory = await api.listMembers(member);

    expect(directory).toMatchObject({
      name: "Directory workspace",
      role: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
      pendingInvitations: [],
      membershipRequests: [],
      members: [
        { userId: admin.userId, email: admin.email, role: "admin" },
        { userId: member.userId, email: member.email, role: "member" },
      ],
    });
    expect(invitationCalls).toBe(0);
    expect(requests.listCalls()).toBe(0);

    const unavailable = await api.requestListMembers(admin, [503]);

    expect(unavailable.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Organization members are temporarily unavailable",
      },
    });
    expect(unavailable.headers.get("Retry-After")).toBe("7");
    expect(unavailable.headers.get("Cache-Control")).toBe("no-store");
    expect(invitationCalls).toBe(1);
  });

  it("returns every pending invitation page and membership requests for admins", async () => {
    const admin = api.user();
    const requester = api.user({ orgId: null });
    const requestId = `request_${requester.userId}`;
    const createdAt = Date.parse("2026-01-02T00:00:00.000Z");
    api.mockClerkOrg(admin, {
      membershipRequests: [{ id: requestId, actor: requester, createdAt }],
    });
    await useInvitationTransport();
    const invitations = Array.from({ length: 101 }, (_, index) => {
      return {
        object: "organization_invitation",
        id: `inv_${admin.orgId}_${index}`,
        organization_id: admin.orgId,
        email_address: `invitee-${index}@example.test`,
        role: "org:member",
        status: "pending",
        created_at: createdAt,
        updated_at: createdAt,
        public_metadata: {},
        private_metadata: {},
      };
    });
    server.use(
      http.get(
        `https://api.clerk.com/v1/organizations/${admin.orgId}/invitations`,
        ({ request }) => {
          const params = new URL(request.url).searchParams;
          expect(params.get("status")).toBe("pending");
          const offset = Number(params.get("offset"));
          const limit = Number(params.get("limit"));
          return HttpResponse.json({
            data: invitations.slice(offset, offset + limit),
            total_count: invitations.length,
          });
        },
      ),
    );

    const directory = await api.listMembers(admin);

    expect(directory.role).toBe("admin");
    expect(directory.pendingInvitations).toStrictEqual(
      invitations.map((invitation) => {
        return {
          id: invitation.id,
          email: invitation.email_address,
          role: "member",
          createdAt: new Date(createdAt).toISOString(),
        };
      }),
    );
    expect(directory.membershipRequests).toStrictEqual([
      expect.objectContaining({
        id: requestId,
        userId: requester.userId,
        email: requester.email,
      }),
    ]);
  });

  it("preserves membership-request failures for the default admin view", async () => {
    const admin = api.user();
    if (!admin.orgId) {
      throw new Error("Expected an organization");
    }
    api.mockClerkOrg(admin);
    api.mockClerkMembershipRequestHandlers(admin.orgId, {
      listStatus: 429,
      retryAfterSeconds: 7,
    });

    const unavailable = await api.requestListMembers(admin, [503]);

    expect(unavailable.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Organization members are temporarily unavailable",
      },
    });
    expect(unavailable.headers.get("Retry-After")).toBe("7");
    expect(unavailable.headers.get("Cache-Control")).toBe("no-store");
  });

  it("requires authentication and an active organization for the members view", async () => {
    const anonymous = await api.requestListMembers(null, [401], {
      view: "members",
    });
    const noOrganization = await api.requestListMembers(
      api.user({ orgId: null }),
      [401],
      { view: "members" },
    );

    expect(anonymous.status).toBe(401);
    expect(noOrganization.status).toBe(401);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
  });

  it("scopes a warm profile cache to current membership after changing organizations", async () => {
    const firstOrgAdmin = api.user();
    const firstOrgPeer = api.user({ orgId: firstOrgAdmin.orgId });
    api.mockClerkOrg(firstOrgAdmin, {
      members: [{ actor: firstOrgAdmin }, { actor: firstOrgPeer }],
    });
    await api.listMembers(firstOrgAdmin, { view: "members" });
    const secondOrgAdmin = api.user({
      userId: firstOrgAdmin.userId,
      email: firstOrgAdmin.email,
    });
    const secondOrgPeer = api.user({ orgId: secondOrgAdmin.orgId });
    api.mockClerkOrg(secondOrgAdmin, {
      name: "Second workspace",
      members: [{ actor: secondOrgAdmin }, { actor: secondOrgPeer }],
    });

    const directory = await api.listMembers(secondOrgAdmin, {
      view: "members",
    });

    expect(directory.name).toBe("Second workspace");
    expect(
      directory.members.map((member) => {
        return member.userId;
      }),
    ).toStrictEqual([secondOrgAdmin.userId, secondOrgPeer.userId]);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: secondOrgAdmin.orgId }),
    );
  });

  it("omits departed members and refreshes missing profiles after the cache expires", async () => {
    const admin = api.user();
    const departed = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const missing = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const currentTime = now();
    mockNow(currentTime);
    api.mockClerkOrg(admin, {
      members: [{ actor: admin }, { actor: departed }, { actor: missing }],
    });
    const initial = await api.listMembers(admin, { view: "members" });
    expect(initial.members).toHaveLength(3);

    mockNow(currentTime + 15 * 60 * 1000);
    api.mockClerkOrg(admin, {
      members: [{ actor: admin }, { actor: missing }],
    });
    api.mockClerkUsers([admin]);
    const refreshed = await api.listMembers(admin, { view: "members" });

    expect(refreshed.members).toStrictEqual([
      expect.objectContaining({ userId: admin.userId, email: admin.email }),
      {
        userId: missing.userId,
        email: "",
        firstName: null,
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it.each([3, 101])(
    "reduces cold and warm HTTP reads for a %i-member directory",
    async (memberCount) => {
      const admin = api.user();
      if (!admin.orgId) {
        throw new Error("Expected an organization");
      }
      const members = [
        admin,
        ...Array.from({ length: memberCount - 1 }, () => {
          return api.user({ orgId: admin.orgId, orgRole: "org:member" });
        }),
      ];
      const currentTime = now();
      mockNow(currentTime);
      api.mockClerkOrg(admin);
      await useDirectoryTransport();
      await useInvitationTransport();
      const traces: URL[] = [];
      const organization = {
        object: "organization",
        id: admin.orgId,
        name: "Paged workspace",
        slug: `directory-${admin.orgId}`,
        created_at: Date.parse("2026-01-01T00:00:00.000Z"),
      };
      server.use(
        http.get(
          `https://api.clerk.com/v1/organizations/${admin.orgId}`,
          ({ request }) => {
            traces.push(new URL(request.url));
            return HttpResponse.json(organization);
          },
        ),
        http.get(
          `https://api.clerk.com/v1/organizations/${admin.orgId}/memberships`,
          ({ request }) => {
            const url = new URL(request.url);
            traces.push(url);
            const offset = Number(url.searchParams.get("offset"));
            const limit = Number(url.searchParams.get("limit"));
            return HttpResponse.json({
              data: members.slice(offset, offset + limit).map((member) => {
                return {
                  object: "organization_membership",
                  id: `membership_${member.userId}`,
                  role: member.orgRole,
                  organization,
                  public_user_data: { user_id: member.userId },
                  created_at: organization.created_at,
                };
              }),
              total_count: members.length,
            });
          },
        ),
        http.get("https://api.clerk.com/v1/users", ({ request }) => {
          const url = new URL(request.url);
          traces.push(url);
          const requestedIds = url.searchParams.getAll("user_id");
          return HttpResponse.json(
            members
              .filter((member) => {
                return requestedIds.includes(member.userId);
              })
              .map((member) => {
                return {
                  object: "user",
                  id: member.userId,
                  first_name: "Directory",
                  last_name: "Member",
                  image_url: `https://example.test/${member.userId}.png`,
                  primary_email_address_id: `email_${member.userId}`,
                  email_addresses: [
                    {
                      id: `email_${member.userId}`,
                      email_address: member.email,
                      linked_to: [],
                    },
                  ],
                };
              }),
          );
        }),
        http.get("https://api.clerk.com/v1/users/count", ({ request }) => {
          const url = new URL(request.url);
          traces.push(url);
          return HttpResponse.json({
            object: "total_count",
            total_count: url.searchParams.getAll("user_id").length,
          });
        }),
        http.get(
          `https://api.clerk.com/v1/organizations/${admin.orgId}/invitations`,
          ({ request }) => {
            traces.push(new URL(request.url));
            return HttpResponse.json({ data: [], total_count: 0 });
          },
        ),
        http.get(
          `https://api.clerk.com/v1/organizations/${admin.orgId}/membership_requests`,
          ({ request }) => {
            traces.push(new URL(request.url));
            return HttpResponse.json({ data: [] });
          },
        ),
      );

      const fullCold = await api.listMembers(admin);

      expect(fullCold.members).toHaveLength(memberCount);
      expect(fullCold.pendingInvitations).toStrictEqual([]);
      expect(fullCold.membershipRequests).toStrictEqual([]);
      expect(traces).toHaveLength(memberCount === 3 ? 6 : 9);

      traces.length = 0;
      const fullWarm = await api.listMembers(admin);

      expect(fullWarm).toStrictEqual(fullCold);
      expect(traces).toHaveLength(memberCount === 3 ? 4 : 5);

      // Expire only this fixture's profiles before comparing cold requests.
      mockNow(currentTime + 15 * 60 * 1000);
      traces.length = 0;
      const cold = await api.listMembers(admin, { view: "members" });

      expect(
        cold.members.map((member) => {
          return member.email;
        }),
      ).toStrictEqual(
        members.map((member) => {
          return member.email;
        }),
      );
      expect(cold).not.toHaveProperty("pendingInvitations");
      expect(cold).not.toHaveProperty("membershipRequests");
      expect(traces).toHaveLength(memberCount === 3 ? 4 : 7);
      const profileReads = traces.filter((url) => {
        return url.pathname === "/v1/users";
      });
      expect(
        profileReads.map((url) => {
          return url.searchParams.getAll("user_id").length;
        }),
      ).toStrictEqual(memberCount === 3 ? [3] : [100, 1]);
      expect(
        traces.filter((url) => {
          return url.pathname === "/v1/users/count";
        }),
      ).toHaveLength(memberCount === 3 ? 1 : 2);
      expect(
        traces
          .filter((url) => {
            return url.pathname.endsWith("/memberships");
          })
          .map((url) => {
            return Number(url.searchParams.get("offset"));
          }),
      ).toStrictEqual(memberCount === 3 ? [0] : [0, 100]);
      expect(
        traces.some((url) => {
          return (
            url.pathname.endsWith("/invitations") ||
            url.pathname.endsWith("/membership_requests")
          );
        }),
      ).toBeFalsy();

      traces.length = 0;
      const warm = await api.listMembers(admin, { view: "members" });

      expect(warm).toStrictEqual(cold);
      expect(traces).toHaveLength(memberCount === 3 ? 2 : 3);
      expect(
        traces.every((url) => {
          return (
            url.pathname === `/v1/organizations/${admin.orgId}` ||
            url.pathname.endsWith("/memberships")
          );
        }),
      ).toBeTruthy();
    },
  );

  it.each(["getOrganization", "getOrganizationMembershipList"] as const)(
    "keeps required %s failures visible in the default member view",
    async (operation) => {
      const member = api.user({ orgRole: "org:member" });
      api.mockClerkOrg(member);
      context.mocks.clerk.organizations[operation].mockRejectedValue(
        new Error("Required Clerk read failed"),
      );

      const unavailable = await api.requestListMembers(member, [500]);

      expect(unavailable.status).toBe(500);
    },
  );

  it.each([
    ["org:admin", "getOrganization"],
    ["org:admin", "getOrganizationMembershipList"],
    ["org:member", "getOrganization"],
    ["org:member", "getOrganizationMembershipList"],
  ] as const)(
    "keeps required %s %s failures visible in the members view",
    async (orgRole, operation) => {
      const actor = api.user({ orgRole });
      api.mockClerkOrg(actor);
      context.mocks.clerk.organizations[operation].mockRejectedValue(
        new Error("Required Clerk read failed"),
      );

      const unavailable = await api.requestListMembers(actor, [500], {
        view: "members",
      });

      expect(unavailable.status).toBe(500);
    },
  );
});
