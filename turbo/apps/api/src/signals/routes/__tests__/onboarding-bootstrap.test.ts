import { randomUUID } from "node:crypto";

import {
  agentInstructionsContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentInstructionsRoutes } from "../agent-instructions";
import { agentsRoutes } from "../agents";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { mockNow, now } from "../../../lib/time";
import { onboardingStatusRoutes } from "../onboarding-status";
import { runModelsRoutes } from "../run-models";
import { userPreferencesRoutes } from "../user-preferences";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function clients(
  options: { readonly rethrowErrors?: boolean } = {},
  signal: AbortSignal = context.signal,
) {
  const app = setupApp({
    context,
    signal,
    rethrowErrors: options.rethrowErrors,
    routes: [
      ...onboardingStatusRoutes,
      ...agentsRoutes,
      ...agentInstructionsRoutes,
      ...billingStatusRoutes,
      ...billingUsagePackCreditsRoutes,
      ...runModelsRoutes,
    ],
  });
  return {
    status: app(onboardingStatusContract),
    agents: app(agentsMainContract),
    instructions: app(agentInstructionsContract),
    billing: app(billingStatusContract),
    usagePack: app(billingUsagePackCreditsContract),
    models: app(runModelsMainContract),
  };
}

function authenticateAdmin(): string {
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
  return orgId;
}

async function readDefaultId(api: ReturnType<typeof clients>): Promise<string> {
  const response = await accept(api.status.getStatus({ headers }), [200]);
  const agentId = response.body.defaultAgentId;
  if (!agentId) {
    throw new Error("Expected a usable default Agent");
  }
  return agentId;
}

async function expectInstructions(
  api: ReturnType<typeof clients>,
  agentId: string,
  content: string,
): Promise<void> {
  const instructions = await accept(
    api.instructions.get({ headers, params: { id: agentId } }),
    [200],
  );
  expect(instructions.body.content).toBe(content);
}

async function expectSingleOnboardingGrant(
  api: ReturnType<typeof clients>,
): Promise<void> {
  const billing = await accept(api.billing.get({ headers }), [200]);
  expect(billing.body.credits).toBe(0);
  expect(billing.body.creditGrants).toStrictEqual([]);
  const usagePack = await accept(api.usagePack.get({ headers }), [200]);
  expect(usagePack.body).toMatchObject({
    totalCredits: 1000,
    purchasedCredits: 0,
    bonusCredits: 1000,
    hasUsagePack: false,
  });
  expect(usagePack.body.creditGrants).toStrictEqual([
    expect.objectContaining({
      grantType: "bonus",
      amount: 1000,
      remaining: 1000,
    }),
  ]);
}

describe("default Agent bootstrap", () => {
  it("preserves saved member preferences during lazy bootstrap", async () => {
    authenticateAdmin();
    const preferences = setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    );
    const saved = {
      timezone: "Asia/Shanghai",
      locale: "zh-Hans",
      sendMode: "cmd-enter",
      cloudBrowserEnabledByDefault: false,
      theme: "dark",
      colorTheme: "deep-lagoon",
      captureNetworkBodiesRemaining: 3,
    } as const;
    await accept(preferences.update({ headers, body: saved }), [200]);
    const before = await accept(preferences.get({ headers }), [200]);
    expect(before.body).toMatchObject(saved);

    const api = clients();
    const agentId = await readDefaultId(api);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    const after = await accept(preferences.get({ headers }), [200]);
    expect(after.body).toStrictEqual(before.body);
    await expectSingleOnboardingGrant(api);
  });

  it("publishes one usable default and one grant for concurrent status requests", async () => {
    authenticateAdmin();
    const api = clients();
    const responses = await Promise.all([
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
    ]);
    const agentId = responses[0]?.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected a usable default Agent");
    }
    for (const response of responses) {
      expect(response.body).toMatchObject({
        hasDefaultAgent: true,
        defaultAgentId: agentId,
      });
    }
    const listed = await accept(api.agents.list({ headers }), [200]);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.agentId).toBe(agentId);
    const instructions = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(instructions.body.content).toBe(SEED_INSTRUCTIONS);
    const policies = await accept(api.models.list({ headers }), [200]);
    expect(policies.body.models).toStrictEqual([
      expect.objectContaining({
        model: "auto",
        memberEffective: expect.objectContaining({
          providerType: "built-in",
          credentialScope: "org",
        }),
      }),
    ]);

    const edited = "Shared team instructions must survive repeated bootstrap.";
    await accept(
      api.instructions.update({
        headers,
        params: { id: agentId },
        body: { content: edited },
      }),
      [200],
    );
    await accept(api.status.getStatus({ headers }), [200]);
    const after = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(after.body.content).toBe(edited);
    await expectSingleOnboardingGrant(api);
  });

  it("creates a separate system Okou and preserves its reference when custom agents change", async () => {
    authenticateAdmin();
    const api = clients();
    const custom = await accept(
      api.agents.create({
        headers,
        body: {
          displayName: "Okou",
          visibility: "private",
          description: "A custom role",
        },
      }),
      [201],
    );
    const agentId = await readDefaultId(api);
    expect(agentId).not.toBe(custom.body.agentId);
    const listed = await accept(api.agents.list({ headers }), [200]);
    expect(listed.body).toHaveLength(2);
    expect(listed.body).toContainEqual(custom.body);
    expect(listed.body).toContainEqual(
      expect.objectContaining({
        agentId,
        isDefaultAgent: true,
        displayName: "Okou",
        visibility: "public",
      }),
    );
    await accept(
      api.instructions.update({
        headers,
        params: { id: custom.body.agentId },
        body: { content: "Custom instructions" },
      }),
      [200],
    );
    const repeated = await Promise.all([
      readDefaultId(api),
      readDefaultId(api),
    ]);
    expect(repeated).toStrictEqual([agentId, agentId]);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    await expectInstructions(api, custom.body.agentId, "Custom instructions");
    await expectSingleOnboardingGrant(api);
  });

  it("keeps the onboarding bonus personal to the workspace creator", async () => {
    const creator = createBddApi(context).user();
    if (!creator.orgId) {
      throw new Error("Expected a workspace creator");
    }
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    const api = clients();
    await readDefaultId(api);
    await expectSingleOnboardingGrant(api);
    const creatorCredits = await accept(api.usagePack.get({ headers }), [200]);
    expect(creatorCredits.body.memberCredits).toStrictEqual([
      expect.objectContaining({
        memberId: creator.userId,
        totalCredits: 1000,
        bonusCredits: 1000,
      }),
    ]);

    mocks.clerk.session(`user_${randomUUID()}`, creator.orgId, "org:member");
    await accept(api.status.getStatus({ headers }), [200]);
    const memberCredits = await accept(api.usagePack.get({ headers }), [200]);
    expect(memberCredits.body).toMatchObject({
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });
    expect(memberCredits.body.memberCredits).toBeUndefined();
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    const unchanged = await accept(api.usagePack.get({ headers }), [200]);
    expect(unchanged.body).toStrictEqual(creatorCredits.body);
  });

  it("expires the personal onboarding grant after 30 days without restarting on replay", async () => {
    const grantedAt = new Date("2027-01-01T12:34:56.789Z");
    const expiresAt = new Date("2027-01-31T12:34:56.789Z");
    mockNow(grantedAt);
    authenticateAdmin();
    const api = clients();
    const agentId = await readDefaultId(api);
    await expectSingleOnboardingGrant(api);
    const granted = await accept(api.usagePack.get({ headers }), [200]);
    expect(granted.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 1000,
        remaining: 1000,
        expiresAt: expiresAt.toISOString(),
      }),
    ]);

    mockNow(expiresAt.getTime() - 1);
    await expect(readDefaultId(api)).resolves.toBe(agentId);
    const beforeExpiry = await accept(api.usagePack.get({ headers }), [200]);
    expect(beforeExpiry.body).toStrictEqual(granted.body);
    mockNow(expiresAt);
    await expect(readDefaultId(api)).resolves.toBe(agentId);
    const expired = await accept(api.usagePack.get({ headers }), [200]);
    expect(expired.body).toMatchObject({
      totalCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });
    const billing = await accept(api.billing.get({ headers }), [200]);
    expect(billing.body.credits).toBe(0);
    expect(billing.body.creditGrants).toStrictEqual([]);
  });

  it("issues one personal bonus through the Clerk organization webhook and status replay", async () => {
    const creator = createBddApi(context).user();
    if (!creator.orgId) {
      throw new Error("Expected a workspace creator");
    }
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    const event = {
      type: "organization.created",
      data: {
        id: creator.orgId,
        created_by: creator.userId,
        created_at: now(),
      },
    };
    webhooks.verifyNextClerkWebhook(event);
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    const api = clients();
    await expectSingleOnboardingGrant(api);
    const initial = await accept(api.usagePack.get({ headers }), [200]);

    webhooks.verifyNextClerkWebhook(event);
    await Promise.all([
      webhooks.requestClerkWebhook("{}", {}, [200]),
      accept(api.status.getStatus({ headers }), [200]),
    ]);
    await flushWaitUntilForTest();
    await expectSingleOnboardingGrant(api);
    const replayed = await accept(api.usagePack.get({ headers }), [200]);
    expect(replayed.body).toStrictEqual(initial.body);
  });

  it("preserves the accepted default and grant when later bundle publication fails", async () => {
    authenticateAdmin();
    const api = clients({ rethrowErrors: false });
    const agentId = await readDefaultId(api);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    context.mocks.s3.send.mockRejectedValue(
      new Error("Object storage is unavailable"),
    );
    await expect(
      api.instructions.update({
        headers,
        params: { id: agentId },
        body: { content: "Edited default" },
      }),
    ).rejects.toThrow("500");
    const peers = await Promise.all([readDefaultId(api), readDefaultId(api)]);
    expect(peers).toStrictEqual([agentId, agentId]);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    await expectSingleOnboardingGrant(api);
  });

  it("recovers default bootstrap after an instruction bundle upload fails", async () => {
    authenticateAdmin();
    const api = clients({ rethrowErrors: false });
    context.mocks.s3.send.mockRejectedValueOnce(
      new Error("Object storage is unavailable"),
    );
    const pending = await accept(api.status.getStatus({ headers }), [200]);
    expect(pending.body).toMatchObject({
      defaultAgentId: null,
      hasDefaultAgent: false,
    });
    const before = await accept(api.agents.list({ headers }), [200]);
    expect(before.body).toStrictEqual([]);
    const agentId = await readDefaultId(api);
    await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    await expectSingleOnboardingGrant(api);
    await expect(readDefaultId(api)).resolves.toBe(agentId);
  });

  it.each(["pro", "team"] as const)(
    "preserves a %s purchase racing bootstrap",
    async (tier) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected a paid workspace");
      }
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const api = clients();
      await Promise.all([
        accept(api.status.getStatus({ headers }), [200]),
        createRunsApi(context).grantProEntitlement(actor, { tier }),
      ]);
      const agentId = await readDefaultId(api);
      const billing = await accept(api.billing.get({ headers }), [200]);
      expect(billing.body.tier).toBe(tier);
      const listed = await accept(api.agents.list({ headers }), [200]);
      expect(listed.body).toStrictEqual([
        expect.objectContaining({
          agentId,
          ownerId: actor.userId,
          isDefaultAgent: true,
        }),
      ]);
      await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    },
  );
  it.each(["pro", "team"] as const)(
    "does not grant limited-free credits to an already %s workspace",
    async (tier) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected a paid workspace");
      }
      await createRunsApi(context).grantProEntitlement(actor, { tier });
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const api = clients();
      const agentId = await readDefaultId(api);
      const peers = await Promise.all([readDefaultId(api), readDefaultId(api)]);
      expect(peers).toStrictEqual([agentId, agentId]);
      const billing = await accept(api.billing.get({ headers }), [200]);
      expect(billing.body.tier).toBe(tier);
      const credits = await accept(api.usagePack.get({ headers }), [200]);
      expect(credits.body.totalCredits).toBe(0);
      expect(credits.body.creditGrants).toStrictEqual([]);
      await expectInstructions(api, agentId, SEED_INSTRUCTIONS);
    },
  );
});
