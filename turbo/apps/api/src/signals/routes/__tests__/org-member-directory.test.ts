import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
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

describe("organization member directory", () => {
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

  it.each(["getOrganization", "getOrganizationMembershipList"] as const)(
    "keeps required %s failures visible to ordinary members",
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
});
