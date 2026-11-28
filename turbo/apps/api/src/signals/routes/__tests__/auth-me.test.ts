import { randomUUID } from "node:crypto";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { authMeRoutes } from "../auth-me";
import { mockClerkUsers } from "./helpers/clerk-users";

const context = testContext();
const app = setupApp({ context, routes: authMeRoutes });
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(userId: string, orgId: string, sessionId?: string) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { userId, orgId, orgRole: "org:admin", sessionId };
    },
  });
}

function profile(userId: string, primary: string, secondary: string) {
  return {
    id: userId,
    emailAddresses: [
      { id: "email_secondary", emailAddress: secondary },
      { id: "email_primary", emailAddress: primary },
    ],
    primaryEmailAddressId: "email_primary",
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: null,
  };
}

test("auth-me-001 returns the user, workspace and primary email", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  signIn(userId, orgId);
  mockClerkUsers(context, [
    profile(userId, "primary@example.com", "secondary@example.com"),
  ]);

  const response = await accept(app(authContract).me({ headers }), [200]);

  expect(response.body).toStrictEqual({
    userId,
    orgId,
    email: "primary@example.com",
  });
  expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(1);
  expect(context.mocks.clerk.users.getUser.mock.calls[0]?.[0]).toBe(userId);
});

test("auth-me-002 returns the verified session on fresh and repeated reads", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const sessionId = `sess_${randomUUID()}`;
  signIn(userId, orgId, sessionId);
  mockClerkUsers(context, [
    profile(userId, "owner@example.com", "other@example.com"),
  ]);
  const expected = { userId, orgId, email: "owner@example.com", sessionId };

  const first = await accept(app(authContract).me({ headers }), [200]);
  const second = await accept(app(authContract).me({ headers }), [200]);

  expect(first.body).toStrictEqual(expected);
  expect(second.body).toStrictEqual(expected);
  expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(1);
});
