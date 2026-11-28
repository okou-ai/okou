import { randomUUID } from "node:crypto";
import { iosPushRegistrationsContract } from "@okouai/api-contracts/contracts/ios-push-registrations";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { iosPushRegistrationsRoutes } from "../ios-push-registrations";
import { authenticateIosSession } from "./helpers/ios-push";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const push = () => {
  return setupApp({ context, routes: iosPushRegistrationsRoutes })(
    iosPushRegistrationsContract,
  );
};

function binding(installationId: string, revision: number, token = "ab") {
  return {
    installationId,
    revision,
    deviceToken: token.repeat(32),
    environment: "production" as const,
  };
}

describe("native iOS push registration", () => {
  it("ios-push-registrations-001 requires an app session and fences a late registration after unregister", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const installationId = randomUUID();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return { userId, orgId, orgRole: "org:admin" };
      },
    });

    const sessionless = await accept(
      push().register({ headers, body: binding(installationId, 1) }),
      [403],
    );
    expect(sessionless.body.error.code).toBe("FORBIDDEN");

    authenticateIosSession(context, userId, orgId);
    await accept(
      push().register({ headers, body: binding(installationId, 1) }),
      [200],
    );
    await accept(
      push().unregister({ headers, body: { installationId, revision: 3 } }),
      [200],
    );
    await accept(
      push().register({ headers, body: binding(installationId, 2) }),
      [409],
    );
    await accept(
      push().register({ headers, body: binding(installationId, 4) }),
      [200],
    );
  });

  it("ios-push-registrations-002 rebinds the installation and rejects stale requests from prior sessions", async () => {
    const orgId = `org_${randomUUID()}`;
    const first = `user_${randomUUID()}`;
    const second = `user_${randomUUID()}`;
    const installationId = randomUUID();
    const secondSession = `sess_${randomUUID()}`;

    authenticateIosSession(context, first, orgId);
    await accept(
      push().register({ headers, body: binding(installationId, 1) }),
      [200],
    );
    authenticateIosSession(context, second, orgId, secondSession);
    await accept(
      push().register({ headers, body: binding(installationId, 2, "cd") }),
      [200],
    );

    authenticateIosSession(context, first, orgId);
    await accept(
      push().unregister({ headers, body: { installationId, revision: 3 } }),
      [409],
    );
    await accept(
      push().register({ headers, body: binding(installationId, 1) }),
      [409],
    );

    authenticateIosSession(context, second, orgId, secondSession);
    const current = await accept(
      push().register({ headers, body: binding(installationId, 3, "cd") }),
      [200],
    );
    expect(current.body).toStrictEqual({ success: true });

    authenticateIosSession(context, second, orgId, `sess_${randomUUID()}`);
    await accept(
      push().register({ headers, body: binding(installationId, 4, "cd") }),
      [200],
    );

    authenticateIosSession(context, second, orgId, secondSession);
    await accept(
      push().unregister({ headers, body: { installationId, revision: 5 } }),
      [409],
    );
  });
});
