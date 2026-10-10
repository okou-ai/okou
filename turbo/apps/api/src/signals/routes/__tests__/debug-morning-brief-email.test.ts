import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { debugMorningBriefEmailContract } from "@okouai/api-contracts/contracts/debug-morning-brief-email";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { debugMorningBriefEmailRoutes } from "../debug-morning-brief-email";
import { featureSwitchesRoutes } from "../feature-switches";
import { emailSubscriptionRoutes } from "../email-subscription";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: debugMorningBriefEmailRoutes })(
    debugMorningBriefEmailContract,
  );
};
const features = () => {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
};
const preferences = () => {
  return setupApp({ context, routes: emailSubscriptionRoutes })(
    emailSubscriptionContract,
  );
};

async function actor(debug = true) {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const email = `${randomUUID()}@example.com`;
  mocks.clerk.session(userId, orgId, "org:member");
  mockClerkUsers(context, [
    {
      id: userId,
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: email }],
    },
  ]);
  await accept(
    features().update({
      headers,
      body: {
        switches: { [FeatureSwitchKey.OkouDebug]: debug },
      },
    }),
    [200],
  );
  return { userId, orgId, email };
}

beforeEach(() => {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("RESEND_API_KEY", "test-key");
  mockEnv("RESEND_FROM_DOMAIN", "okou.io");
  context.mocks.resend.send.mockResolvedValue({
    data: { id: "test-provider-id" },
    error: null,
  });
});

describe("Debug Morning Brief test email", () => {
  it("queues a sample without an Agent Run, replays its receipt and permits an intentional new sample", async () => {
    await actor();
    const requestId = randomUUID();
    const queued = await accept(
      client().send({ headers, body: { requestId } }),
      [200],
    );
    expect(queued.body).toStrictEqual({
      requestId,
      status: "queued",
      reason: null,
    });
    expect(
      (
        await accept(
          client().get({ headers, params: { id: requestId } }),
          [200],
        )
      ).body,
    ).toStrictEqual(queued.body);
    expect(
      (await accept(client().send({ headers, body: { requestId } }), [200]))
        .body,
    ).toStrictEqual(queued.body);
    const nextId = randomUUID();
    expect(
      (
        await accept(
          client().send({ headers, body: { requestId: nextId } }),
          [200],
        )
      ).body.requestId,
    ).toBe(nextId);
    // Delivery belongs to the existing worker, not a session-triggered drain.
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent submission into the same owned receipt", async () => {
    await actor();
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => {
        return client().send({ headers, body: { requestId } });
      }),
    );
    for (const result of results) {
      expect(result.body).toStrictEqual({
        requestId,
        status: "queued",
        reason: null,
      });
    }
    expect(
      (
        await accept(
          client().get({ headers, params: { id: requestId } }),
          [200],
        )
      ).body.status,
    ).toBe("queued");
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("treats uppercase and lowercase UUIDs as the same request", async () => {
    await actor();
    const requestId = randomUUID();
    const first = await accept(
      client().send({ headers, body: { requestId: requestId.toUpperCase() } }),
      [200],
    );
    expect(first.body.requestId).toBe(requestId);
    expect(
      (await accept(client().send({ headers, body: { requestId } }), [200]))
        .body,
    ).toStrictEqual(first.body);
    expect(
      (
        await accept(
          client().get({ headers, params: { id: requestId.toUpperCase() } }),
          [200],
        )
      ).body,
    ).toStrictEqual(first.body);
  });

  it("requires Okou Debug", async () => {
    await actor(false);
    await accept(
      client().send({ headers, body: { requestId: randomUUID() } }),
      [403],
    );
    await accept(
      client().get({ headers, params: { id: randomUUID() } }),
      [403],
    );
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("keeps unsubscribe skips on replay and permits an intentional new request after resubscription", async () => {
    await actor();
    await accept(
      preferences().update({ headers, body: { subscribed: false } }),
      [200],
    );
    const requestId = randomUUID();
    expect(
      (await accept(client().send({ headers, body: { requestId } }), [200]))
        .body,
    ).toMatchObject({ status: "skipped", reason: "unsubscribed" });
    await accept(
      preferences().update({ headers, body: { subscribed: true } }),
      [200],
    );
    expect(
      (await accept(client().send({ headers, body: { requestId } }), [200]))
        .body.status,
    ).toBe("skipped");
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
    expect(
      (
        await accept(
          client().send({ headers, body: { requestId: randomUUID() } }),
          [200],
        )
      ).body.status,
    ).toBe("queued");
  });

  it("skips a provider-suppressed address and an account without an email", async () => {
    const owner = await actor();
    mockEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
    const webhooks = createWebhookCallbackApi(context);
    const event = {
      type: "email.bounced",
      data: { email_id: "prior-email", to: [owner.email] },
    };
    await webhooks.requestResendInboundWebhook(
      event,
      webhooks.signedResendWebhookHeaders(event),
      [200],
    );
    expect(
      (
        await accept(
          client().send({ headers, body: { requestId: randomUUID() } }),
          [200],
        )
      ).body,
    ).toMatchObject({ status: "skipped", reason: "suppressed" });
    const noEmail = await actor();
    mockClerkUsers(context, [
      { id: noEmail.userId, primaryEmailAddressId: null, emailAddresses: [] },
    ]);
    expect(
      (
        await accept(
          client().send({ headers, body: { requestId: randomUUID() } }),
          [200],
        )
      ).body,
    ).toMatchObject({ status: "skipped", reason: "no-email" });
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("does not claim a request when delivery is unconfigured", async () => {
    await actor();
    const requestId = randomUUID();
    mockOptionalEnv("RESEND_API_KEY", undefined);
    await accept(client().send({ headers, body: { requestId } }), [503]);
    await accept(client().get({ headers, params: { id: requestId } }), [404]);
    mockOptionalEnv("RESEND_API_KEY", "test-key");
    expect(
      (await accept(client().send({ headers, body: { requestId } }), [200]))
        .body.status,
    ).toBe("queued");
  });

  it("scopes receipts and request IDs to the current owner and workspace", async () => {
    const owner = await actor();
    const requestId = randomUUID();
    await accept(client().send({ headers, body: { requestId } }), [200]);
    await actor();
    await accept(client().get({ headers, params: { id: requestId } }), [404]);
    await accept(client().send({ headers, body: { requestId } }), [409]);
    mocks.clerk.session(owner.userId, `org_${randomUUID()}`, "org:member");
    await accept(
      features().update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.OkouDebug]: true },
        },
      }),
      [200],
    );
    await accept(client().get({ headers, params: { id: requestId } }), [404]);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("rejects caller-selected recipients, body and source links", async () => {
    await actor();
    const raw = setupRawAppRequest({
      context,
      routes: debugMorningBriefEmailRoutes,
    });
    const response = await raw("/api/debug/morning-brief-email", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: randomUUID(),
        to: "other@example.com",
        text: "custom",
        runUrl: "https://example.com",
      }),
    });
    expect(response.status).toBe(400);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("erases the member's test receipt through the normal membership webhook", async () => {
    const owner = await actor();
    const requestId = randomUUID();
    expect(
      (await accept(client().send({ headers, body: { requestId } }), [200]))
        .body.status,
    ).toBe("queued");
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `orgmem_${randomUUID()}`,
        organization_id: owner.orgId,
        user_id: owner.userId,
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    mocks.clerk.session(owner.userId, owner.orgId);
    await accept(client().get({ headers, params: { id: requestId } }), [404]);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("requires a signed-in session", async () => {
    const rejected = await accept(
      client().send({ body: { requestId: randomUUID() } }),
      [401],
    );
    expect(rejected.status).toBe(401);
    await accept(client().get({ params: { id: randomUUID() } }), [401]);
  });
});
