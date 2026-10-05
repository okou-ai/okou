import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  bankingContract,
  bankingUserContract,
} from "@okouai/api-contracts/contracts/banking";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { bankingRoutes } from "../banking";

const context = testContext();

const UNATTENDED_TRIGGER_SOURCES = [
  "automation-schedule",
  "automation-event",
] as const satisfies readonly TriggerSource[];

const FINICITY_BASE_URL = "https://api.finicity.com";
const FINICITY_AUTH_URL = `${FINICITY_BASE_URL}/aggregation/v2/partners/authentication`;
const FINICITY_CONNECT_URL = `${FINICITY_BASE_URL}/connect/v2/generate`;
const FINICITY_APP_SECRET = randomBytes(32).toString("hex");

interface BankingFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly providerCustomerId: string;
  readonly enabledAccountId: string;
  readonly disabledAccountId: string;
}

interface BankingFixtureArgs {
  readonly triggerSource?: (typeof UNATTENDED_TRIGGER_SOURCES)[number];
  readonly featureSwitchEnabled?: boolean;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(
  fixture: BankingFixture,
  capabilities: readonly Capability[] = ["banking:read"],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: fixture.runId,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function randomProviderId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function createBankingRun(args: BankingFixtureArgs = {}) {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Banking fixtures require an org-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  // Webhook automations require a Team workspace.
  await api.grantProEntitlement(actor, {
    tier: args.triggerSource === "automation-event" ? "team" : "pro",
  });
  await api.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Banking Agent",
    visibility: "private",
  });

  // Unattended runs fire through the real schedule or webhook automation.
  const workflows = createWorkflowsBddApi(context);
  const run =
    args.triggerSource === "automation-schedule"
      ? await workflows.startScheduledAutomationRun(actor, agent.agentId)
      : args.triggerSource === "automation-event"
        ? await workflows.startEventAutomationRun(actor, agent.agentId)
        : await api.createThreadRun(actor, {
            agentId: agent.agentId,
            prompt: "banking precondition",
          });

  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    runId: run.runId,
  };
}

function signedWebhookBody(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", FINICITY_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  return { rawBody, signature };
}

async function postWebhook(body: Record<string, unknown>) {
  const signed = signedWebhookBody(body);
  return await createApp({
    signal: context.signal,
    routes: bankingRoutes,
  }).request("/api/webhooks/finicity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-finicity-signature": signed.signature,
    },
    body: signed.rawBody,
  });
}

async function connectBankingFixture(
  args: BankingFixtureArgs = {},
): Promise<BankingFixture> {
  const { actor, agentId, runId } = await createBankingRun(args);
  const providerCustomerId = randomProviderId("customer");
  const enabledAccountId = randomProviderId("acct-enabled");
  const disabledAccountId = randomProviderId("acct-disabled");
  const enabledAccount = {
    id: enabledAccountId,
    name: "Everyday Checking",
    institutionName: "Example Bank",
    institutionLoginId: "login-example-bank",
    type: "checking",
    realAccountNumberLast4: "6789",
    status: "active",
    aggregationStatusCode: 0,
  };
  const disabledAccount = {
    id: disabledAccountId,
    name: "Old Savings",
    institutionName: "Example Bank",
    institutionLoginId: "login-example-bank",
    type: "savings",
    realAccountNumberLast4: "4321",
    status: "active",
    aggregationStatusCode: 0,
  };
  let providerAccounts = [enabledAccount, disabledAccount];
  server.use(
    finicityAuthHandler(),
    http.post(`${FINICITY_BASE_URL}/aggregation/v2/customers/testing`, () => {
      return HttpResponse.json({ id: providerCustomerId });
    }),
    http.post(FINICITY_CONNECT_URL, () => {
      return HttpResponse.json({
        link: "https://connect.example.test/session",
      });
    }),
    http.get(
      `${FINICITY_BASE_URL}/aggregation/v1/customers/${providerCustomerId}/accounts`,
      () => {
        return HttpResponse.json({ accounts: providerAccounts });
      },
    ),
  );
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.Banking]: true },
  );
  const client = setupApp({ context, routes: bankingRoutes })(
    bankingUserContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const session = await accept(
    client.createConnectSession({
      headers,
      body: { agentId, mode: "connect" },
    }),
    [200],
  );
  const pending = await accept(
    client.accessRequestStatus({ headers, params: { agentId } }),
    [200],
  );
  const connectionId = pending.body.connection?.id;
  if (!connectionId) {
    throw new Error("Expected a banking connection from the connect API");
  }
  const webhookData = {
    uniqueCustomerId: connectionId,
    uniqueRequestId: session.body.sessionId,
  };
  const added = await postWebhook({
    eventId: randomProviderId("event-added"),
    eventType: "added",
    customerId: providerCustomerId,
    webhookData,
  });
  expect(added.status).toBe(200);
  // The provider no longer returns the old savings account. Its next signed
  // update disables that account through the same synchronization used in production.
  providerAccounts = [enabledAccount];
  const done = await postWebhook({
    eventId: randomProviderId("event-done"),
    eventType: "done",
    eventTrigger: "userSubmit",
    customerId: providerCustomerId,
    webhookData,
  });
  expect(done.status).toBe(200);
  const connected = await accept(
    client.accessRequestStatus({ headers, params: { agentId } }),
    [200],
  );
  expect(connected.body.connection?.accounts).toHaveLength(1);
  const accountId = connected.body.connection?.accounts[0]?.id;
  if (!accountId) {
    throw new Error("Expected a publicly connected banking account");
  }
  await accept(
    client.saveAgentGrant({
      headers,
      body: {
        agentId,
        accountIds: [accountId],
        duration: "7d",
        purpose: "Read the connected checking account",
      },
    }),
    [200],
  );
  if (args.featureSwitchEnabled === false) {
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId },
      { [FeatureSwitchKey.Banking]: false },
    );
  }
  return {
    orgId: actor.orgId,
    userId: actor.userId,
    runId,
    agentId,
    connectionId,
    providerCustomerId,
    enabledAccountId,
    disabledAccountId,
  };
}

function finicityAuthHandler() {
  return http.post(FINICITY_AUTH_URL, async ({ request }) => {
    const body = await request.json();
    expect(request.headers.get("Finicity-App-Key")).toBe("test-app-key");
    expect(body).toStrictEqual({
      partnerId: "test-partner",
      partnerSecret: FINICITY_APP_SECRET,
    });
    return HttpResponse.json({ token: "test-app-token" });
  });
}

describe("/api/banking/*", () => {
  beforeEach(() => {
    mockEnv("FINICITY_APP_KEY", "test-app-key");
    mockEnv("FINICITY_APP_SECRET", FINICITY_APP_SECRET);
    mockEnv("FINICITY_PARTNER_ID", "test-partner");
  });

  it("rejects banking requests when the banking feature switch is disabled", async () => {
    const fixture = await connectBankingFixture({
      featureSwitchEnabled: false,
    });
    let authRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingContract,
    );
    const response = await accept(
      client.accounts({
        headers: { authorization: `Bearer ${okouToken(fixture)}` },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Banking is not enabled",
        code: "FORBIDDEN",
      },
    });
    expect(authRequestCount).toBe(0);
  });

  it("lists only accounts enabled for the current agent", async () => {
    const fixture = await connectBankingFixture();
    let accountsRequestHeaders: Headers | undefined;
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        ({ request }) => {
          accountsRequestHeaders = request.headers;
          return HttpResponse.json({
            accounts: [
              {
                id: fixture.enabledAccountId,
                name: "Provider Checking",
                type: "checking",
                realAccountNumberLast4: "6789",
                status: "active",
                currency: "USD",
              },
              {
                id: fixture.disabledAccountId,
                name: "Disabled Savings",
                type: "savings",
                realAccountNumberLast4: "4321",
                status: "active",
                currency: "USD",
              },
            ],
          });
        },
      ),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingContract,
    );
    const response = await accept(
      client.accounts({
        headers: { authorization: `Bearer ${okouToken(fixture)}` },
        body: {},
      }),
      [200],
    );

    expect(accountsRequestHeaders?.get("Finicity-App-Key")).toBe(
      "test-app-key",
    );
    expect(accountsRequestHeaders?.get("Finicity-App-Token")).toBe(
      "test-app-token",
    );
    expect(response.body).toStrictEqual({
      operation: "accounts",
      provider: "finicity",
      accounts: [
        {
          id: fixture.enabledAccountId,
          name: "Provider Checking",
          institutionName: "Example Bank",
          type: "checking",
          last4: "6789",
          status: "active",
          currency: "USD",
        },
      ],
    });
  });

  it("denies balances for accounts not enabled for the agent", async () => {
    const fixture = await connectBankingFixture();
    let accountsRequestCount = 0;
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        () => {
          accountsRequestCount += 1;
          return HttpResponse.json({ accounts: [] });
        },
      ),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingContract,
    );
    const response = await accept(
      client.balances({
        headers: { authorization: `Bearer ${okouToken(fixture)}` },
        body: { accountId: fixture.disabledAccountId },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("BANKING_ACCESS_DENIED");
    expect(accountsRequestCount).toBe(0);
  });

  it("reads balances through Finicity with only sanitized fields returned", async () => {
    const fixture = await connectBankingFixture();
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        () => {
          return HttpResponse.json({
            accounts: [
              {
                id: fixture.enabledAccountId,
                name: "Provider Checking",
                type: "checking",
                balance: 1234.56,
                availableBalance: 1200.34,
                currency: "USD",
                balanceDate: 1_767_225_600,
                rawProviderField: "not returned",
              },
            ],
          });
        },
      ),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingContract,
    );
    const response = await accept(
      client.balances({
        headers: { authorization: `Bearer ${okouToken(fixture)}` },
        body: { accountId: fixture.enabledAccountId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      operation: "balances",
      provider: "finicity",
      balance: {
        accountId: fixture.enabledAccountId,
        name: "Provider Checking",
        type: "checking",
        balance: 1234.56,
        availableBalance: 1200.34,
        currency: "USD",
        balanceDate: 1_767_225_600,
      },
    });
  });

  it("rejects agent tokens without banking capability before provider access", async () => {
    const fixture = await connectBankingFixture();
    let authRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingContract,
    );
    const response = await accept(
      client.accounts({
        headers: {
          authorization: `Bearer ${okouToken(fixture, ["file:read"])}`,
        },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: banking:read",
        code: "FORBIDDEN",
      },
    });
    expect(authRequestCount).toBe(0);
  });

  it.each(UNATTENDED_TRIGGER_SOURCES)(
    "denies %s runs unless the banking grant allows automations",
    async (triggerSource) => {
      const fixture = await connectBankingFixture({ triggerSource });
      let authRequestCount = 0;
      server.use(
        http.post(FINICITY_AUTH_URL, () => {
          authRequestCount += 1;
          return HttpResponse.json({ token: "test-app-token" });
        }),
      );

      const client = setupApp({ context, routes: bankingRoutes })(
        bankingContract,
      );
      const response = await accept(
        client.accounts({
          headers: { authorization: `Bearer ${okouToken(fixture)}` },
          body: {},
        }),
        [403],
      );

      expect(response.body.error.message).toBe(
        "Banking is not enabled for automation runs",
      );
      expect(authRequestCount).toBe(0);
    },
  );

  it("reads transactions through Finicity with only sanitized fields returned", async () => {
    const fixture = await connectBankingFixture();
    let requestedUrl: URL | undefined;
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v3/customers/${fixture.providerCustomerId}/accounts/${fixture.enabledAccountId}/transactions`,
        ({ request }) => {
          requestedUrl = new URL(request.url);
          return HttpResponse.json({
            transactions: [
              {
                id: "txn-1",
                amount: -42.5,
                description: "Coffee",
                memo: "latte",
                postedDate: 1_767_225_600,
                transactionDate: 1_767_225_600,
                status: "active",
                categorization: "Food & Dining",
                merchant: "Cafe",
                rawProviderField: "not returned",
              },
            ],
          });
        },
      ),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingContract,
    );
    const response = await accept(
      client.transactions({
        headers: { authorization: `Bearer ${okouToken(fixture)}` },
        body: {
          accountId: fixture.enabledAccountId,
          from: "2026-01-01",
          to: "2026-01-31",
          limit: 25,
        },
      }),
      [200],
    );

    expect(requestedUrl?.searchParams.get("fromDate")).toBe(
      String(Math.floor(Date.UTC(2026, 0, 1) / 1000)),
    );
    expect(requestedUrl?.searchParams.get("toDate")).toBe(
      String(Math.floor(Date.UTC(2026, 0, 31) / 1000) + 86_399),
    );
    expect(requestedUrl?.searchParams.get("limit")).toBe("25");
    expect(response.body).toStrictEqual({
      operation: "transactions",
      provider: "finicity",
      accountId: fixture.enabledAccountId,
      transactions: [
        {
          id: "txn-1",
          accountId: fixture.enabledAccountId,
          amount: -42.5,
          description: "Coffee",
          memo: "latte",
          postedDate: 1_767_225_600,
          transactionDate: 1_767_225_600,
          status: "active",
          categorization: "Food & Dining",
          merchant: "Cafe",
        },
      ],
    });
  });
});

describe("banking access request lifecycle", () => {
  beforeEach(() => {
    mockEnv("FINICITY_APP_KEY", "test-app-key");
    mockEnv("FINICITY_APP_SECRET", FINICITY_APP_SECRET);
    mockEnv("FINICITY_PARTNER_ID", "test-partner");
  });

  function sessionHeaders() {
    return { authorization: "Bearer clerk-session" } as const;
  }

  it("creates an expiring account-scoped grant and revokes it independently", async () => {
    const fixture = await connectBankingFixture();
    const client = setupApp({ context, routes: bankingRoutes })(
      bankingUserContract,
    );
    const status = await accept(
      client.accessRequestStatus({
        headers: sessionHeaders(),
        params: { agentId: fixture.agentId },
      }),
      [200],
    );
    const accountId = status.body.connection?.accounts[0]?.id;
    if (!accountId) {
      throw new Error("Expected a connected banking account");
    }

    const saved = await accept(
      client.saveAgentGrant({
        headers: sessionHeaders(),
        body: {
          agentId: fixture.agentId,
          accountIds: [accountId],
          duration: "7d",
          purpose: "Review recent household spending",
        },
      }),
      [200],
    );
    expect(saved.body.grant).toMatchObject({
      status: "active",
      accountIds: [accountId],
      purpose: "Review recent household spending",
    });
    expect(saved.body.grant?.expiresAt).not.toBeNull();
    expect(saved.body.connection?.status).toBe("active");

    const revoked = await accept(
      client.revokeAgentGrant({
        headers: sessionHeaders(),
        body: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(revoked.body.grant?.status).toBe("revoked");
    expect(revoked.body.connection?.status).toBe("active");
  });

  it("uses branded Mastercard redirect origins without changing the webhook origin", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv(
      "FINICITY_WEBHOOK_BASE_URL",
      "https://public-api-tunnel.example.test",
    );
    const fixture = await connectBankingFixture();
    const generatedBodies: Record<string, unknown>[] = [];
    server.use(
      finicityAuthHandler(),
      http.post(FINICITY_CONNECT_URL, async ({ request }) => {
        generatedBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          link: "https://connect.example.test/session",
        });
      }),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingUserContract,
    );
    const brandCases = [
      {
        origin: "https://app.okou.ai",
        redirectUri: "https://app.okou.ai/banking/connect/return",
      },
      {
        origin: "https://app.okou.ai",
        redirectUri: "https://app.okou.ai/banking/connect/return",
      },
    ] as const;

    for (const [index, brandCase] of brandCases.entries()) {
      await accept(
        client.createConnectSession({
          headers: sessionHeaders(),
          extraHeaders: { origin: brandCase.origin },
          body: { agentId: fixture.agentId, mode: "connect" },
        }),
        [200],
      );
      expect(generatedBodies[index]).toMatchObject({
        redirectUri: brandCase.redirectUri,
        webhook: "https://public-api-tunnel.example.test/api/webhooks/finicity",
      });
    }
  });

  it("replaces concurrent connect sessions and ignores superseded callbacks", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Banking requires an org-scoped actor");
    }
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Banking Connect Agent",
      visibility: "private",
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId },
      { [FeatureSwitchKey.Banking]: true },
    );

    const providerCustomerId = randomProviderId("customer");
    server.use(
      finicityAuthHandler(),
      http.post(`${FINICITY_BASE_URL}/aggregation/v2/customers/testing`, () => {
        return HttpResponse.json({ id: providerCustomerId });
      }),
      http.post(FINICITY_CONNECT_URL, () => {
        return HttpResponse.json({
          link: "https://connect.example.test/session",
        });
      }),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${providerCustomerId}/accounts`,
        () => {
          return HttpResponse.json({
            accounts: [
              {
                id: randomProviderId("account"),
                name: "Superseded Connect Account",
                institutionLoginId: "login-superseded",
                type: "checking",
                status: "active",
                aggregationStatusCode: 0,
              },
            ],
          });
        },
      ),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingUserContract,
    );
    const createSession = async () => {
      return await accept(
        client.createConnectSession({
          headers: sessionHeaders(),
          body: { agentId: agent.agentId, mode: "connect" },
        }),
        [200],
      );
    };
    const initial = await createSession();
    const concurrent = await Promise.all([createSession(), createSession()]);
    expect(concurrent[0].body.sessionId).not.toBe(concurrent[1].body.sessionId);

    const current = await createSession();
    const status = await accept(
      client.accessRequestStatus({
        headers: sessionHeaders(),
        params: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(status.body.session).toMatchObject({
      id: current.body.sessionId,
      status: "pending",
    });
    const connectionId = status.body.connection?.id;
    if (!connectionId) {
      throw new Error("Expected a banking connection");
    }

    for (const superseded of [initial, ...concurrent]) {
      const callback = await postWebhook({
        eventId: randomProviderId("event-superseded"),
        eventType: "added",
        customerId: providerCustomerId,
        webhookData: {
          uniqueCustomerId: connectionId,
          uniqueRequestId: superseded.body.sessionId,
        },
      });
      expect(callback.status).toBe(200);
    }

    const afterCallbacks = await accept(
      client.accessRequestStatus({
        headers: sessionHeaders(),
        params: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(afterCallbacks.body.session).toMatchObject({
      id: current.body.sessionId,
      status: "pending",
    });
    expect(afterCallbacks.body.connection?.accounts).toStrictEqual([]);
  });

  it("completes only after signed added and done webhooks", async () => {
    mockEnv("APP_URL", "https://local-app.example.test");
    mockEnv(
      "FINICITY_WEBHOOK_BASE_URL",
      "https://public-api-tunnel.example.test",
    );
    const fixture = await connectBankingFixture();
    let generatedBody: Record<string, unknown> | undefined;
    server.use(
      finicityAuthHandler(),
      http.post(FINICITY_CONNECT_URL, async ({ request }) => {
        generatedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          link: "https://connect.example.test/session",
        });
      }),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        () => {
          return HttpResponse.json({
            accounts: [
              {
                id: fixture.enabledAccountId,
                name: "Everyday Checking",
                institutionName: "Example Bank",
                institutionLoginId: "login-example-bank",
                type: "checking",
                realAccountNumberLast4: "6789",
                status: "active",
                aggregationStatusCode: 0,
              },
            ],
          });
        },
      ),
    );

    const client = setupApp({ context, routes: bankingRoutes })(
      bankingUserContract,
    );
    const started = await accept(
      client.createConnectSession({
        headers: sessionHeaders(),
        body: { agentId: fixture.agentId, mode: "connect" },
      }),
      [200],
    );
    expect(started.body.url).toBe("https://connect.example.test/session");
    expect(generatedBody).toMatchObject({
      partnerId: "test-partner",
      customerId: fixture.providerCustomerId,
      webhookContentType: "application/json",
      singleUseUrl: true,
      webhookData: {
        uniqueCustomerId: fixture.connectionId,
        uniqueRequestId: started.body.sessionId,
      },
    });
    expect(String(generatedBody?.webhook)).toBe(
      "https://public-api-tunnel.example.test/api/webhooks/finicity",
    );
    expect(String(generatedBody?.redirectUri)).toBe(
      "https://local-app.example.test/banking/connect/return",
    );

    const addedEvent = {
      eventId: randomProviderId("event-added"),
      eventType: "added",
      customerId: fixture.providerCustomerId,
      webhookData: {
        uniqueCustomerId: fixture.connectionId,
        uniqueRequestId: started.body.sessionId,
      },
    };
    const mismatchedConnection = await postWebhook({
      ...addedEvent,
      eventId: randomProviderId("event-wrong-connection"),
      webhookData: {
        uniqueCustomerId: randomUUID(),
        uniqueRequestId: started.body.sessionId,
      },
    });
    expect(mismatchedConnection.status).toBe(200);
    const added = await postWebhook(addedEvent);
    expect(added.status).toBe(200);
    const duplicateAdded = await postWebhook(addedEvent);
    expect(duplicateAdded.status).toBe(200);

    const beforeDone = await accept(
      client.accessRequestStatus({
        headers: sessionHeaders(),
        params: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(beforeDone.body.session?.status).toBe("pending");
    expect(beforeDone.body.connection?.accounts[0]).toMatchObject({
      name: "Everyday Checking",
      institutionName: "Example Bank",
      last4: "6789",
      repairRequired: false,
    });

    const done = await postWebhook({
      ...addedEvent,
      eventId: randomProviderId("event-done"),
      eventType: "done",
      eventTrigger: "userSubmit",
    });
    expect(done.status).toBe(200);
    const completed = await accept(
      client.accessRequestStatus({
        headers: sessionHeaders(),
        params: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(completed.body.session).toMatchObject({
      id: started.body.sessionId,
      mode: "connect",
      status: "completed",
    });

    const doneOnlySession = await accept(
      client.createConnectSession({
        headers: sessionHeaders(),
        body: { agentId: fixture.agentId, mode: "connect" },
      }),
      [200],
    );
    const doneOnly = await postWebhook({
      eventId: randomProviderId("event-done-only"),
      eventType: "done",
      eventTrigger: "userExit",
      customerId: fixture.providerCustomerId,
      webhookData: {
        uniqueCustomerId: fixture.connectionId,
        uniqueRequestId: doneOnlySession.body.sessionId,
      },
    });
    expect(doneOnly.status).toBe(200);
    const cancelled = await accept(
      client.accessRequestStatus({
        headers: sessionHeaders(),
        params: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(cancelled.body.session).toMatchObject({
      id: doneOnlySession.body.sessionId,
      status: "cancelled",
    });
  });

  it("rejects invalid webhook signatures", async () => {
    const response = await createApp({
      signal: context.signal,
      routes: bankingRoutes,
    }).request("/api/webhooks/finicity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-finicity-signature": "0".repeat(64),
      },
      body: JSON.stringify({ eventType: "ping" }),
    });
    expect(response.status).toBe(401);
  });

  it("serves the Okou Finicity browser return from the API", async () => {
    const response = await createApp({
      signal: context.signal,
      routes: bankingRoutes,
    }).request(
      "https://api.okou.ai/api/banking/connect/return?reason=complete&code=200&reportData=null",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("<title>Return to Okou</title>");
    expect(html).toContain("continue in Okou Chat.");
  });
});
