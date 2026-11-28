import { randomUUID } from "node:crypto";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockNow, now } from "../../../lib/time";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { postSubscriptionInvoicePaid } from "./helpers/stripe-billing-webhook";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [...billingStatusRoutes, ...billingUsagePackCreditsRoutes],
});

interface Workspace {
  readonly orgId: string;
  readonly creatorId: string;
  readonly createdAt: number;
}

function workspace(): Workspace {
  return {
    orgId: `org_${randomUUID()}`,
    creatorId: `user_${randomUUID()}`,
    createdAt: now(),
  };
}

/** Clerk delivers its signed `organization.created` webhook for the workspace. */
async function deliverOrganizationCreated(ws: Workspace): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: ws.orgId, created_by: ws.creatorId, created_at: ws.createdAt },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

function signIn(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member" = "org:admin",
): void {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

async function readUsagePackCredits() {
  const response = await accept(
    app(billingUsagePackCreditsContract).get({ headers }),
    [200],
  );
  return response.body;
}

async function readBillingStatus() {
  const response = await accept(
    app(billingStatusContract).get({ headers }),
    [200],
  );
  return response.body;
}

describe("workspace creation credit grants", () => {
  it("onboarding-bootstrap-001 keeps the onboarding bonus personal to the workspace creator", async () => {
    const ws = workspace();
    signIn(ws.creatorId, ws.orgId);
    await deliverOrganizationCreated(ws);

    const status = await readBillingStatus();
    expect(status.credits).toBe(0);
    expect(status.creditGrants).toStrictEqual([]);

    const first = await readUsagePackCredits();
    expect(first).toMatchObject({
      totalCredits: 1000,
      purchasedCredits: 0,
      bonusCredits: 1000,
      hasUsagePack: false,
    });
    expect(first.creditGrants).toHaveLength(1);
    expect(first.creditGrants[0]).toMatchObject({
      grantType: "bonus",
      amount: 1000,
      remaining: 1000,
    });
    expect(first.memberCredits).toHaveLength(1);
    expect(first.memberCredits?.[0]).toMatchObject({
      memberId: ws.creatorId,
      totalCredits: 1000,
      bonusCredits: 1000,
    });

    signIn(`user_${randomUUID()}`, ws.orgId, "org:member");
    const other = await readUsagePackCredits();
    expect(other).toMatchObject({
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });
    expect(other.memberCredits ?? []).toStrictEqual([]);

    signIn(ws.creatorId, ws.orgId);
    await expect(readUsagePackCredits()).resolves.toStrictEqual(first);
  });

  it("onboarding-bootstrap-002 expires the personal onboarding grant after 30 days without restarting on replay", async () => {
    mockNow(new Date("2027-01-01T12:34:56.789Z"));
    const ws = workspace();
    signIn(ws.creatorId, ws.orgId);
    await deliverOrganizationCreated(ws);

    const initial = await readUsagePackCredits();
    expect(initial.creditGrants).toHaveLength(1);
    expect(initial.creditGrants[0]).toMatchObject({
      grantType: "bonus",
      amount: 1000,
      remaining: 1000,
      expiresAt: "2027-01-31T12:34:56.789Z",
    });

    mockNow(new Date("2027-01-31T12:34:56.788Z"));
    await deliverOrganizationCreated(ws);
    await expect(readUsagePackCredits()).resolves.toStrictEqual(initial);

    mockNow(new Date("2027-01-31T12:34:56.789Z"));
    await deliverOrganizationCreated(ws);
    const expired = await readUsagePackCredits();
    expect(expired).toMatchObject({
      totalCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });

    const status = await readBillingStatus();
    expect(status.credits).toBe(0);
    expect(status.creditGrants).toStrictEqual([]);
  });

  it("onboarding-bootstrap-003 issues one personal bonus across repeated organization creation events", async () => {
    const ws = workspace();
    signIn(ws.creatorId, ws.orgId);
    await deliverOrganizationCreated(ws);

    const initial = await readUsagePackCredits();
    expect(initial.creditGrants).toHaveLength(1);
    expect(initial.creditGrants[0]).toMatchObject({
      grantType: "bonus",
      amount: 1000,
    });
    expect((await readBillingStatus()).credits).toBe(0);

    await deliverOrganizationCreated(ws);

    await expect(readUsagePackCredits()).resolves.toStrictEqual(initial);
    expect((await readBillingStatus()).credits).toBe(0);
  });

  it("onboarding-bootstrap-006 does not grant limited-free credits to an already pro workspace", async () => {
    const ws = workspace();
    await postSubscriptionInvoicePaid(context.signal, {
      orgId: ws.orgId,
      userId: ws.creatorId,
      tier: "pro",
      customerId: `cus_${randomUUID().slice(0, 8)}`,
      subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      currentPeriodEnd: new Date(now() + 30 * 86_400_000),
    });
    signIn(ws.creatorId, ws.orgId);

    await deliverOrganizationCreated(ws);

    expect((await readBillingStatus()).tier).toBe("pro");
    const credits = await readUsagePackCredits();
    expect(credits.totalCredits).toBe(0);
    expect(credits.creditGrants).toStrictEqual([]);
  });
});
