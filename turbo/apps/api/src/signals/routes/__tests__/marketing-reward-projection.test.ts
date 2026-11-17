import { randomUUID } from "node:crypto";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import { expect, test } from "vitest";
import { marketingRewardProjectionContract } from "@okouai/api-contracts/contracts/marketing-reward-projection";
import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { marketingRewardProjectionRoutes } from "../marketing-reward-projection";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
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

function capturePublications(rejectFirst = false) {
  mockEnv("ABLY_API_KEY", "projection.key:projection-provider-secret");
  context.mocks.ably.useRealPublish.mockReturnValue(true);
  const publications: { channel: string; name: string }[] = [];
  let reject = rejectFirst;
  server.use(
    http.post(
      "https://main.realtime.ably.net/channels/:channelName/messages",
      async ({ request, params }) => {
        if (
          typeof MsgPack !== "object" ||
          MsgPack === null ||
          !("decode" in MsgPack) ||
          typeof MsgPack.decode !== "function"
        ) {
          throw new Error("Expected native Ably MessagePack codec");
        }
        const messages = array(object({ name: string() })).parse(
          MsgPack.decode(await request.arrayBuffer()),
        );
        if (reject) {
          reject = false;
          return HttpResponse.json(
            {
              error: {
                statusCode: 400,
                code: 40_000,
                message: "Publish not accepted",
              },
            },
            { status: 400 },
          );
        }
        for (const message of messages) {
          publications.push({
            channel: String(params.channelName),
            name: message.name,
          });
        }
        if (!("encode" in MsgPack) || typeof MsgPack.encode !== "function") {
          throw new Error("Expected native Ably MessagePack encoder");
        }
        const encoded: unknown = MsgPack.encode({ serials: [null] });
        if (!(encoded instanceof ArrayBuffer)) {
          throw new Error("Expected a MessagePack response buffer");
        }
        return HttpResponse.arrayBuffer(encoded, {
          status: 201,
          headers: { "content-type": "application/x-msgpack" },
        });
      },
    ),
  );
  return publications;
}

test("requires a dedicated projection credential and the exact committed financial receipt before queueing a refresh", async () => {
  await setupApp({
    context,
    routes: marketingRewardProjectionRoutes,
    isolatePg: true,
  });
  const fixture = await receiptFixture();
  const api = projectionClient();
  const publications = capturePublications();
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
  const publications = capturePublications(true);
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
  const publications = capturePublications();
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
  const publications = capturePublications(true);
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
