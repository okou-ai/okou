import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { orgInviteRoutes } from "../org-invite";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

class ClerkInvitationTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly longMessage: string;
  }[];

  constructor(
    code: string,
    readonly status: number,
    longMessage = code,
  ) {
    super(`Clerk invitation failed: ${code}`);
    this.errors = [{ code, message: code, longMessage }];
  }
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

async function org(userId = `user_${randomUUID()}`) {
  const orgId = `org_${randomUUID()}`;
  const api = createBddApi(context);
  await api.completeOnboarding(api.user({ userId, orgId }));
  mocks.clerk.session(userId, orgId);
  return { userId, orgId };
}

test.each([
  [
    "already_a_member_in_organization",
    400,
    "INVITEE_ALREADY_MEMBER",
    "This person is already a member.",
  ],
  [
    "duplicate_record",
    422,
    "INVITATION_ALREADY_EXISTS",
    "This person already has a pending invitation.",
  ],
  [
    "organization_invitation_not_unique",
    409,
    "INVITATION_ALREADY_EXISTS",
    "This person already has a pending invitation.",
  ],
] as const)(
  "maps Clerk invitation conflict %s to a stable 409",
  async (code, status, errorCode, message) => {
    await org();
    context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new ClerkInvitationTestError(code, status),
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
        headers,
        body: { email: `${randomUUID()}@example.com`, role: "member" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: { code: errorCode, message },
    });
  },
);

test("returns an address-level error when Clerk rejects the email format without recording invitation progress", async () => {
  await org();
  context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
    new ClerkInvitationTestError(
      "form_param_format_invalid",
      422,
      "Email address must be a valid email address.",
    ),
  );

  const response = await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers,
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [400],
  );

  expect(response.body).toStrictEqual({
    error: { code: "BAD_REQUEST", message: "Enter a valid email address." },
  });
});

test.each([
  ["invalid_clerk_configuration", 400, "invalid_clerk_configuration"],
  ["form_param_format_invalid", 422, "Redirect URL must be a valid URL."],
] as const)(
  "keeps unrelated Clerk invitation failure %s as a server error",
  async (code, status, longMessage) => {
    await org();
    context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new ClerkInvitationTestError(code, status, longMessage),
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
        headers,
        body: { email: `${randomUUID()}@example.com`, role: "member" },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
  },
);
