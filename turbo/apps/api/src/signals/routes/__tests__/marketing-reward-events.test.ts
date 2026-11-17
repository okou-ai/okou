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
import { server } from "../../../mocks/server";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { readGetStartedStatus } from "./helpers/get-started";
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

test("retains OAuth facts while delivery is disabled and sends only the accepted owner's fact once", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const actor = bdd.user();
  const connection = await connectGitHub(actor);
  expect((await cron()).processed).toBe(0);
  const received: MarketingRewardOAuthEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      const event = marketingRewardOAuthEventSchema.parse(await request.json());
      received.push(event);
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  const results = await Promise.all([cron(), cron()]);
  expect(
    results.reduce((sum, result) => {
      return sum + result.processed;
    }, 0),
  ).toBe(1);
  expect(received).toStrictEqual([
    {
      version: 1,
      id: expect.any(String),
      environment: "development",
      type: "connector.oauth-authorized",
      occurredAt: expect.any(String),
      orgId: actor.orgId,
      userId: actor.userId,
      connectionId: connection.id,
      connector: { kind: "builtin", connectorSlug: "github" },
    },
  ]);
  expect((await cron()).processed).toBe(0);
  expect((await readGetStartedStatus(context, actor)).quests).toContainEqual(
    expect.objectContaining({
      key: "connector",
      claimedCount: 1,
      earnedCredits: 100,
    }),
  );
});

test("recovers a lost storage acknowledgement by retrying the identical durable event", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  // A delayed source publication also makes the bounded retry eligible without
  // waiting in the test; the lease arbiter still uses the actual database clock.
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  await connectGitHub(bdd.user());
  enableDelivery();
  const received: MarketingRewardOAuthEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardOAuthEventSchema.parse(await request.json());
      received.push(event);
      return received.length === 1
        ? HttpResponse.error()
        : HttpResponse.json(receipt(event));
    }),
  );
  expect((await cron()).processed).toBe(1);
  expect((await cron()).processed).toBe(1);
  expect(received).toHaveLength(2);
  expect(received[1]).toStrictEqual(received[0]);
  expect((await cron()).processed).toBe(0);
});

test("retains facts after mismatched receipts or rejection and never forwards the credential to a redirect", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  await connectGitHub(bdd.user());
  enableDelivery();
  const received: MarketingRewardOAuthEvent[] = [];
  let followedRedirect = false;
  server.use(
    http.post("https://untrusted.example.test/collect", () => {
      followedRedirect = true;
      return HttpResponse.json({ ok: true });
    }),
  );
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardOAuthEventSchema.parse(await request.json());
      received.push(event);
      if (received.length === 1) {
        return HttpResponse.json({ ...receipt(event), hash: "0".repeat(64) });
      }
      if (received.length === 2) {
        return HttpResponse.json({
          ...receipt(event),
          environment: "production",
        });
      }
      if (received.length === 3) {
        return HttpResponse.json({ ...receipt(event), eventId: randomUUID() });
      }
      if (received.length === 4) {
        return HttpResponse.json({ error: "conflict" }, { status: 409 });
      }
      if (received.length === 5) {
        return new HttpResponse(null, {
          status: 307,
          headers: { location: "https://untrusted.example.test/collect" },
        });
      }
      return HttpResponse.json(receipt(event));
    }),
  );
  for (let attempt = 0; attempt < 6; attempt += 1) {
    expect((await cron()).processed).toBe(1);
  }
  expect(received).toHaveLength(6);
  expect(followedRedirect).toBeFalsy();
  for (const event of received) {
    expect(event).toStrictEqual(received[0]);
  }
  expect((await cron()).processed).toBe(0);
});

test("records custom OAuth connection identity without publishing its provider credentials", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const actor = bdd.user();
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
  const received: MarketingRewardOAuthEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardOAuthEventSchema.parse(await request.json());
      received.push(event);
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  expect((await cron()).processed).toBe(1);
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    orgId: actor.orgId,
    userId: actor.userId,
    connector: { kind: "custom", customConnectorId: custom.id },
  });
  expect((await cron()).processed).toBe(0);
});

test("does not publish manual credentials or a declined OAuth authorization as an OAuth fact", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
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
  enableDelivery();
  expect((await cron()).processed).toBe(0);
});

test("retains iMessage link facts through lost acknowledgements, repeated requests, switching and source deletion", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  const integrations = createBddIntegrationApi(context);
  const phone = createAgentPhoneBddApi(context);
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const sends = phone.captureAgentPhoneSends();
  const actor = integrations.user();
  const proof = await phone.requestConnectLink(uniquePhoneHandle(), sends);
  await integrations.requestConnectAgentPhone(actor, proof, [200]);
  await integrations.requestConnectAgentPhone(actor, proof, [200]);
  expect((await cron()).processed).toBe(0);
  const received: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      return received.length === 1
        ? HttpResponse.error()
        : HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  expect((await cron()).processed).toBe(1);
  expect((await cron()).processed).toBe(1);
  expect(received).toHaveLength(2);
  expect(received[1]).toStrictEqual(received[0]);
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
  expect((await cron()).processed).toBe(1);
  expect(received).toHaveLength(3);
  const first = received[0];
  const switched = received[2];
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
  expect((await cron()).processed).toBe(0);
});

test("delivers owned Slack OAuth facts even when the OAuth version queue is rejected", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  const actor = bdd.user({ orgRole: "org:admin" });
  await connectGitHub(actor);
  const integrations = createBddIntegrationApi(context);
  integrations.configureSlackAppMocks();
  const installed = await integrations.installSlackWorkspace(actor);
  const received: MarketingRewardSourceEvent[] = [];
  let rejectOAuth = true;
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      if (rejectOAuth && event.version === 1) {
        return HttpResponse.json(
          { error: "temporarily rejected" },
          { status: 409 },
        );
      }
      return HttpResponse.json(receipt(event));
    }),
  );
  enableDelivery();
  expect((await cron()).processed).toBe(2);
  const links = received.filter((event) => {
    return event.version === 2;
  });
  expect(links).toStrictEqual([
    {
      version: 2,
      id: expect.any(String),
      environment: "development",
      type: "slack.oauth-authorized",
      occurredAt: "2026-01-01T08:00:00.000Z",
      orgId: actor.orgId,
      userId: actor.userId,
      workspaceId: installed.teamId,
    },
  ]);
  rejectOAuth = false;
  expect((await cron()).processed).toBeGreaterThan(0);
  expect(
    received.filter((event) => {
      return event.version === 2;
    }),
  ).toHaveLength(1);
  expect((await cron()).processed).toBe(0);
});

test("publishes an anonymous Slack installation only after administrator authorization binds its organization", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
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
  expect((await cron()).processed).toBe(0);
  const binding = {
    workspaceId: installed.teamId,
    slackUserId: uniqueSlackUserId(),
  };
  await integrations.connectSlackUser(actor, binding);
  expect((await cron()).processed).toBeGreaterThan(0);
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
  expect((await cron()).processed).toBeGreaterThan(0);
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
  expect((await cron()).processed).toBeGreaterThan(0);
  expect(
    received.filter((event) => {
      return event.version === 2;
    }),
  ).toHaveLength(1);
  expect((await cron()).processed).toBe(0);
});
