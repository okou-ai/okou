import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createStore } from "ccstate";

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
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readBankingAuditEventsState,
  seedBankingState,
} from "./helpers/banking-state";
import { bankingRoutes } from "../banking";
import { seedRun$ } from "./helpers/usage-state";

const context = testContext();

const UNATTENDED_TRIGGER_SOURCES = [
  "automation-schedule",
  "automation-event",
  "automation-schedule",
  "automation-event",
  "goal",
] as const satisfies readonly TriggerSource[];

const FINICITY_BASE_URL = "https://api.finicity.com";
const FINICITY_AUTH_URL = `${FINICITY_BASE_URL}/aggregation/v2/partners/authentication`;
const FINICITY_CONNECT_URL = `${FINICITY_BASE_URL}/connect/v2/generate`;
const FINICITY_APP_SECRET = randomBytes(32).toString("hex");

type BankingConnectionStatus =
  | "active"
  | "repair_required"
  | "revoked"
  | "deleted";
type BankingOperationScope =
  | "accounts.read"
  | "balances.read"
  | "transactions.read";

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

interface SeedBankingFixtureArgs {
  readonly triggerSource?: (typeof UNATTENDED_TRIGGER_SOURCES)[number];
  readonly operationScopes?: readonly BankingOperationScope[];
  readonly allowAutomationRuns?: boolean;
  readonly connectionStatus?: BankingConnectionStatus;
  readonly accountProviderIds?: readonly string[];
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

async function seedBankingFixture(
  args: SeedBankingFixtureArgs = {},
): Promise<BankingFixture> {
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
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Banking Agent",
    visibility: "private",
  });

  // Existing Goal runs retain their banking grant boundary while draining.
  const run =
    args.triggerSource === "goal"
      ? await createStore().set(
          seedRun$,
          {
            orgId: actor.orgId,
            userId: actor.userId,
            composeId: agent.agentId,
            triggerSource: "goal",
            status: "running",
            startedAt: new Date(now()),
          },
          context.signal,
        )
      : args.triggerSource
        ? await api.createDirectRun(actor, {
            agentId: agent.agentId,
            prompt: "banking automation precondition",
            modelProviderType: "anthropic-api-key",
            triggerSource: args.triggerSource,
            vars: { OKOU_AGENT_ID: agent.agentId },
            secrets: { OKOU_TOKEN: "bdd-banking-okou-token" },
          })
        : await api.createRun(actor, {
            agentId: agent.agentId,
            prompt: "banking precondition",
            modelProvider: "anthropic-api-key",
          });

  const providerCustomerId = randomProviderId("customer");
  const enabledAccountId = randomProviderId("acct-enabled");
  const disabledAccountId = randomProviderId("acct-disabled");
  if (args.featureSwitchEnabled ?? true) {
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: actor.userId,
        orgId: actor.orgId,
      },
      {
        [FeatureSwitchKey.Banking]: true,
      },
    );
  }

  const operationScopes = [
    ...(args.operationScopes ?? [
      "accounts.read",
      "balances.read",
      "transactions.read",
    ]),
  ];
  const connection = await seedBankingState(context, {
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
    providerCustomerId,
    enabledAccountId,
    disabledAccountId,
    accountProviderIds: [...(args.accountProviderIds ?? [enabledAccountId])],
    operationScopes,
    // #17307 D3: only allow_automation_runs is seeded; the legacy
    // allow_scheduled_runs column is NOT NULL with a default and drops in the
    // final phase.
    allowAutomationRuns: args.allowAutomationRuns ?? false,
    connectionStatus: args.connectionStatus ?? "active",
  });

  return {
    orgId: actor.orgId,
    userId: actor.userId,
    runId: run.runId,
    agentId: agent.agentId,
    connectionId: connection.connectionId,
    providerCustomerId,
    enabledAccountId,
    disabledAccountId,
  };
}

async function bankingAuditEvents(fixture: BankingFixture) {
  return await readBankingAuditEventsState(context, fixture);
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
    const fixture = await seedBankingFixture({ featureSwitchEnabled: false });
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
    const fixture = await seedBankingFixture();
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
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: null,
      },
    ]);
  });

  it("denies balances for accounts not enabled for the agent", async () => {
    const fixture = await seedBankingFixture();
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
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "balances.read",
        status: "denied",
        failureCode: "ACCOUNT_NOT_ALLOWED",
        providerAccountId: fixture.disabledAccountId,
      },
    ]);
  });

  it("reads balances through Finicity with only sanitized fields returned", async () => {
    const fixture = await seedBankingFixture();
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
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "balances.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: fixture.enabledAccountId,
      },
    ]);
  });

  it("rejects agent tokens without banking capability before provider access", async () => {
    const fixture = await seedBankingFixture();
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
      const fixture = await seedBankingFixture({ triggerSource });
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
      await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
        {
          action: "accounts.read",
          status: "denied",
          failureCode: "AUTOMATION_NOT_ALLOWED",
        },
      ]);
    },
  );

  it.each(UNATTENDED_TRIGGER_SOURCES)(
    "allows %s runs when the banking grant allows automations",
    async (triggerSource) => {
      const fixture = await seedBankingFixture({
        triggerSource,
        allowAutomationRuns: true,
      });
      server.use(
        finicityAuthHandler(),
        http.get(
          `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
          () => {
            return HttpResponse.json({ accounts: [] });
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

      expect(response.body).toMatchObject({
        operation: "accounts",
        provider: "finicity",
      });
      expect(response.body.accounts).toHaveLength(1);
      await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
        {
          action: "accounts.read",
          status: "allowed",
          failureCode: null,
        },
      ]);
    },
  );

  it("denies revoked banking connections before provider access", async () => {
    const fixture = await seedBankingFixture({ connectionStatus: "revoked" });
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
      "Banking is not enabled for this agent",
    );
    expect(authRequestCount).toBe(0);
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "denied",
        failureCode: "NO_ACTIVE_GRANT",
      },
    ]);
  });

  it("reads transactions through Finicity with only sanitized fields returned", async () => {
    const fixture = await seedBankingFixture();
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
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "transactions.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: fixture.enabledAccountId,
      },
    ]);
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

  it("creates an expiring account-scoped grant and revokes it independently", async () => {
    const fixture = await seedBankingFixture();
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
    const fixture = await seedBankingFixture();
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

  it("completes only after signed added and done webhooks", async () => {
    mockEnv("APP_URL", "https://local-app.example.test");
    mockEnv(
      "FINICITY_WEBHOOK_BASE_URL",
      "https://public-api-tunnel.example.test",
    );
    const fixture = await seedBankingFixture();
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
