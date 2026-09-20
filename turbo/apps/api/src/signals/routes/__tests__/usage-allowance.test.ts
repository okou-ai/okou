import { randomUUID } from "node:crypto";

import { webhookFirewallAuthContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  readRunFailureReasonFixture,
  seedBuiltInDefaultModelKey as seedBuiltInDefaultModelKeyState,
} from "./helpers/runtime-state";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";

const context = testContext();

function usageProvider(): string {
  return `usage-allowance-${randomUUID()}`;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function seedBuiltInDefaultModelKey(): Promise<void> {
  await seedBuiltInDefaultModelKeyState(context);
}

interface AllowanceEntitlementArgs {
  readonly shortWindowUnits: number;
  readonly weeklyWindowUnits: number;
  readonly shortWindowSeconds?: number;
}

/**
 * An org whose runs can be admitted with the built-in model key. Tier and
 * credit balance are pinned through the org-metadata fixture; the allowance
 * entitlement (when given), window activation, usage events, and settlement
 * all run through product paths.
 */
async function builtInAllowanceActor(args: {
  readonly credits: number;
  readonly allowance?: AllowanceEntitlementArgs;
}): Promise<{
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
}> {
  await seedBuiltInDefaultModelKey();
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected test actor to have an org");
  }
  bdd.acceptAgentStorageWrites();
  api.configureRunnerGroup();
  const completed = await bdd.completeOnboarding(actor);
  expect(completed.status).toBe(200);
  await seedOrgMetadata({ orgId, tier: "pro", credits: args.credits });
  if (args.allowance) {
    await seedAllowanceEntitlement(actor, orgId, args.allowance);
  }
  const agent = await bdd.createAgent(actor, {
    displayName: "Usage allowance agent",
    visibility: "private",
  });
  return { actor, orgId, agentId: agent.agentId };
}

async function seedAllowanceEntitlement(
  actor: ApiTestUser,
  orgId: string,
  args: AllowanceEntitlementArgs,
): Promise<void> {
  await postUsageAllowanceInvoicePaid(context.signal, {
    orgId,
    userId: actor.userId,
    customerId: generatedStripeCustomerId(),
    subscriptionId: usageAllowanceSubscriptionId(orgId),
    effectiveAt: nowDate(),
    expiresAt: addDays(nowDate(), 365),
    shortWindowSeconds: args.shortWindowSeconds ?? 5 * 60 * 60,
    shortWindowUnits: args.shortWindowUnits,
    weeklyWindowSeconds: 7 * 24 * 60 * 60,
    weeklyWindowUnits: args.weeklyWindowUnits,
  });
}

function usageAllowanceSubscriptionId(orgId: string): string {
  return `sub_usage_allowance_${orgId}`;
}

async function cancelUsageAllowanceSubscription(orgId: string): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  await webhooks.postStripeEvent(
    {
      id: `evt_usage_allowance_cancel_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: usageAllowanceSubscriptionId(orgId),
          status: "canceled",
          items: { data: [] },
        },
      },
    },
    [200],
  );
}

async function createBuiltInRun(
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
): Promise<{ readonly runId: string; readonly status: string }> {
  const api = createRunsApi(context);
  return await api.createRun(actor, {
    agentId,
    prompt,
    modelProvider: "built-in",
  });
}

async function recordPendingUsageEvents(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly provider: string;
  readonly quantities: readonly number[];
}): Promise<void> {
  const api = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider: args.provider,
      category: "credits",
      unitPrice: 1,
      unitSize: 1,
    },
  ]);
  await webhooks.requestAgentUsageEvent(
    {
      runId: args.runId,
      events: args.quantities.map((quantity) => {
        return {
          idempotencyKey: randomUUID(),
          kind: "connector",
          provider: args.provider,
          category: "credits",
          quantity,
        };
      }),
    },
    {
      authorization: `Bearer ${api.sandboxTokenForRun(args.actor, args.runId)}`,
    },
    [200],
  );
}

async function recordPendingUsage(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly provider: string;
  readonly quantity: number;
}): Promise<void> {
  await recordPendingUsageEvents({
    actor: args.actor,
    runId: args.runId,
    provider: args.provider,
    quantities: [args.quantity],
  });
}

async function processOrgUsageEvents(actor: ApiTestUser): Promise<void> {
  await createBillingMediaApi(context).processOrgUsageEvents(actor);
}

async function readOrgCredits(actor: ApiTestUser): Promise<number> {
  const api = createRunsApi(context);
  const status = await api.readBillingStatus(actor);
  return status.credits;
}

async function readVisibleUsageCredits(actor: ApiTestUser): Promise<number> {
  const billing = createBillingMediaApi(context);
  const response = await billing.readUsageRecord(actor);
  return response.body.totalCredits;
}

describe("Usage Allowance", () => {
  it("applies usage allowance before legacy org credits", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 10,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const run = await createBuiltInRun(
      actor,
      agentId,
      "allowance-covered usage",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(10);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("settles multiple events and runs against shared allowance windows", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 90 },
    });
    const firstRun = await createBuiltInRun(
      actor,
      agentId,
      "batched first run",
    );
    const secondRun = await createBuiltInRun(
      actor,
      agentId,
      "batched second run",
    );
    const provider = usageProvider();
    await recordPendingUsageEvents({
      actor,
      runId: firstRun.runId,
      provider,
      quantities: [30, 40],
    });
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(70);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(120);
    const status = await createRunsApi(context).readBillingStatus(actor);
    if (!status.usageAllowance) {
      throw new Error("Expected usage allowance windows");
    }
    expect(
      Object.fromEntries(
        status.usageAllowance.windows.map((window) => {
          return [window.kind, window.consumedUnits];
        }),
      ),
    ).toStrictEqual({ short: 90, weekly: 90 });
  });

  it("falls back to org credits after the binding window cap is exhausted", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 60 },
    });
    const run = await createBuiltInRun(
      actor,
      agentId,
      "weekly cap binds first",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(80);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("charges org credits after the short window is exhausted", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const firstRun = await createBuiltInRun(
      actor,
      agentId,
      "exhausts short window",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 100,
    });
    await processOrgUsageEvents(actor);

    mockNow(addHours(startedAt, 1));
    const secondRun = await createBuiltInRun(
      actor,
      agentId,
      "same short window",
    );
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });
    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(50);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(150);
  });

  it("refreshes the short window while continuing the active weekly window", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const firstRun = await createBuiltInRun(
      actor,
      agentId,
      "exhausts short window",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 100,
    });
    await processOrgUsageEvents(actor);

    mockNow(addHours(startedAt, 6));
    const secondRun = await createBuiltInRun(
      actor,
      agentId,
      "fresh short window",
    );
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });
    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(150);
  });

  it("refreshes the weekly window for runs after the weekly window expires", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 120 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const firstRun = await createBuiltInRun(
      actor,
      agentId,
      "first weekly window",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 80,
    });
    await processOrgUsageEvents(actor);

    mockNow(addDays(startedAt, 8));
    const secondRun = await createBuiltInRun(
      actor,
      agentId,
      "fresh weekly window",
    );
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });
    await processOrgUsageEvents(actor);

    // A continued weekly window would only have 40 units left (120 - 80), so
    // full coverage of the 50-unit event proves the weekly window refreshed.
    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(50);
  });

  it("admits built-in model runs with shared debt when allowance remains", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: -10,
      allowance: { shortWindowUnits: 10, weeklyWindowUnits: 10 },
    });

    const run = await createBuiltInRun(
      actor,
      agentId,
      "built-in model run admitted by allowance under shared debt",
    );

    expect(run.runId).toStrictEqual(expect.any(String));
    // The activated windows fully cover usage without repaying shared debt.
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 10,
    });
    await processOrgUsageEvents(actor);
    await expect(readOrgCredits(actor)).resolves.toBe(-10);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(10);
  });

  it("rejects built-in model run admission after allowance is exhausted", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 0,
      allowance: { shortWindowUnits: 1, weeklyWindowUnits: 1 },
    });
    const api = createRunsApi(context);
    const firstRun = await createBuiltInRun(
      actor,
      agentId,
      "built-in model run consumes the only allowance unit",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 1,
    });
    await processOrgUsageEvents(actor);

    const rejected = await api.requestCreateRun(
      actor,
      {
        agentId,
        prompt: "built-in model run rejected after allowance exhaustion",
        modelProvider: "built-in",
      },
      [402],
    );

    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("keeps billable firewall auth available to an admitted run after exhaustion", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 0,
      allowance: { shortWindowUnits: 2, weeklyWindowUnits: 2 },
    });
    const api = createRunsApi(context);
    const run = await createBuiltInRun(
      actor,
      agentId,
      "billable firewall lease",
    );
    const client = setupApp({
      context,
      routes: webhooksAgentFirewallAuthRoutes,
    })(webhookFirewallAuthContract);
    const headers = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };
    const body = {
      encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
      authHeaders: { Authorization: "Bearer static-token" },
      firewallBillable: true,
    };

    const before = Math.floor(now() / 1000);
    const leased = await accept(client.resolve({ headers, body }), [200]);
    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 25);
    expect(leased.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 35);

    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 2,
    });
    await processOrgUsageEvents(actor);

    const continued = await accept(client.resolve({ headers, body }), [200]);
    expect(continued.body.expiresAt).not.toBeNull();
    expect(continued.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 25);
    expect(continued.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 35);

    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 3,
    });
    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(-3);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(5);

    const rejected = await api.requestCreateRun(
      actor,
      {
        agentId,
        prompt: "new run after admitted run exhausted credits",
        modelProvider: "built-in",
      },
      [402],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("uses run allowance for billable firewall fallback under shared debt", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: -10,
      allowance: { shortWindowUnits: 2, weeklyWindowUnits: 2 },
    });
    const api = createRunsApi(context);
    await api.ensureOrgModelProvider(actor);
    const run = await api.createRun(actor, {
      agentId,
      prompt: "BYOK run uses allowance for billable firewall",
      modelProvider: "anthropic-api-key",
    });
    const client = setupApp({
      context,
      routes: webhooksAgentFirewallAuthRoutes,
    })(webhookFirewallAuthContract);

    const before = Math.floor(now() / 1000);
    const leased = await accept(
      client.resolve({
        headers: {
          authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
        },
        body: {
          encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
          authHeaders: { Authorization: "Bearer static-token" },
          firewallBillable: true,
        },
      }),
      [200],
    );
    const after = Math.floor(now() / 1000);

    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 4);
    expect(leased.body.expiresAt ?? 0).toBeLessThanOrEqual(after + 6);
  });

  it("does not let built-in credit admission bypass workspace suspension", async () => {
    const { actor, orgId, agentId } = await builtInAllowanceActor({
      credits: 1,
    });
    const api = createRunsApi(context);
    const run = await createBuiltInRun(
      actor,
      agentId,
      "admitted before suspension",
    );
    await seedOrgMetadata({ orgId, tier: "pro", credits: 1 });
    await upsertOrgPlanEntitlementFixture({ orgId, status: "suspended" });
    const client = setupApp({
      context,
      routes: webhooksAgentFirewallAuthRoutes,
    })(webhookFirewallAuthContract);

    const denied = await accept(
      client.resolve({
        headers: {
          authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
        },
        body: {
          encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
          authHeaders: { Authorization: "Bearer static-token" },
          firewallBillable: true,
        },
      }),
      [402],
    );

    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("fails an unfunded built-in queue promotion and continues to BYOK", async () => {
    const { actor, agentId } = await builtInAllowanceActor({ credits: 1 });
    const api = createRunsApi(context);
    const first = await createBuiltInRun(actor, agentId, "active built-in one");
    const second = await createBuiltInRun(
      actor,
      agentId,
      "active built-in two",
    );
    const unfunded = await createBuiltInRun(
      actor,
      agentId,
      "queued built-in loses admission",
    );
    expect(unfunded.status).toBe("queued");

    await api.ensureOrgModelProvider(actor);
    const byok = await api.createRun(actor, {
      agentId,
      prompt: "queued BYOK remains admissible",
      modelProvider: "anthropic-api-key",
    });
    expect(byok.status).toBe("queued");

    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: first.runId,
      provider,
      quantity: 1,
    });
    await processOrgUsageEvents(actor);
    await expect(readOrgCredits(actor)).resolves.toBe(0);

    await api.requestCancelRun(actor, first.runId, [200]);
    await flushWaitUntilForTest();

    await expect
      .poll(async () => {
        return (await api.readRun(actor, unfunded.runId)).status;
      })
      .toBe("failed");
    await expect
      .poll(async () => {
        return (await api.readRun(actor, byok.runId)).status;
      })
      .toBe("pending");
    await expect(
      readRunFailureReasonFixture(context, unfunded.runId),
    ).resolves.toBe("insufficient_credits");

    const missingJob = await api.requestClaimRunnerJob(
      true,
      unfunded.runId,
      [404],
    );
    expectApiError(missingJob.body);
    expect(missingJob.body.error.message).toBe("Job not found in queue");
    await api.claimRunnerJob(byok.runId);

    const client = setupApp({
      context,
      routes: webhooksAgentFirewallAuthRoutes,
    })(webhookFirewallAuthContract);
    const denied = await accept(
      client.resolve({
        headers: {
          authorization: `Bearer ${api.sandboxTokenForRun(actor, byok.runId)}`,
        },
        body: {
          encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
          authHeaders: { Authorization: "Bearer static-token" },
          firewallBillable: true,
        },
      }),
      [402],
    );
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");

    await api.requestCancelRun(actor, second.runId, [200]);
    await api.requestCancelRun(actor, byok.runId, [200]);
  });

  it("backfills allowance windows during non-built-in usage settlement", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected test actor to have an org");
    }
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    await seedOrgMetadata({ orgId, tier: "pro", credits: 100 });
    await seedAllowanceEntitlement(actor, orgId, {
      shortWindowUnits: 100,
      weeklyWindowUnits: 200,
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Usage allowance agent",
      visibility: "private",
    });
    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "non-built-in run uses allowance",
      modelProvider: "anthropic-api-key",
    });
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("applies allowance to non-built-in runs inside active allowance windows", async () => {
    const { actor, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    await createBuiltInRun(actor, agentId, "activate allowance windows");

    const api = createRunsApi(context);
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.ensureOrgModelProvider(actor);
    const run = await api.createRun(actor, {
      agentId,
      prompt: "non-built-in run inside active allowance window",
      modelProvider: "anthropic-api-key",
    });
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("does not apply newly created allowance to older runs", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const runCreatedAt = nowDate();
    mockNow(runCreatedAt);
    const { actor, orgId, agentId } = await builtInAllowanceActor({
      credits: 100,
    });
    const run = await createBuiltInRun(
      actor,
      agentId,
      "run before entitlement",
    );
    mockNow(addHours(runCreatedAt, 1));
    await seedAllowanceEntitlement(actor, orgId, {
      shortWindowUnits: 100,
      weeklyWindowUnits: 200,
    });
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(20);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("applies existing allowance windows after entitlement is canceled for an already created run", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, orgId, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const run = await createBuiltInRun(
      actor,
      agentId,
      "run created before allowance cancellation",
    );

    const canceledAt = addHours(startedAt, 1);
    mockNow(canceledAt);
    await cancelUsageAllowanceSubscription(orgId);
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("does not apply existing allowance windows after entitlement is canceled", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, orgId, agentId } = await builtInAllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    await createBuiltInRun(actor, agentId, "activate allowance windows");
    const canceledAt = addHours(startedAt, 1);
    mockNow(canceledAt);
    await cancelUsageAllowanceSubscription(orgId);
    mockNow(addHours(startedAt, 2));
    const run = await createBuiltInRun(
      actor,
      agentId,
      "new run after allowance cancellation",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processOrgUsageEvents(actor);

    await expect(readOrgCredits(actor)).resolves.toBe(20);
    await expect(readVisibleUsageCredits(actor)).resolves.toBe(80);
  });

  it("denies billable firewall auth when the run has no allowance window", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const runCreatedAt = nowDate();
    mockNow(runCreatedAt);
    const { actor, orgId, agentId } = await builtInAllowanceActor({
      credits: 100,
    });
    const api = createRunsApi(context);
    await api.ensureOrgModelProvider(actor);
    // BYOK runs do not receive built-in credit admission, and this run
    // predates the entitlement, so it has no allowance windows.
    const run = await api.createRun(actor, {
      agentId,
      prompt: "run without windows",
      modelProvider: "anthropic-api-key",
    });
    mockNow(addHours(runCreatedAt, 1));
    await seedAllowanceEntitlement(actor, orgId, {
      shortWindowUnits: 2,
      weeklyWindowUnits: 2,
    });
    await seedOrgMetadata({ orgId, tier: "pro", credits: 0 });
    const client = setupApp({
      context,
      routes: webhooksAgentFirewallAuthRoutes,
    })(webhookFirewallAuthContract);
    const headers = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };
    const body = {
      encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
      authHeaders: { Authorization: "Bearer static-token" },
      firewallBillable: true,
    };

    const denied = await accept(client.resolve({ headers, body }), [402]);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });
});
