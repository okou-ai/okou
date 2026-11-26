import { randomUUID } from "node:crypto";

import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { orgInviteRoutes } from "../org-invite";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";

const context = testContext();
const api = createAuthOrgBddApi(context);

async function onboardedAdmin(): Promise<ApiTestUser> {
  const admin = api.user();
  api.acceptStorageWrites();
  api.mockClerkOrg(admin);
  await api.bootstrapLimitedFreeOnboarding(admin);
  return admin;
}

function clerkRejectsInvitation(
  status: number,
  error: { readonly code: string; readonly longMessage?: string },
): void {
  context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValue(
    new ClerkTransportTestError(status, [
      { message: error.longMessage ?? error.code, ...error },
    ]),
  );
}

function invite(admin: ApiTestUser) {
  return setupApp({ context, routes: orgInviteRoutes })(
    orgInviteContract,
  ).invite({
    headers: api.authenticate(admin),
    body: { email: `invitee_${randomUUID()}@example.test`, role: "member" },
  });
}

describe("get-started invitations", () => {
  it("get-started-invitations-001 reports an invitee who is already a member as a conflict", async () => {
    const admin = await onboardedAdmin();
    clerkRejectsInvitation(400, { code: "already_a_member_in_organization" });

    const response = await accept(invite(admin), [409]);
    expect(response.body).toStrictEqual({
      error: {
        code: "INVITEE_ALREADY_MEMBER",
        message: "This person is already a member.",
      },
    });
  });

  it("get-started-invitations-002 reports an invitee with a pending invitation as a conflict", async () => {
    const admin = await onboardedAdmin();
    clerkRejectsInvitation(422, { code: "duplicate_record" });

    const response = await accept(invite(admin), [409]);
    expect(response.body).toStrictEqual({
      error: {
        code: "INVITATION_ALREADY_EXISTS",
        message: "This person already has a pending invitation.",
      },
    });
  });

  it("get-started-invitations-004 asks for a valid address when the identity provider rejects its format", async () => {
    const admin = await onboardedAdmin();
    clerkRejectsInvitation(422, {
      code: "form_param_format_invalid",
      longMessage: "Email address must be a valid email address.",
    });

    const response = await accept(invite(admin), [400]);
    expect(response.body).toStrictEqual({
      error: { code: "BAD_REQUEST", message: "Enter a valid email address." },
    });
  });
});
