import { createHash, randomUUID } from "node:crypto";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  marketingRewardOAuthEventSchema,
  marketingRewardSourceEventSchema,
  type MarketingRewardOAuthEvent,
  type MarketingRewardSourceEvent,
} from "../../../lib/marketing-reward-events";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { server } from "../../../mocks/server";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { uniqueSlackUserId } from "./helpers/slack-public-install";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const origin = "https://marketing-events.example.test";
const path = `${origin}/api/internal/marketing/get-started/events`;
const secret = "reward-source-event-service-test-key-123456789";

beforeEach(() => {
  mockEnv("CRON_SECRET", "test-cron-secret");
  mockEnv("MARKETING_REWARDS_EVENTS_ORIGIN", undefined);
  mockEnv("MARKETING_REWARDS_EVENTS_SECRET", undefined);
});

function enableDelivery() {
  mockEnv("MARKETING_REWARDS_EVENTS_ORIGIN", origin);
  mockEnv("MARKETING_REWARDS_EVENTS_SECRET", secret);
}

async function cron() {
  return (
    await accept(
      setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
        cronProcessBackgroundJobsContract,
      ).process({ headers: { authorization: "Bearer test-cron-secret" } }),
      [200],
    )
  ).body;
}

async function connectGitHub(actor: ApiTestUser) {
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
  return connectors.readDefaultBuiltinAccount(actor, "github");
}

function receipt(event: MarketingRewardSourceEvent) {
  // Compute the external receiver's digest independently from the sender helper.
  return {
    version: 1,
    environment: event.environment,
    eventId: event.id,
    hash: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
    receivedAt: "2026-11-16T12:00:00.000Z",
  };
}

test("cron recovers a retained source after configuration returns and retries its exact identity without forwarding credentials", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  const actor = bdd.user();
  const received: MarketingRewardOAuthEvent[] = [];
  let followedRedirect = false;
  server.use(
    http.post("https://untrusted.example.test/collect", () => {
      followedRedirect = true;
      return HttpResponse.json({ ok: true });
    }),
    http.post(path, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      const event = marketingRewardOAuthEventSchema.parse(await request.json());
      received.push(event);
      switch (received.length) {
        case 1: {
          return HttpResponse.error();
        }
        case 2: {
          return HttpResponse.json({ ...receipt(event), hash: "0".repeat(64) });
        }
        case 3: {
          return HttpResponse.json({
            ...receipt(event),
            environment: "production",
          });
        }
        case 4: {
          return HttpResponse.json({
            ...receipt(event),
            eventId: randomUUID(),
          });
        }
        case 5: {
          return HttpResponse.json({ error: "conflict" }, { status: 409 });
        }
        case 6: {
          return new HttpResponse(null, {
            status: 307,
            headers: { location: "https://untrusted.example.test/collect" },
          });
        }
        default: {
          return HttpResponse.json(receipt(event));
        }
      }
    }),
  );
  const connection = await connectGitHub(actor);
  await flushWaitUntilForTest();
  expect(received).toStrictEqual([]);
  enableDelivery();
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await cron();
  }
  expect(received).toHaveLength(7);
  expect(received[0]).toStrictEqual({
    version: 1,
    id: expect.any(String),
    environment: "development",
    type: "connector.oauth-authorized",
    occurredAt: "2026-01-01T08:00:00.000Z",
    orgId: actor.orgId,
    userId: actor.userId,
    connectionId: connection.id,
    connector: { kind: "builtin", connectorSlug: "github" },
  });
  for (const event of received) {
    expect(event).toStrictEqual(received[0]);
  }
  expect(followedRedirect).toBeFalsy();
  await Promise.all([cron(), cron()]);
  expect(received).toHaveLength(7);
});

test("records custom OAuth connection identity without publishing its provider credentials", async () => {
  const actor = bdd.user();
  const received: MarketingRewardOAuthEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardOAuthEventSchema.parse(await request.json());
      received.push(event);
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();

  const provider = mockCustomConnectorOAuth2Provider(context);
  context.mocks.dns.resolve4.mockResolvedValue(["8.8.8.8"]);
  context.mocks.dns.resolve6.mockResolvedValue([]);
  const custom = await connectors.createCustomConnector(actor, {
    displayName: "Campaign OAuth source",
    kind: "http",
    prefixTemplates: [`${new URL(provider.tokenUrl).origin}/`],
    authMode: "oauth",
    fields: [],
    queryInjections: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "source-test-client",
      clientSecret: "source-test-client-secret",
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
  });
  const authorization = new URL(
    await connectors.startCustomConnectorOAuth2(actor, custom.id),
  );
  const state = authorization.searchParams.get("state");
  if (!state) {
    throw new Error("Expected custom OAuth state");
  }
  await connectors.completeCustomConnectorOAuth2Callback({
    code: "source-test-code",
    state,
  });
  await flushWaitUntilForTest();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    orgId: actor.orgId,
    userId: actor.userId,
    connector: { kind: "custom", customConnectorId: custom.id },
  });
  await flushWaitUntilForTest();
});

test("does not publish manual credentials or a declined OAuth authorization as an OAuth fact", async () => {
  const received: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  const actor = bdd.user();
  await connectors.connectManualGrant(actor, "openai", "api-token", {
    apiKey: "manual-test-key",
  });
  mockGitHubConnectorOAuth();
  const start = await connectors.startOauth(actor, "github", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  await connectors.completeOauthCallback("github", {
    error: "access_denied",
    state,
  });
  await flushWaitUntilForTest();
  expect(received).toStrictEqual([]);
});

test("publishes immutable iMessage owner facts through repeated requests, switching and source deletion", async () => {
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  const integrations = createBddIntegrationApi(context);
  const phone = createAgentPhoneBddApi(context);
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const sends = phone.captureAgentPhoneSends();
  const received: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  const actor = integrations.user();
  const proof = await phone.requestConnectLink(uniquePhoneHandle(), sends);
  await integrations.requestConnectAgentPhone(actor, proof, [200]);
  await integrations.requestConnectAgentPhone(actor, proof, [200]);
  await flushWaitUntilForTest();
  expect(received).toHaveLength(1);
  expect(received[0]).toStrictEqual({
    version: 2,
    id: expect.any(String),
    environment: "development",
    type: "imessage.identity-linked",
    occurredAt: "2026-01-01T08:00:00.000Z",
    orgId: actor.orgId,
    userId: actor.userId,
    linkId: expect.any(String),
  });
  const next = await phone.requestConnectLink(uniquePhoneHandle(), sends);
  await integrations.requestConnectAgentPhone(actor, next, [409]);
  const replacement = { ...next, replacePhoneHandle: proof.phoneHandle };
  await integrations.requestConnectAgentPhone(actor, replacement, [200]);
  await integrations.requestConnectAgentPhone(actor, replacement, [200]);
  await integrations.requestUnlinkAgentPhone(actor, [204]);
  await expect(
    integrations.getAgentPhoneLinkStatus(actor),
  ).resolves.toMatchObject({
    linked: false,
  });
  await flushWaitUntilForTest();
  expect(received).toHaveLength(2);
  const first = received[0];
  const switched = received[1];
  if (
    first?.type !== "imessage.identity-linked" ||
    switched?.type !== "imessage.identity-linked"
  ) {
    throw new Error("Expected iMessage source facts");
  }
  expect(switched.id).not.toBe(first.id);
  expect(switched.linkId).not.toBe(first.linkId);
  expect(switched.orgId).toBe(actor.orgId);
  expect(switched.userId).toBe(actor.userId);
  await flushWaitUntilForTest();
});

test("a rejected OAuth source does not prevent another owner's Slack publication", async () => {
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  const actor = bdd.user();
  const slackActor = bdd.user({ orgRole: "org:admin" });
  const received: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      return event.userId === actor.userId && event.version === 1
        ? HttpResponse.json({ error: "temporarily rejected" }, { status: 409 })
        : HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  await connectGitHub(actor);
  await flushWaitUntilForTest();
  const rejected = received.filter((event) => {
    return event.userId === actor.userId;
  });
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({
    version: 1,
    type: "connector.oauth-authorized",
    orgId: actor.orgId,
    userId: actor.userId,
    connector: { kind: "builtin", connectorSlug: "github" },
  });
  const integrations = createBddIntegrationApi(context);
  integrations.configureSlackAppMocks();
  const installed = await integrations.installSlackWorkspace(slackActor);
  await flushWaitUntilForTest();
  // Slack's accepted OAuth creates both its connector fact and workspace fact.
  // Neither request may claim A's already-due rejected GitHub event.
  expect(
    received.filter((event) => {
      return event.userId === actor.userId;
    }),
  ).toStrictEqual(rejected);
  expect(
    received.filter((event) => {
      return event.userId === slackActor.userId && event.version === 1;
    }),
  ).toStrictEqual([
    expect.objectContaining({
      type: "connector.oauth-authorized",
      orgId: slackActor.orgId,
      userId: slackActor.userId,
      connector: { kind: "builtin", connectorSlug: "slack" },
    }),
  ]);
  expect(
    received.filter((event) => {
      return event.version === 2;
    }),
  ).toStrictEqual([
    {
      version: 2,
      id: expect.any(String),
      environment: "development",
      type: "slack.oauth-authorized",
      occurredAt: "2026-01-01T08:00:00.000Z",
      orgId: slackActor.orgId,
      userId: slackActor.userId,
      workspaceId: installed.teamId,
    },
  ]);
});

test("publishes an anonymous Slack installation only after administrator authorization binds its organization", async () => {
  const integrations = createBddIntegrationApi(context);
  integrations.configureSlackAppMocks();
  const installed = await integrations.installSlackWorkspace(null);
  const actor = bdd.user({ orgRole: "org:admin" });
  const received: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  await flushWaitUntilForTest();
  const binding = {
    workspaceId: installed.teamId,
    slackUserId: uniqueSlackUserId(),
  };
  await integrations.connectSlackUser(actor, binding);
  await flushWaitUntilForTest();
  expect(
    received.filter((event) => {
      return event.version === 2;
    }),
  ).toHaveLength(0);
  await integrations.installSlackWorkspace(actor, {
    teamId: installed.teamId,
    installerSlackUserId: binding.slackUserId,
  });
  const owned = await integrations.requestSlackIntegrationStatus(actor, [200]);
  expect(owned.body).toMatchObject({ isInstalled: true });
  await flushWaitUntilForTest();
  const links = received.filter((event) => {
    return event.version === 2;
  });
  expect(links).toStrictEqual([
    {
      version: 2,
      id: expect.any(String),
      environment: "development",
      type: "slack.oauth-authorized",
      occurredAt: expect.any(String),
      orgId: actor.orgId,
      userId: actor.userId,
      workspaceId: installed.teamId,
    },
  ]);
  await integrations.connectSlackUser(actor, binding);
  await flushWaitUntilForTest();
  expect(
    received.filter((event) => {
      return event.version === 2;
    }),
  ).toHaveLength(1);
  await flushWaitUntilForTest();
});
