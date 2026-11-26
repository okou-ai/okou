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
import {
  channelsPublishedTo,
  countPublishedTo,
} from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { createDeferredPromise } from "../../utils";

const context = testContext();

const FINICITY = "https://api.finicity.com";
// A generated Finicity webhook secret, configured for the route below.
const APP_SECRET = randomUUID();
const TOPIC = "bankingAccessChanged";

interface ListedAccount {
  readonly id: string;
  readonly name: string;
  readonly institutionLoginId: string;
  readonly type: string;
  readonly healthy: boolean;
}

interface HeldRead {
  readonly reached: () => void;
  readonly release: Promise<void>;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  const deferred = createDeferredPromise<void>(context.signal);
  const release = () => {
    if (!deferred.settled()) {
      deferred.resolve();
    }
  };
  return { promise: deferred.promise, resolve: release };
}

function finicityAccount(account: ListedAccount) {
  return {
    id: account.id,
    name: account.name,
    institutionName: `${account.institutionLoginId} institution`,
    institutionLoginId: account.institutionLoginId,
    type: account.type,
    realAccountNumberLast4: "4321",
    status: account.healthy ? "active" : "error",
    aggregationStatusCode: account.healthy ? 0 : 185,
  };
}

const checking: ListedAccount = Object.freeze({
  id: "acct-checking",
  name: "Everyday checking",
  institutionLoginId: "bank",
  type: "checking",
  healthy: true,
});

async function bankingMember() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const customerId = `cust-${randomUUID()}`;
  const eventPrefix = randomUUID();
  mockEnv("FINICITY_APP_KEY", "finicity-app-key");
  mockEnv("FINICITY_APP_SECRET", APP_SECRET);
  mockEnv("FINICITY_PARTNER_ID", "finicity-partner");
  await updateFeatureSwitchesForUser(
    context,
    { userId, orgId },
    { [FeatureSwitchKey.Banking]: true },
  );
  createRouteMocks(context).clerk.session(userId, orgId);

  const provider = {
    accounts: [] as ListedAccount[],
    accountsStatus: 200,
    connectStatus: 200,
    hold: null as HeldRead | null,
    webhookData: [] as Record<string, unknown>[],
  };
  const generate = async (request: Request) => {
    if (provider.connectStatus !== 200) {
      return HttpResponse.json(
        { message: "Service unavailable" },
        { status: provider.connectStatus },
      );
    }
    const body = (await request.json()) as {
      readonly webhookData: Record<string, unknown>;
    };
    provider.webhookData.push(body.webhookData);
    return HttpResponse.json({
      link: `https://connect.finicity.com/?id=${randomUUID()}`,
    });
  };
  server.use(
    http.post(`${FINICITY}/aggregation/v2/partners/authentication`, () => {
      return HttpResponse.json({ token: "finicity-app-token" });
    }),
    http.post(`${FINICITY}/aggregation/v2/customers/testing`, () => {
      return HttpResponse.json({ id: customerId });
    }),
    http.post(`${FINICITY}/connect/v2/generate`, ({ request }) => {
      return generate(request);
    }),
    http.post(`${FINICITY}/connect/v2/generate/fix`, ({ request }) => {
      return generate(request);
    }),
    http.get(
      `${FINICITY}/aggregation/v1/customers/${customerId}/accounts`,
      async () => {
        const hold = provider.hold;
        if (hold) {
          provider.hold = null;
          hold.reached();
          await hold.release;
        }
        if (provider.accountsStatus !== 200) {
          return HttpResponse.json(
            { message: "Service unavailable" },
            { status: provider.accountsStatus },
          );
        }
        return HttpResponse.json({
          accounts: provider.accounts.map(finicityAccount),
        });
      },
    ),
  );

  const client = setupApp({ context, routes: bankingRoutes });
  const workspace = client(bankingWorkspaceContract);
  const webhooks = client(bankingPublicContract);
  const headers = { authorization: "Bearer clerk-session" };
  const ownerChannel = `user:${userId}`;

  const notifications = () => {
    return countPublishedTo(context.mocks, {
      channel: ownerChannel,
      topic: TOPIC,
    });
  };

  const startSession = async (
    body:
      | { readonly mode: "connect" }
      | { readonly mode: "fix"; readonly institutionLoginId: string } = {
      mode: "connect",
    },
  ) => {
    return await accept(
      workspace.createConnectSession({ headers, body }),
      [200],
    );
  };

  const status = async () => {
    return (await accept(workspace.accessRequestStatus({ headers }), [200]))
      .body;
  };

  const deliver = async (event: {
    readonly eventType: string;
    readonly eventId: string;
    readonly customerId?: string;
    readonly extra?: Record<string, unknown>;
  }) => {
    const body = JSON.stringify({
      eventType: event.eventType,
      eventId: `${eventPrefix}-${event.eventId}`,
      customerId: event.customerId ?? customerId,
      webhookData: provider.webhookData.at(-1),
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

  return {
    userId,
    ownerChannel,
    provider,
    workspace,
    headers,
    notifications,
    startSession,
    status,
    deliver,
  };
}

describe("Finicity webhook outcomes", () => {
  it("banking-webhook-002 fails the session and notifies the owner when connect-link generation is unavailable", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.connectStatus = 503;

    const before = member.notifications();
    await accept(
      member.workspace.createConnectSession({
        headers: member.headers,
        body: { mode: "connect" },
      }),
      [502],
    );

    expect((await member.status()).session?.status).toBe("failed");
    expect(member.notifications() - before).toBe(2);
    expect(new Set(channelsPublishedTo(context.mocks, TOPIC))).toStrictEqual(
      new Set([member.ownerChannel]),
    );
  });

  it("banking-webhook-006 keeps unknown events pending and preserves added and done results on replay", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [checking];

    for (let delivery = 0; delivery < 2; delivery += 1) {
      expect(
        (
          await member.deliver({
            eventType: "institutionSelected",
            eventId: "e-selected",
          })
        ).status,
      ).toBe(200);
    }
    const afterUnknown = await member.status();
    expect(afterUnknown.session?.status).toBe("pending");
    expect(afterUnknown.connection?.accounts ?? []).toStrictEqual([]);

    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added" })).status,
    ).toBe(200);
    member.provider.accounts = [{ ...checking, healthy: false }];
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added" })).status,
    ).toBe(200);
    const afterAdded = await member.status();
    expect(afterAdded.session?.status).toBe("pending");
    expect(afterAdded.connection?.accounts).toHaveLength(1);
    expect(afterAdded.connection?.accounts[0]?.repairRequired).toBeFalsy();

    member.provider.accounts = [checking];
    const done = {
      eventType: "done",
      eventId: "e-done",
      extra: {
        reason: "user-finished-the-connect-flow-".repeat(4),
        eventTimestamp: "2026-11-25T10:00:00.000Z",
      },
    };
    expect((await member.deliver(done)).status).toBe(200);
    expect((await member.status()).session?.status).toBe("completed");

    member.provider.accounts = [];
    expect((await member.deliver(done)).status).toBe(200);
    const afterReplay = await member.status();
    expect(afterReplay.session?.status).toBe("completed");
    expect(afterReplay.connection?.accounts).toHaveLength(1);
  });

  it("banking-webhook-007 updates account metadata, removes absent accounts and restores their identities", async () => {
    const member = await bankingMember();
    await member.startSession();
    const bank: ListedAccount = { ...checking, healthy: false };
    const other: ListedAccount = {
      id: "acct-other",
      name: "Other checking",
      institutionLoginId: "other",
      type: "checking",
      healthy: true,
    };
    member.provider.accounts = [bank, other];

    await member.deliver({ eventType: "added", eventId: "e-added-1" });
    const first = await member.status();
    expect(first.connection?.status).toBe("repair_required");
    const bankRow = first.connection?.accounts.find((account) => {
      return account.name === bank.name;
    });
    const otherRow = first.connection?.accounts.find((account) => {
      return account.name === other.name;
    });
    expect(bankRow?.repairRequired).toBeTruthy();

    member.provider.accounts = [{ ...other, name: "Savings", type: "savings" }];
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added-2" }))
        .status,
    ).toBe(200);
    const second = await member.status();
    expect(second.session?.status).toBe("pending");
    expect(second.connection?.status).toBe("active");
    expect(second.connection?.repairInstitutions).toStrictEqual([]);
    expect(second.connection?.accounts).toStrictEqual([
      expect.objectContaining({
        id: otherRow?.id,
        name: "Savings",
        type: "savings",
        repairRequired: false,
      }),
    ]);

    member.provider.accounts = [
      { ...bank, name: "Restored Checking", healthy: true },
      { ...other, name: "Savings", type: "savings" },
    ];
    expect(
      (await member.deliver({ eventType: "done", eventId: "e-done" })).status,
    ).toBe(200);
    const third = await member.status();
    expect(third.session?.status).toBe("completed");
    expect(third.connection?.status).toBe("active");
    expect(third.connection?.repairInstitutions).toStrictEqual([]);
    expect(third.connection?.accounts).toHaveLength(2);
    expect(third.connection?.accounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bankRow?.id,
          name: "Restored Checking",
          repairRequired: false,
        }),
        expect.objectContaining({ id: otherRow?.id, name: "Savings" }),
      ]),
    );
  });

  it("banking-webhook-008 clears an empty provider directory and restores the same account identity", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [checking];

    expect(
      (await member.deliver({ eventType: "added", eventId: "e-1" })).status,
    ).toBe(200);
    const originalId = (await member.status()).connection?.accounts[0]?.id;

    member.provider.accounts = [];
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-2" })).status,
    ).toBe(200);
    const empty = await member.status();
    expect(empty.connection?.status).toBe("active");
    expect(empty.connection?.accounts).toStrictEqual([]);
    expect(empty.session?.status).toBe("pending");

    member.provider.accounts = [checking];
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-3" })).status,
    ).toBe(200);
    const restored = await member.status();
    expect(restored.connection?.accounts).toStrictEqual([
      expect.objectContaining({ id: originalId, repairRequired: false }),
    ]);
  });

  it("banking-webhook-012 keeps a grant revoked when an already captured account refresh finishes", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [checking];
    await member.deliver({ eventType: "added", eventId: "e-added-1" });
    const accountId = (await member.status()).connection?.accounts[0]?.id ?? "";
    await accept(
      member.workspace.saveGrant({
        headers: member.headers,
        body: {
          accountIds: [accountId],
          duration: "7d",
          purpose: "Cash flow summary",
        },
      }),
      [200],
    );

    const reached = deferred();
    const release = deferred();
    member.provider.hold = {
      reached: reached.resolve,
      release: release.promise,
    };
    const webhook = member.deliver({
      eventType: "added",
      eventId: "e-added-2",
    });
    await reached.promise;

    const revoked = await accept(
      member.workspace.revokeGrant({ headers: member.headers, body: {} }),
      [200],
    );
    expect(revoked.body.grant?.status).toBe("revoked");

    member.provider.accounts = [{ ...checking, name: "Refreshed checking" }];
    release.resolve();
    expect((await webhook).status).toBe(200);

    const after = await member.status();
    expect(after.grant).toMatchObject({
      status: "revoked",
      accountIds: [accountId],
    });
    expect(after.connection?.accounts).toStrictEqual([
      expect.objectContaining({ id: accountId, name: "Refreshed checking" }),
    ]);
  });

  it("banking-webhook-013 cancels connect when added and done return only unhealthy accounts", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [{ ...checking, healthy: false }];

    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added" })).status,
    ).toBe(200);
    const before = member.notifications();
    expect(
      (await member.deliver({ eventType: "done", eventId: "e-done" })).status,
    ).toBe(200);
    expect(member.notifications() - before).toBe(1);

    const after = await member.status();
    expect(after.session?.status).toBe("cancelled");
    expect(after.connection?.accounts).toStrictEqual([
      expect.objectContaining({ repairRequired: true }),
    ]);
  });

  it("banking-webhook-014 allows retry after a provider failure without consuming the event", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [checking];
    member.provider.accountsStatus = 503;

    const before = member.notifications();
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added" })).status,
    ).toBe(500);
    const failed = await member.status();
    expect(failed.session?.status).toBe("pending");
    expect(failed.connection?.accounts).toStrictEqual([]);
    expect(member.notifications() - before).toBe(0);

    member.provider.accountsStatus = 200;
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added" })).status,
    ).toBe(200);
    expect(
      (await member.deliver({ eventType: "done", eventId: "e-done" })).status,
    ).toBe(200);
    expect((await member.status()).session?.status).toBe("completed");
  });

  it("banking-webhook-018 completes a fix only for a healthy account at its requested institution", async () => {
    const member = await bankingMember();
    await member.startSession();
    const bank: ListedAccount = { ...checking, healthy: false };
    const other: ListedAccount = {
      id: "acct-other",
      name: "Other checking",
      institutionLoginId: "other",
      type: "checking",
      healthy: true,
    };
    member.provider.accounts = [bank, other];
    await member.deliver({ eventType: "added", eventId: "e-added" });
    await member.deliver({ eventType: "done", eventId: "e-done" });
    const connected = await member.status();
    expect(
      connected.connection?.repairInstitutions.map((institution) => {
        return institution.institutionLoginId;
      }),
    ).toStrictEqual(["bank"]);

    await member.startSession({ mode: "fix", institutionLoginId: "bank" });
    await member.deliver({ eventType: "done", eventId: "e-fix-1" });
    expect((await member.status()).session).toMatchObject({
      mode: "fix",
      status: "cancelled",
    });

    await member.startSession({ mode: "fix", institutionLoginId: "bank" });
    member.provider.accounts = [{ ...bank, healthy: true }, other];
    const before = member.notifications();
    expect(
      (await member.deliver({ eventType: "done", eventId: "e-fix-2" })).status,
    ).toBe(200);
    expect(member.notifications() - before).toBe(1);
    const fixed = await member.status();
    expect(fixed.session).toMatchObject({ mode: "fix", status: "completed" });
    expect(fixed.connection?.repairInstitutions).toStrictEqual([]);
  });

  it("banking-webhook-019 ignores a signed event correlated with another customer", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [checking];

    const response = await member.deliver({
      eventType: "added",
      eventId: "e-other-customer",
      customerId: `cust-${randomUUID()}`,
    });

    expect(response.status).toBe(200);
    const after = await member.status();
    expect(after.session?.status).toBe("pending");
    expect(after.connection?.accounts).toStrictEqual([]);
  });

  it("banking-webhook-001 notifies only the owner through connect, webhook updates and grant changes", async () => {
    const member = await bankingMember();
    await member.startSession();
    member.provider.accounts = [checking];

    let before = member.notifications();
    const started = await member.startSession();
    expect(member.notifications() - before).toBe(1);
    expect((await member.status()).session).toMatchObject({
      id: started.body.sessionId,
      status: "pending",
    });

    before = member.notifications();
    expect(
      (await member.deliver({ eventType: "added", eventId: "e-added" })).status,
    ).toBe(200);
    expect(member.notifications() - before).toBe(1);
    const afterAdded = await member.status();
    expect(afterAdded.connection?.accounts).toHaveLength(1);
    const accountId = afterAdded.connection?.accounts[0]?.id ?? "";

    before = member.notifications();
    expect(
      (await member.deliver({ eventType: "done", eventId: "e-done" })).status,
    ).toBe(200);
    expect(member.notifications() - before).toBe(1);
    expect((await member.status()).session?.status).toBe("completed");

    before = member.notifications();
    expect(
      (await member.deliver({ eventType: "done", eventId: "e-done" })).status,
    ).toBe(200);
    expect(member.notifications() - before).toBe(0);

    const grantBody = {
      accountIds: [accountId],
      duration: "7d" as const,
      purpose: "Monthly budget review",
    };
    before = member.notifications();
    const saved = await accept(
      member.workspace.saveGrant({ headers: member.headers, body: grantBody }),
      [200],
    );
    expect(saved.body.grant?.status).toBe("active");
    expect(member.notifications() - before).toBe(1);

    before = member.notifications();
    const revoked = await accept(
      member.workspace.revokeGrant({ headers: member.headers, body: {} }),
      [200],
    );
    expect(revoked.body.grant?.status).toBe("revoked");
    expect(member.notifications() - before).toBe(1);

    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("Ably unavailable"),
    );
    before = member.notifications();
    const resaved = await accept(
      member.workspace.saveGrant({ headers: member.headers, body: grantBody }),
      [200],
    );
    expect(resaved.body.grant?.status).toBe("active");
    expect(member.notifications() - before).toBe(1);
    expect(new Set(channelsPublishedTo(context.mocks, TOPIC))).toStrictEqual(
      new Set([member.ownerChannel]),
    );
  });
});
