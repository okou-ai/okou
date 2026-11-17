import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { marketingRewardProjectionContract } from "@okouai/api-contracts/contracts/marketing-reward-projection";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { marketingRewardProjectionRoutes } from "../marketing-reward-projection";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
import { orgInviteRoutes } from "../org-invite";
import { createRouteMocks } from "./helpers/route-test";
import { readGetStartedStatus } from "./helpers/get-started";
import { captureRewardProjectionPublications } from "./helpers/reward-projection-publications";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import {
  campaignRequest,
  marketingRewardConsumer,
} from "./helpers/marketing-reward-consumer";

const context = testContext();
const bdd = createBddApi(context);
const projectionSecret =
  "projection-notification-service-secret-123456789012345";
const settlementSecret = "settlement-financial-service-secret-123456789012345";
const headers = Object.freeze({ authorization: `Bearer ${projectionSecret}` });

function projectionClient() {
  mockEnv("MARKETING_REWARDS_PROJECTION_SECRET", projectionSecret);
  return setupApp({ context, routes: marketingRewardProjectionRoutes })(
    marketingRewardProjectionContract,
  );
}

async function invitationFixture() {
  const consumer = marketingRewardConsumer(context);
  const actor = bdd.user();
  await bdd.completeOnboarding(actor);
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
    { id: `inv_${randomUUID()}` },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers: { authorization: "Bearer clerk-session" },
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [200],
  );
  await consumer.deliver();
  const source = consumer.received.find((event) => {
    return event.type === "invitation.attributed";
  });
  if (!source || source.type !== "invitation.attributed") {
    throw new Error("Expected original invitation proof");
  }
  return { actor, source, consumer };
}

test("authenticates nonfinancial refreshes before resolving source proofs and rejects another environment", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const api = projectionClient();
  const body = {
    version: 1 as const,
    environment: "development" as const,
    source: { kind: "event" as const, eventId: randomUUID() },
  };
  for (const credential of [
    "clerk-session",
    settlementSecret,
    "source-read-secret",
  ]) {
    const response = await api.notifyProgress({
      body,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await api.notifyProgress({ body, headers })).status).toBe(404);
  expect(
    (
      await api.notifyProgress({
        body: { ...body, environment: "production" },
        headers,
      })
    ).status,
  ).toBe(409);
  mockEnv("MARKETING_REWARDS_PROJECTION_SECRET", undefined);
  expect((await api.notifyProgress({ body, headers })).status).toBe(503);
});

test("deduplicates source refreshes durably without changing pending invitations or choosing the recipient from the request", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await invitationFixture();
  const api = projectionClient();
  const publications = captureRewardProjectionPublications(context);
  const body = {
    version: 1 as const,
    environment: "development" as const,
    source: { kind: "event" as const, eventId: fixture.source.id },
  };
  const forged = { ...body, beneficiaryUserId: "caller-chosen-user" };
  expect((await api.notifyProgress({ body: forged, headers })).status).toBe(
    400,
  );
  const acknowledgements = await Promise.all(
    Array.from({ length: 4 }, () => {
      return accept(api.notifyProgress({ body, headers }), [200]);
    }),
  );
  const first = acknowledgements[0];
  if (!first) {
    throw new Error("Expected durable progress acknowledgement");
  }
  for (const result of acknowledgements) {
    expect(result.body).toStrictEqual(first.body);
  }
  expect(first.body).toMatchObject({
    ...body,
    notificationId: expect.any(String),
  });
  expect(publications).toStrictEqual([]);
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
  expect(
    (await accept(api.notifyProgress({ body, headers }), [200])).body,
  ).toStrictEqual(first.body);
  await fixture.consumer.deliver();
  expect(publications).toHaveLength(1);
  expect(
    (await readGetStartedStatus(context, fixture.actor)).quests.find(
      (quest) => {
        return quest.key === "invite";
      },
    ),
  ).toMatchObject({ claimedCount: 0, pendingCount: 1, earnedCredits: 0 });
});

test("validates the original invitation claim reference and recovers failed nonfinancial delivery without settlement credentials", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await invitationFixture();
  const api = projectionClient();
  const publications = captureRewardProjectionPublications(context, true);
  const body = {
    version: 1 as const,
    environment: "development" as const,
    source: {
      kind: "invitation-claim" as const,
      claimId: fixture.source.claimId,
      invitationId: fixture.source.invitationId,
    },
  };
  expect(
    (
      await api.notifyProgress({
        body: { ...body, source: { ...body.source, claimId: randomUUID() } },
        headers,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api.notifyProgress({
        body: {
          ...body,
          source: { ...body.source, invitationId: "another-invitation" },
        },
        headers,
      })
    ).status,
  ).toBe(409);
  const ack = await accept(api.notifyProgress({ body, headers }), [200]);
  expect(ack.body).toMatchObject(body);
  mockNow(new Date("2026-01-01T00:00:00.000Z"));
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([]);
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
  expect(
    (await readGetStartedStatus(context, fixture.actor)).quests.find(
      (quest) => {
        return quest.key === "invite";
      },
    ),
  ).toMatchObject({ claimedCount: 0, pendingCount: 1, earnedCredits: 0 });
});

test("refreshes a signed revocation using its retained original inviter", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await invitationFixture();
  context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValueOnce(
    { id: fixture.source.invitationId },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
      headers: { authorization: "Bearer clerk-session" },
      body: { invitationId: fixture.source.invitationId },
    }),
    [200],
  );
  await fixture.consumer.deliver();
  const source = fixture.consumer.received.find((event) => {
    return event.type === "invitation.revoked";
  });
  if (!source) {
    throw new Error("Expected signed invitation revocation");
  }
  const publications = captureRewardProjectionPublications(context);
  await accept(
    projectionClient().notifyProgress({
      headers,
      body: {
        version: 1,
        environment: "development",
        source: { kind: "event", eventId: source.id },
      },
    }),
    [200],
  );
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
});

async function receiptFixture(slack = false) {
  const consumer = marketingRewardConsumer(context);
  const actor = bdd.user();
  if (slack) {
    const integrations = createBddIntegrationApi(context);
    integrations.configureSlackAppMocks();
    await integrations.installSlackWorkspace(actor);
  } else {
    const connectors = createConnectorBddApi(context);
    mockGitHubConnectorOAuth();
    const start = await connectors.startOauth(actor, "github", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    await connectors.completeOauthCallback("github", {
      code: randomUUID(),
      state,
    });
  }
  await consumer.deliver();
  const fact = consumer.received.find((event) => {
    return (
      event.type ===
      (slack ? "slack.oauth-authorized" : "connector.oauth-authorized")
    );
  });
  if (!fact) {
    throw new Error("Expected retained financial source");
  }
  const sourceKey =
    fact.type === "slack.oauth-authorized"
      ? fact.workspaceId
      : "builtin:github";
  const intent = campaignRequest({
    version: 1,
    environment: fact.environment,
    policy: "get-started-v1",
    sourceEventId: fact.id,
    questKey: slack ? "slack" : "connector",
    sourceKey,
    rewardKey: slack
      ? `slack:${sourceKey}`
      : `connector:${fact.userId}:${sourceKey}`,
    orgId: fact.orgId,
    actorUserId: fact.userId,
    beneficiaryUserId: slack ? null : fact.userId,
    rewardTarget: slack ? "org" : "user",
    rewardAmount: slack ? 2000 : 100,
    completedAt: fact.occurredAt,
  });
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", settlementSecret);
  const result = await accept(
    setupApp({ context, routes: marketingRewardSettlementRoutes })(
      marketingRewardSettlementContract,
    ).lookup({
      body: intent,
      headers: { authorization: `Bearer ${settlementSecret}` },
    }),
    [200],
  );
  return {
    actor,
    consumer,
    body: { version: 1 as const, intent, receipt: result.body.receipt },
  };
}

test("requires a dedicated projection credential and the exact committed financial receipt before queueing a refresh", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await receiptFixture();
  const api = projectionClient();
  const publications = captureRewardProjectionPublications(context);
  for (const credential of [
    "clerk-session",
    "marketing-consumer-cron",
    settlementSecret,
  ]) {
    const denied = await api.notify({
      body: fixture.body,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  }
  for (const receipt of [
    { ...fixture.body.receipt, orgId: "other-org" },
    { ...fixture.body.receipt, beneficiaryUserId: "other-user" },
    { ...fixture.body.receipt, rewardAmount: 9999 },
    { ...fixture.body.receipt, memberCreditGrantId: randomUUID() },
  ]) {
    expect(
      (await api.notify({ body: { ...fixture.body, receipt }, headers }))
        .status,
    ).toBe(409);
  }
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([]);
  mockEnv("MARKETING_REWARDS_PROJECTION_SECRET", undefined);
  expect((await api.notify({ body: fixture.body, headers })).status).toBe(503);
});

test("durably acknowledges one refresh and recovers notification failure without changing or renewing the financial receipt", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await receiptFixture();
  const api = projectionClient();
  const publications = captureRewardProjectionPublications(context, true);
  const acknowledgements = await Promise.all(
    Array.from({ length: 4 }, () => {
      return accept(api.notify({ body: fixture.body, headers }), [200]);
    }),
  );
  const first = acknowledgements[0];
  if (!first) {
    throw new Error("Expected projection acknowledgement");
  }
  const original = first.body;
  expect(original).toMatchObject({
    version: 1,
    intentId: fixture.body.intent.id,
    receiptId: fixture.body.receipt.id,
    notificationId: expect.any(String),
  });
  for (const result of acknowledgements) {
    expect(result.body).toStrictEqual(original);
  }
  expect(publications).toStrictEqual([]);
  mockNow(new Date("2026-01-01T00:00:00.000Z"));
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([]);
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
  expect(
    (await accept(api.notify({ body: fixture.body, headers }), [200])).body,
  ).toStrictEqual(original);
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
  const financial = await accept(
    setupApp({ context, routes: marketingRewardSettlementRoutes })(
      marketingRewardSettlementContract,
    ).lookup({
      body: fixture.body.intent,
      headers: { authorization: `Bearer ${settlementSecret}` },
    }),
    [200],
  );
  expect(financial.body.receipt).toStrictEqual(fixture.body.receipt);
});

test("routes an organization reward refresh only to its original actor and organization", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await receiptFixture(true);
  const api = projectionClient();
  const publications = captureRewardProjectionPublications(context);
  await accept(api.notify({ body: fixture.body, headers }), [200]);
  expect(publications).toStrictEqual([]);
  await fixture.consumer.deliver();
  expect(publications).toStrictEqual(
    expect.arrayContaining([
      {
        channel: `user:${fixture.actor.userId}`,
        name: "getStartedRewardsChanged",
      },
      { channel: `org:${fixture.actor.orgId}`, name: "slack:changed" },
    ]),
  );
  expect(publications).toHaveLength(2);
});

test("continues other users' queued refreshes when one provider publish fails", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixtures = [
    await receiptFixture(),
    await receiptFixture(),
    await receiptFixture(),
  ];
  const api = projectionClient();
  const publications = captureRewardProjectionPublications(context, true);
  for (const fixture of fixtures) {
    await accept(api.notify({ body: fixture.body, headers }), [200]);
  }
  mockNow(new Date("2026-01-01T00:00:00.000Z"));
  const consumer = fixtures[0]?.consumer;
  if (!consumer) {
    throw new Error("Expected real source consumer");
  }
  await consumer.deliver();
  expect(publications).toHaveLength(2);
  await consumer.deliver();
  expect(publications).toHaveLength(3);
  expect(publications).toStrictEqual(
    expect.arrayContaining(
      fixtures.map((fixture) => {
        return {
          channel: `user:${fixture.actor.userId}`,
          name: "getStartedRewardsChanged",
        };
      }),
    ),
  );
});
