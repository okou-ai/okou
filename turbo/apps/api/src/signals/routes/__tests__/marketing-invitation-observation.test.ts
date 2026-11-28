import { randomUUID } from "node:crypto";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { orgInviteRoutes } from "../org-invite";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { marketingRewardConsumer } from "./helpers/marketing-reward-consumer";

const context = testContext();
const api = createAuthOrgBddApi(context);
const invitedAt = Date.parse("2026-10-05T09:30:00.000Z");
const expiresAt = invitedAt + 24 * 60 * 60 * 1000;

type ClerkInvitationAuthority =
  { readonly status: "pending" | "accepted" } | { readonly status: "missing" };

/** The member invites a teammate; Clerk owns the invitation's later status. */
async function inviteWithClerkAuthority(authority: ClerkInvitationAuthority) {
  mockEnv("ENV", "development");
  mockNow(invitedAt);
  const consumer = marketingRewardConsumer();
  const member = api.user();
  api.acceptStorageWrites();
  api.mockClerkOrg(member);
  await api.bootstrapLimitedFreeOnboarding(member);
  const orgId = member.orgId;
  if (!orgId) {
    throw new Error("expected a workspace member");
  }
  const invitationId = `orginv_${randomUUID()}`;
  const inviteeEmail = `invitee_${randomUUID()}@example.test`;
  const ticketUrl = `https://accounts.example.test/ticket/${randomUUID()}`;
  const privateNote = `private-note-${randomUUID()}`;
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
    { id: invitationId },
  );
  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/invitations/:invitationId",
      ({ params }) => {
        if (
          params.orgId !== orgId ||
          params.invitationId !== invitationId ||
          authority.status === "missing"
        ) {
          return HttpResponse.json(
            { errors: [{ code: "resource_not_found" }] },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          object: "organization_invitation",
          id: invitationId,
          organization_id: orgId,
          email_address: inviteeEmail,
          role: "org:member",
          status: authority.status,
          expires_at: expiresAt,
          private_metadata: { note: privateNote },
          public_metadata: {},
          url: ticketUrl,
          created_at: invitedAt,
          updated_at: invitedAt,
        });
      },
    ),
  );

  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers: api.authenticate(member),
      body: { email: inviteeEmail, role: "member" },
    }),
    [200],
  );
  await flushWaitUntilForTest();

  const attributed = consumer.received.find((event) => {
    return event.type === "invitation.attributed";
  });
  if (attributed?.type !== "invitation.attributed") {
    throw new Error("expected the invitation claim to be attributed");
  }
  const observed = consumer.received.filter((event) => {
    return event.type === "invitation.status-observed";
  });
  const serialized = JSON.stringify(consumer.received);
  expect(serialized).not.toContain(inviteeEmail);
  expect(serialized).not.toContain(privateNote);
  expect(serialized).not.toContain(ticketUrl);
  return {
    observed,
    claim: {
      version: 6,
      id: expect.any(String),
      environment: "development",
      type: "invitation.status-observed",
      occurredAt: new Date(invitedAt).toISOString(),
      orgId,
      userId: member.userId,
      claimId: attributed.claimId,
      claimCreatedAt: new Date(invitedAt).toISOString(),
      sourceKey: attributed.sourceKey,
      invitationId,
    },
  };
}

describe("Marketing invitation authority observation", () => {
  it("marketing-invitation-observation-002 durably publishes minimal pending authority from the real invitation flow without issuing credits", async () => {
    const { observed, claim } = await inviteWithClerkAuthority({
      status: "pending",
    });

    expect(observed).toStrictEqual([
      {
        ...claim,
        observation: {
          kind: "invitation",
          status: "pending",
          expiresAt: new Date(expiresAt).toISOString(),
        },
      },
    ]);
  });

  it("marketing-invitation-observation-003 durably publishes minimal accepted authority from the real invitation flow without issuing credits", async () => {
    const { observed, claim } = await inviteWithClerkAuthority({
      status: "accepted",
    });

    expect(observed).toStrictEqual([
      {
        ...claim,
        observation: {
          kind: "invitation",
          status: "accepted",
          expiresAt: new Date(expiresAt).toISOString(),
        },
      },
    ]);
  });

  it("marketing-invitation-observation-004 durably publishes minimal unavailable authority from the real invitation flow without issuing credits", async () => {
    const { observed, claim } = await inviteWithClerkAuthority({
      status: "missing",
    });

    expect(observed).toStrictEqual([
      { ...claim, observation: { kind: "unavailable" } },
    ]);
  });
});
