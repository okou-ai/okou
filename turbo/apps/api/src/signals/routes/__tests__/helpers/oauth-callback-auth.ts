import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { mockClerkMembership } from "./api-bdd-clerk";
import { mockClerkUsers } from "./clerk-users";
import { createRouteMocks } from "./route-test";

export const callbackAuthenticationModes = [
  "missing",
  "expired-cookie",
  "matching-cookie",
  "different-user",
  "different-org",
  "invalid-bearer",
] as const;
type CallbackAuthenticationMode = (typeof callbackAuthenticationModes)[number];

export function authenticateCallbackActor(
  context: TestContext,
  actor: ApiTestUser,
): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  mockClerkMembership(context, actor, "org:admin");
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      primaryEmailAddressId: emailId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      firstName: "Callback",
      lastName: "Actor",
    },
  ]);
}

export function callbackBrowserHeaders(
  context: TestContext,
  mode: CallbackAuthenticationMode,
  actor: ApiTestUser,
): Record<string, string> {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const mocks = createRouteMocks(context);
  if (mode === "matching-cookie") {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  }
  if (mode === "different-user") {
    mocks.clerk.session(`other_${actor.userId}`, actor.orgId, "org:admin");
  }
  if (mode === "different-org") {
    mocks.clerk.session(actor.userId, `other_${actor.orgId}`, "org:admin");
  }
  if (mode === "missing") {
    return {};
  }
  if (mode === "invalid-bearer") {
    return { authorization: "Bearer invalid-callback-session" };
  }
  return { cookie: `__session=${mode}-session` };
}

export function callbackNeedsSignIn(mode: CallbackAuthenticationMode): boolean {
  return (
    mode === "missing" || mode === "expired-cookie" || mode === "invalid-bearer"
  );
}
