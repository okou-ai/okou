import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { iosPushRegistrationsContract } from "@okouai/api-contracts/contracts/ios-push-registrations";
import { now } from "../../../lib/time";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { iosPushRegistrationsRoutes } from "../ios-push-registrations";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { authenticateIosSession } from "./helpers/ios-push";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: iosPushRegistrationsRoutes })(
    iosPushRegistrationsContract,
  );
};
const binding = () => {
  return {
    installationId: randomUUID(),
    revision: 1,
    deviceToken: "ab".repeat(32),
    environment: "production" as const,
  };
};

describe("native iOS push registration", () => {
  it("requires the feature and a session, while disable still fences a late register with the switch off", async () => {
    const actor = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const body = binding();
    authenticateIosSession(context, actor.userId, actor.orgId);
    const unavailable = await accept(
      client().register({ headers, body }),
      [403],
    );
    expect(unavailable.body.error.code).toBe("FORBIDDEN");
    await updateFeatureSwitchesForUser(context, actor, {
      iosPushNotifications: true,
    });
    // An authenticated identity without a session id cannot bind a device.
    await accept(client().register({ headers, body }), [403]);
    authenticateIosSession(context, actor.userId, actor.orgId);
    await accept(client().register({ headers, body }), [200]);
    await updateFeatureSwitchesForUser(context, actor, {
      iosPushNotifications: false,
    });
    authenticateIosSession(context, actor.userId, actor.orgId);
    await accept(
      client().unregister({ headers, body: { ...body, revision: 3 } }),
      [200],
    );
    await updateFeatureSwitchesForUser(context, actor, {
      iosPushNotifications: true,
    });
    authenticateIosSession(context, actor.userId, actor.orgId);
    await accept(
      client().register({ headers, body: { ...body, revision: 2 } }),
      [409],
    );
    await accept(
      client().register({ headers, body: { ...body, revision: 4 } }),
      [200],
    );
  });

  it("atomically rebinds accounts and rejects stale sign-out and token updates from the prior session", async () => {
    const first = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const second = { userId: `user_${randomUUID()}`, orgId: first.orgId };
    for (const actor of [first, second]) {
      await updateFeatureSwitchesForUser(context, actor, {
        iosPushNotifications: true,
      });
    }
    const body = binding();
    authenticateIosSession(context, first.userId, first.orgId);
    await accept(client().register({ headers, body }), [200]);
    authenticateIosSession(context, second.userId, second.orgId);
    await accept(
      client().register({
        headers,
        body: { ...body, revision: 2, deviceToken: "cd".repeat(32) },
      }),
      [200],
    );
    authenticateIosSession(context, first.userId, first.orgId);
    await accept(
      client().unregister({ headers, body: { ...body, revision: 3 } }),
      [409],
    );
    await accept(client().register({ headers, body }), [409]);
    authenticateIosSession(context, second.userId, second.orgId);
    const response = await accept(
      client().register({ headers, body: { ...body, revision: 3 } }),
      [200],
    );
    expect(response.body.success).toBeTruthy();
    authenticateIosSession(
      context,
      second.userId,
      second.orgId,
      "sess_replacement",
    );
    await accept(
      client().register({ headers, body: { ...body, revision: 4 } }),
      [200],
    );
    authenticateIosSession(context, second.userId, second.orgId);
    await accept(
      client().unregister({ headers, body: { ...body, revision: 5 } }),
      [409],
    );
  });

  it.each(["revoked", "expired"] as const)(
    "rejects a %s session before creating a registration",
    async (scenario) => {
      const actor = {
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      };
      await updateFeatureSwitchesForUser(context, actor, {
        iosPushNotifications: true,
      });
      authenticateIosSession(context, actor.userId, actor.orgId);
      context.mocks.clerk.sessions.getSession.mockResolvedValue({
        id: `sess_${actor.userId}`,
        userId: actor.userId,
        status: scenario === "revoked" ? "revoked" : "active",
        expireAt: scenario === "expired" ? 0 : now() + 86_400_000,
      });
      const rejected = await accept(
        client().register({ headers, body: binding() }),
        [401],
      );
      expect(rejected.body.error.code).toBe("UNAUTHORIZED");
    },
  );
});
