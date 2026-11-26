import { createHmac, randomUUID } from "node:crypto";

import {
  bankingPublicContract,
  bankingWorkspaceContract,
} from "@okouai/api-contracts/contracts/banking";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { bankingRoutes } from "../banking";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const FINICITY = "https://api.finicity.com";
const APP_KEY = "finicity-app-key";
const APP_TOKEN = "finicity-app-token";
// A generated Finicity webhook secret, configured for the route below.
const APP_SECRET = randomUUID();
const PARTNER_ID = "finicity-partner";

type ProviderAccount = Readonly<Record<string, unknown>>;

const everydayChecking: ProviderAccount = Object.freeze({
  id: "acct-checking",
  name: "Everyday Checking",
  institutionName: "Example Bank",
  institutionLoginId: "example-bank",
  type: "checking",
  realAccountNumberLast4: "6789",
  status: "active",
  currency: "USD",
  aggregationStatusCode: 0,
});

const oldSavings: ProviderAccount = Object.freeze({
  id: "acct-savings",
  name: "Old Savings",
  institutionName: "Example Bank",
  institutionLoginId: "example-bank",
  type: "savings",
  realAccountNumberLast4: "1111",
  status: "active",
  currency: "USD",
  aggregationStatusCode: 0,
});

function finicityProvider(
  connectLink: (customerId: string) => string = (customerId) => {
    return `https://connect.example.test/${customerId}`;
  },
) {
  mockEnv("FINICITY_APP_KEY", APP_KEY);
  mockEnv("FINICITY_APP_SECRET", APP_SECRET);
  mockEnv("FINICITY_PARTNER_ID", PARTNER_ID);
  const provider = {
    accounts: [] as ProviderAccount[],
    connectBodies: [] as Record<string, unknown>[],
    customers: new Map<string, string>(),
  };
  server.use(
    http.post(`${FINICITY}/aggregation/v2/partners/authentication`, () => {
      return HttpResponse.json({ token: APP_TOKEN });
    }),
    http.post(
      `${FINICITY}/aggregation/v2/customers/testing`,
      async ({ request }) => {
        const { username } = (await request.json()) as { username: string };
        if (provider.customers.has(username)) {
          return HttpResponse.json(
            { message: "Customer already exists" },
            { status: 503 },
          );
        }
        const customerId = `cust-${randomUUID()}`;
        provider.customers.set(username, customerId);
        return HttpResponse.json({ id: customerId });
      },
    ),
    http.post(`${FINICITY}/connect/v2/generate`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      provider.connectBodies.push(body);
      return HttpResponse.json({ link: connectLink(String(body.customerId)) });
    }),
    http.get(
      `${FINICITY}/aggregation/v1/customers/:customerId/accounts`,
      () => {
        return HttpResponse.json({ accounts: provider.accounts });
      },
    ),
  );
  return provider;
}

async function bankingOwner(
  provider: ReturnType<typeof finicityProvider>,
  identity: { readonly userId: string; readonly orgId: string } = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  },
) {
  const { userId, orgId } = identity;
  const eventPrefix = randomUUID();
  await updateFeatureSwitchesForUser(
    context,
    { userId, orgId },
    { [FeatureSwitchKey.Banking]: true },
  );
  const client = setupApp({ context, routes: bankingRoutes });
  const workspace = client(bankingWorkspaceContract);
  const webhooks = client(bankingPublicContract);
  const headers = { authorization: "Bearer clerk-session" };
  const signIn = () => {
    createRouteMocks(context).clerk.session(userId, orgId);
  };

  const status = async () => {
    signIn();
    return (await accept(workspace.accessRequestStatus({ headers }), [200]))
      .body;
  };
  const startSession = async () => {
    signIn();
    return (
      await accept(
        workspace.createConnectSession({ headers, body: { mode: "connect" } }),
        [200],
      )
    ).body;
  };
  const deliver = async (event: {
    readonly eventType: string;
    readonly eventId: string;
    readonly webhookData?: Record<string, unknown>;
    readonly extra?: Record<string, unknown>;
  }) => {
    const latest = provider.connectBodies.at(-1);
    const body = JSON.stringify({
      eventType: event.eventType,
      eventId: `${eventPrefix}-${event.eventId}`,
      customerId: latest?.customerId,
      webhookData: event.webhookData ?? latest?.webhookData,
      ...event.extra,
    });
    const signature = createHmac("sha256", APP_SECRET)
      .update(body)
      .digest("hex");
    return await webhooks.finicityWebhook({
      headers: { "x-finicity-signature": signature },
      body,
    });
  };
  const saveGrant = async (accountId: string, purpose: string) => {
    signIn();
    return (
      await accept(
        workspace.saveGrant({
          headers,
          body: { accountIds: [accountId], duration: "7d", purpose },
        }),
        [200],
      )
    ).body;
  };
  const revokeGrant = async () => {
    signIn();
    return (await accept(workspace.revokeGrant({ headers, body: {} }), [200]))
      .body;
  };

  /** Connect checking only: savings disappears before `done`. */
  const connectChecking = async () => {
    await startSession();
    provider.accounts = [everydayChecking, oldSavings];
    await deliver({ eventType: "added", eventId: "added" });
    provider.accounts = [everydayChecking];
    await deliver({ eventType: "done", eventId: "done" });
  };

  /** Connect checking and grant it, returning the granted account ID. */
  const connectCheckingWithGrant = async () => {
    await connectChecking();
    const connected = await status();
    const accountId = connected.connection?.accounts[0]?.id ?? "";
    await saveGrant(accountId, "Household budget review");
    return accountId;
  };

  return {
    userId,
    orgId,
    status,
    startSession,
    deliver,
    saveGrant,
    revokeGrant,
    connectChecking,
    connectCheckingWithGrant,
  };
}

describe("banking access request lifecycle", () => {
  it("banking-014 rejects a webhook with an invalid signature", async () => {
    finicityProvider();
    const webhooks = setupApp({ context, routes: bankingRoutes })(
      bankingPublicContract,
    );

    const response = await webhooks.finicityWebhook({
      headers: { "x-finicity-signature": "0".repeat(64) },
      body: JSON.stringify({ eventType: "ping" }),
    });

    expect(response.status).toBe(401);
  });

  it("banking-010 creates an expiring account-scoped grant and revokes it independently", async () => {
    const provider = finicityProvider();
    const owner = await bankingOwner(provider);
    const accountId = await owner.connectCheckingWithGrant();

    const saved = await owner.saveGrant(
      accountId,
      "Review recent household spending",
    );
    expect(saved.grant).toMatchObject({
      status: "active",
      accountIds: [accountId],
      purpose: "Review recent household spending",
    });
    expect(saved.grant?.expiresAt).not.toBeNull();
    expect(saved.connection?.status).toBe("active");
    const afterSave = await owner.status();
    expect(afterSave.grant).toStrictEqual(saved.grant);
    expect(afterSave.connection).toStrictEqual(saved.connection);

    const revoked = await owner.revokeGrant();
    expect(revoked.grant?.status).toBe("revoked");
    expect(revoked.connection?.status).toBe("active");
    await expect(owner.status()).resolves.toStrictEqual(revoked);
  });

  it("banking-013 completes a connect session only after signed added and done webhooks", async () => {
    mockEnv("APP_URL", "https://local-app.example.test");
    mockEnv(
      "FINICITY_WEBHOOK_BASE_URL",
      "https://public-api-tunnel.example.test",
    );
    const provider = finicityProvider(() => {
      return "https://connect.example.test/session";
    });
    const owner = await bankingOwner(provider);
    await owner.connectChecking();

    const started = await owner.startSession();
    expect(started.url).toBe("https://connect.example.test/session");
    const connectionId = (await owner.status()).connection?.id;
    expect(provider.connectBodies.at(-1)).toMatchObject({
      partnerId: PARTNER_ID,
      customerId: expect.any(String),
      webhookContentType: "application/json",
      singleUseUrl: true,
      webhookData: {
        uniqueCustomerId: connectionId,
        uniqueRequestId: started.sessionId,
      },
      webhook: "https://public-api-tunnel.example.test/api/webhooks/finicity",
      redirectUri: "https://local-app.example.test/banking/connect/return",
    });

    const mismatched = await owner.deliver({
      eventType: "added",
      eventId: "mismatched",
      webhookData: {
        uniqueCustomerId: randomUUID(),
        uniqueRequestId: started.sessionId,
      },
    });
    expect(mismatched.status).toBe(200);
    for (let delivery = 0; delivery < 2; delivery += 1) {
      expect(
        (await owner.deliver({ eventType: "added", eventId: "added-2" }))
          .status,
      ).toBe(200);
    }
    const beforeDone = await owner.status();
    expect(beforeDone.session?.status).toBe("pending");
    expect(beforeDone.connection?.accounts).toStrictEqual([
      expect.objectContaining({
        name: "Everyday Checking",
        institutionName: "Example Bank",
        last4: "6789",
        repairRequired: false,
      }),
    ]);

    const done = await owner.deliver({
      eventType: "done",
      eventId: "done-2",
      extra: { eventTrigger: "userSubmit" },
    });
    expect(done.status).toBe(200);
    expect((await owner.status()).session).toMatchObject({
      mode: "connect",
      status: "completed",
    });

    await owner.startSession();
    const exited = await owner.deliver({
      eventType: "done",
      eventId: "done-3",
      extra: { eventTrigger: "userExit" },
    });
    expect(exited.status).toBe(200);
    expect((await owner.status()).session?.status).toBe("cancelled");
  });

  it("banking-008 reuses each owner's connection while keeping users and organizations separate", async () => {
    const provider = finicityProvider();
    const member = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const owners = [
      member,
      { userId: `user_${randomUUID()}`, orgId: member.orgId },
      { userId: member.userId, orgId: `org_${randomUUID()}` },
    ];
    const connectionIds = new Set<string>();

    for (const identity of owners) {
      const owner = await bankingOwner(provider, identity);
      expect((await owner.status()).connection).toBeNull();

      const first = await owner.startSession();
      const customerId = String(provider.connectBodies.at(-1)?.customerId);
      expect(first.url).toBe(`https://connect.example.test/${customerId}`);
      const afterFirst = await owner.status();
      const connectionId = afterFirst.connection?.id ?? "";
      expect(connectionIds.has(connectionId)).toBeFalsy();
      connectionIds.add(connectionId);

      const second = await owner.startSession();
      expect(second.url).toBe(first.url);
      expect(second.sessionId).not.toBe(first.sessionId);
      const afterSecond = await owner.status();
      expect(afterSecond.connection?.id).toBe(connectionId);
      expect(afterSecond.session).toMatchObject({
        id: second.sessionId,
        status: "pending",
      });
    }
    expect(connectionIds.size).toBe(3);
  });
});
