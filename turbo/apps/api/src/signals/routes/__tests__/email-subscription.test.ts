import { ClerkUserNotFoundTestError } from "./helpers/clerk-users";
import { createHmac, randomUUID } from "node:crypto";

import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { emailUnsubscribeContract } from "@okouai/api-contracts/contracts/email-unsubscribe";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { emailSubscriptionRoutes } from "../email-subscription";
import { emailUnsubscribeRoutes } from "../email-unsubscribe";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: emailSubscriptionRoutes })(
    emailSubscriptionContract,
  );
}

async function actor(enabled = true) {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const email = `${userId}@example.test`;
  context.mocks.clerk.users.getUser.mockResolvedValue({
    id: userId,
    primaryEmailAddressId: "primary",
    firstName: "Test",
    lastName: "User",
    emailAddresses: [{ id: "primary", emailAddress: email }],
    imageUrl: null,
  });
  await updateFeatureSwitchesForUser(
    context,
    { userId, orgId },
    { [FeatureSwitchKey.MorningBrief]: enabled },
  );
  return { userId, orgId, email };
}

describe("email subscription preferences", () => {
  it("persists the current user's preference across workspaces and isolates other users", async () => {
    const owner = await actor();
    const initial = await accept(client().get({ headers }), [200]);
    expect(initial.body).toStrictEqual({
      subscribed: true,
      email: owner.email,
      deliveryStatus: "available",
    });

    await accept(
      client().update({ headers, body: { subscribed: false } }),
      [200],
    );
    const otherOrg = `org_${randomUUID()}`;
    await updateFeatureSwitchesForUser(
      context,
      { userId: owner.userId, orgId: otherOrg },
      { [FeatureSwitchKey.MorningBrief]: true },
    );
    expect(
      (await accept(client().get({ headers }), [200])).body.subscribed,
    ).toBeFalsy();

    const other = await actor();
    expect((await accept(client().get({ headers }), [200])).body).toMatchObject(
      { subscribed: true, email: other.email },
    );
    mocks.clerk.session(owner.userId, owner.orgId);
    await accept(
      client().update({ headers, body: { subscribed: true } }),
      [200],
    );
    expect(
      (await accept(client().get({ headers }), [200])).body.subscribed,
    ).toBeTruthy();
  });

  it("reads one-click opt-outs and allows explicit resubscription", async () => {
    const owner = await actor();
    const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
      .update(`unsubscribe:${owner.userId}`)
      .digest("hex")
      .slice(0, 32);
    const query = { token: `${owner.userId}.${signature}` };
    const unsubscribe = setupApp({ context, routes: emailUnsubscribeRoutes })(
      emailUnsubscribeContract,
    );
    await accept(unsubscribe.get({ query }), [302]);
    expect(
      (await accept(client().get({ headers }), [200])).body.subscribed,
    ).toBeTruthy();
    await accept(unsubscribe.unsubscribe({ query }), [200]);
    expect(
      (await accept(client().get({ headers }), [200])).body.subscribed,
    ).toBeFalsy();
    await accept(
      client().update({ headers, body: { subscribed: true } }),
      [200],
    );
    expect(
      (await accept(client().get({ headers }), [200])).body.subscribed,
    ).toBeTruthy();
  });

  it.each(["email.bounced", "email.complained"])(
    "keeps %s suppression after resubscribing",
    async (type) => {
      const owner = await actor();
      const webhooks = createWebhookCallbackApi(context);
      const event = {
        type,
        data: { to: [owner.email.toUpperCase()], email_id: randomUUID() },
      };
      await webhooks.requestResendInboundWebhook(
        event,
        webhooks.signedResendWebhookHeaders(event),
        [200],
      );
      await accept(
        client().update({ headers, body: { subscribed: true } }),
        [200],
      );
      expect(
        (await accept(client().get({ headers }), [200])).body,
      ).toMatchObject({ subscribed: true, deliveryStatus: "suppressed" });
    },
  );

  it("reports a missing recipient without inventing an email address", async () => {
    await actor();
    context.mocks.clerk.users.getUser.mockRejectedValue(
      new ClerkUserNotFoundTestError(),
    );
    expect((await accept(client().get({ headers }), [200])).body).toStrictEqual(
      { subscribed: true, email: null, deliveryStatus: "no-email" },
    );
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledOnce();
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("retains the first email when the primary address no longer resolves", async () => {
    const owner = await actor();
    context.mocks.clerk.users.getUser.mockResolvedValue({
      id: owner.userId,
      primaryEmailAddressId: "deleted-primary",
      emailAddresses: [{ id: "secondary", emailAddress: owner.email }],
    });
    expect((await accept(client().get({ headers }), [200])).body).toStrictEqual(
      {
        subscribed: true,
        email: owner.email,
        deliveryStatus: "available",
      },
    );
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledExactlyOnceWith(
      owner.userId,
    );
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("contains both endpoints under the Morning Brief switch", async () => {
    await actor(false);
    const response = await accept(client().get({ headers }), [403]);
    expect(response.body.error.code).toBe("FORBIDDEN");
    await accept(
      client().update({ headers, body: { subscribed: false } }),
      [403],
    );
  });

  it("rejects invalid writes without changing the saved preference", async () => {
    await actor();
    const request = setupRawAppRequest({
      context,
      routes: emailSubscriptionRoutes,
    });
    const response = await request("/api/preferences/email-subscription", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ subscribed: "false" }),
    });
    expect(response.status).toBe(400);
    expect(
      (await accept(client().get({ headers }), [200])).body.subscribed,
    ).toBeTruthy();
  });

  it.each([
    ["unexpected failure", new Error("Clerk request failed")],
    ["rate limit", new ClerkTransportTestError(429)],
    ["server failure", new ClerkTransportTestError(503)],
    ["transport failure", new ClerkTransportTestError()],
    [
      "unbranded 404",
      Object.assign(new Error("Not a Clerk miss"), { status: 404 }),
    ],
  ])(
    "does not disguise %s as an unavailable recipient",
    async (_name, error) => {
      await actor();
      context.mocks.signalTimers.delay.mockResolvedValue(undefined);
      context.mocks.clerk.users.getUser.mockRejectedValue(error);
      const response = await accept(client().get({ headers }), [500]);
      expect(response.status).toBe(500);
      expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
    },
  );

  it("requires an active workspace for rollout evaluation", async () => {
    const owner = await actor();
    mocks.clerk.session(owner.userId, null);
    const response = await accept(client().get({ headers }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    await accept(
      client().update({ headers, body: { subscribed: false } }),
      [401],
    );
  });

  it("requires a signed-in session and rejects run credentials", async () => {
    await accept(client().get({ headers: {} }), [401]);
    await accept(
      client().update({ headers: {}, body: { subscribed: false } }),
      [401],
    );
    const owner = await actor();
    const timestamp = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      ...owner,
      runId: randomUUID(),
      capabilities: ["agent:write"],
      iat: timestamp,
      exp: timestamp + 60,
    });
    const runHeaders = { authorization: `Bearer ${token}` };
    const response = await accept(client().get({ headers: runHeaders }), [403]);
    expect(response.body.error.code).toBe("FORBIDDEN");
    await accept(
      client().update({ headers: runHeaders, body: { subscribed: true } }),
      [403],
    );
  });
});
