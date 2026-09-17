import { randomUUID } from "node:crypto";

import { authContract } from "@okouai/api-contracts/contracts/auth";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { authMeRoutes } from "../auth-me";
import { createRouteMocks } from "./helpers/route-test";
import { ClerkUserNotFoundTestError } from "./helpers/clerk-users";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: authMeRoutes })(authContract);
}

function actor() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  createRouteMocks(context).clerk.session(userId, orgId);
  return { userId, orgId };
}

test("reads the authenticated user directly and selects the primary email", async () => {
  const current = actor();
  const email = `${current.userId}@example.test`;
  context.mocks.clerk.users.getUser.mockResolvedValue({
    id: current.userId,
    firstName: "Primary",
    lastName: "User",
    imageUrl: "https://images.example.test/profile.png",
    primaryEmailAddressId: "primary",
    emailAddresses: [
      { id: "secondary", emailAddress: `secondary-${email}` },
      { id: "primary", emailAddress: email },
    ],
  });

  const response = await accept(client().me({ headers }), [200]);
  expect(response.body).toStrictEqual({ ...current, email });
  expect(context.mocks.clerk.users.getUser).toHaveBeenCalledExactlyOnceWith(
    current.userId,
  );
  expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
});

test("preserves the auth error when Clerk no longer exposes the user", async () => {
  actor();
  context.mocks.clerk.users.getUser.mockRejectedValue(
    new ClerkUserNotFoundTestError(),
  );
  const response = await accept(client().me({ headers }), [500]);
  expect(response.body).toStrictEqual({ error: "Internal server error" });
  expect(context.mocks.clerk.users.getUser).toHaveBeenCalledOnce();
  expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
});

test("does not substitute a secondary email when the primary email is unavailable", async () => {
  const current = actor();
  context.mocks.clerk.users.getUser.mockResolvedValue({
    id: current.userId,
    primaryEmailAddressId: "deleted-primary",
    emailAddresses: [
      { id: "secondary", emailAddress: `${current.userId}@example.test` },
    ],
  });
  const response = await accept(client().me({ headers }), [500]);
  expect(response.body).toStrictEqual({ error: "Internal server error" });
});
