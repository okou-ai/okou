import { randomUUID } from "node:crypto";

import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { onboardingStatusRoutes } from "../onboarding-status";
import { modelPoliciesRoutes } from "../model-policies";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { ensureCustomModelModeForTest } from "./helpers/org-model-policy-write";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function onboardingStatusClient() {
  return setupApp({ context, routes: onboardingStatusRoutes })(
    onboardingStatusContract,
  );
}

function onboardingCompleteClient() {
  return setupApp({ context, routes: onboardingCompleteRoutes })(
    onboardingCompleteContract,
  );
}

function modelPoliciesClient() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

/**
 * A request the typed client cannot express: the contract narrows `industry`
 * to the offered list and rejects a key it does not declare.
 */
function rawCompleteRequest(body: Record<string, unknown>) {
  return setupRawAppRequest({ context, routes: onboardingCompleteRoutes })(
    "/api/onboarding/complete",
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function orgActor(role: "org:admin" | "org:member" = "org:admin") {
  return {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    role,
  } as const;
}

interface OrgActor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

async function configureCustomWorkspace(actor: OrgActor): Promise<void> {
  await seedOrgMetadata({
    orgId: actor.orgId,
    tier: "pro",
    credits: 0,
  });
  mocks.clerk.session(actor.userId, actor.orgId, actor.role);
  await ensureCustomModelModeForTest(context, actor, authHeaders);
}

/** A second person in `admin`'s organization, without admin rights. */
function memberOf(admin: OrgActor) {
  return {
    userId: `user_${randomUUID()}`,
    orgId: admin.orgId,
    role: "org:member",
  } as const;
}

function mockDefaultAgentStorage(): void {
  context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.test/default-agent.tar.gz?signature=test",
  );
}

async function statusAs(actor: OrgActor) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.role);
  const response = await accept(
    onboardingStatusClient().getStatus({ headers: authHeaders() }),
    [200],
  );
  return response.body;
}

async function completeAs(
  actor: OrgActor,
  request: {
    readonly query?: { readonly modelProvider: "codex" | "claudeCode" };
    readonly body?: {
      readonly timezone?: string;
      readonly industry?: "marketing";
    };
  } = {},
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.role);
  const response = await accept(
    onboardingCompleteClient().complete({
      headers: authHeaders(),
      ...(request.query ? { query: request.query } : {}),
      body: request.body ?? {},
    }),
    [200],
  );
  return response.body;
}

describe("GET /api/onboarding/status", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      onboardingStatusClient().getStatus({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("member source-first onboarding", () => {
  it("starts onboarding for a new member", async () => {
    const admin = orgActor();
    const member = memberOf(admin);

    await expect(statusAs(member)).resolves.toStrictEqual({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("keeps the organization's completion as the org-wide answer for a member", async () => {
    mockDefaultAgentStorage();
    const admin = orgActor();
    const member = memberOf(admin);
    await statusAs(admin);
    await completeAs(admin);

    // The owner finishing setup does not finish it for the member.
    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: true,
      isAdmin: false,
    });
  });

  it("records a member's completion without changing the organization's onboarding", async () => {
    mockDefaultAgentStorage();
    const admin = orgActor();
    const member = memberOf(admin);
    const adminBefore = await statusAs(admin);
    expect(adminBefore).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
    });

    const completed = await completeAs(member, {
      query: { modelProvider: "codex" },
      body: { timezone: "Asia/Shanghai", industry: "marketing" },
    });

    expect(completed).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
    });
    // The admin still has the workspace to set up, and none of the member's
    // answers were taken as the organization's.
    await expect(statusAs(admin)).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
    });
    mocks.clerk.session(admin.userId, admin.orgId, admin.role);
    const policies = await accept(
      modelPoliciesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
  });

  it("does not pull a member who already chats in the workspace into onboarding", async () => {
    const admin = bdd.user();
    if (!admin.orgId) {
      throw new Error("Expected the seeded admin to belong to an org");
    }
    const existing = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(existing, {
      displayName: "Existing member agent",
      visibility: "private",
    });
    await chat.createThread(existing, { agentId: agent.agentId });
    const member = {
      userId: existing.userId,
      orgId: admin.orgId,
      role: "org:member",
    } as const;

    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: false,
      isAdmin: false,
    });
  });
});

describe("POST /api/onboarding/complete", () => {
  it("lets a member complete onboarding instead of refusing them", async () => {
    const member = orgActor("org:member");

    await expect(completeAs(member)).resolves.toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  it("persists an admin's completed onboarding state", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );

    const before = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(before.body).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
    });
    expect(before.body.defaultAgentId).toBeTruthy();

    const completed = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: {},
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });

    const after = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(after.body).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: before.body.defaultAgentId,
    });
    const policies = await accept(
      modelPoliciesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
    // A new organization starts in Auto.
    expect(policies.body.modelMode).toBe("auto");
  });

  it("lists only the system default policy for a new Auto organization after a subscription choice", async () => {
    const actor = orgActor();
    mockDefaultAgentStorage();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "codex" },
        body: {},
      }),
      [200],
    );
    const response = await accept(
      modelPoliciesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(response.body.modelMode).toBe("auto");
    expect(response.body.policies).toStrictEqual([
      expect.objectContaining({
        model: SEEDED_SYSTEM_DEFAULT_MODEL,
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
    ]);
  });

  it.each([
    {
      provider: "codex" as const,
      models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
      route: "codex-oauth-token",
    },
    {
      provider: "claudeCode" as const,
      models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5"],
      route: "claude-code-oauth-token",
    },
  ])(
    "seeds $provider subscription models for a Custom organization even when the default seed was read first",
    async ({ provider, models, route }) => {
      const actor = orgActor();
      await configureCustomWorkspace(actor);
      mocks.clerk.session(actor.userId, actor.orgId, actor.role);
      const policies = modelPoliciesClient();
      const before = await accept(
        policies.list({ headers: authHeaders() }),
        [200],
      );
      expect(before.body.modelMode).toBe("custom");
      expect(
        before.body.policies.map((policy) => {
          return policy.model;
        }),
      ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);

      await accept(
        onboardingCompleteClient().complete({
          headers: authHeaders(),
          query: { modelProvider: provider },
          body: {},
        }),
        [200],
      );
      const after = await accept(
        policies.list({ headers: authHeaders() }),
        [200],
      );
      expect(
        after.body.policies.map((policy) => {
          return policy.model;
        }),
      ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL, ...models]);
      for (const model of models) {
        expect(
          after.body.policies.find((policy) => {
            return policy.model === model;
          }),
        ).toMatchObject({
          defaultProviderType: route,
          credentialScope: "member",
        });
      }

      await accept(
        onboardingCompleteClient().complete({
          headers: authHeaders(),
          query: {
            modelProvider: provider === "codex" ? "claudeCode" : "codex",
          },
          body: {},
        }),
        [200],
      );
      const repeated = await accept(
        policies.list({ headers: authHeaders() }),
        [200],
      );
      expect(
        repeated.body.policies.map((policy) => {
          return policy.model;
        }),
      ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL, ...models]);
    },
  );

  it("applies a subscription choice after the previous untouched model seed", async () => {
    const actor = orgActor();
    await configureCustomWorkspace(actor);
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    const policies = modelPoliciesClient();
    const before = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    // The seed an older API wrote, plus the fixed default this API adds.
    await accept(
      policies.update({
        headers: authHeaders(),
        body: {
          revision: before.body.revision,
          policies: (
            [
              SEEDED_SYSTEM_DEFAULT_MODEL,
              "claude-fable-5-1",
              "gpt-6-astra",
              "gpt-5.6-luna",
            ] as const
          ).map((model) => {
            return {
              model,
              defaultProviderType: "built-in" as const,
              credentialScope: "org" as const,
              modelProviderId: null,
            };
          }),
        },
      }),
      [200],
    );

    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "codex" },
        body: {},
      }),
      [200],
    );
    const after = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      after.body.policies.map((policy) => {
        return [policy.model, policy.defaultProviderType];
      }),
    ).toStrictEqual([
      [SEEDED_SYSTEM_DEFAULT_MODEL, "built-in"],
      ["gpt-6-astra", "codex-oauth-token"],
      ["gpt-6-sol", "codex-oauth-token"],
      ["gpt-6-luna", "codex-oauth-token"],
    ]);
  });

  it("keeps a new workspace in Auto when onboarding requests a subscription before connecting it", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "claudeCode" },
        body: {},
      }),
      [200],
    );
    const policies = await accept(
      modelPoliciesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
    expect(policies.body.modelMode).toBe("auto");
  });

  it("keeps a customized model policy when onboarding completes", async () => {
    const actor = orgActor();
    await configureCustomWorkspace(actor);
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    const policies = modelPoliciesClient();
    const before = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    await accept(
      policies.update({
        headers: authHeaders(),
        body: {
          revision: before.body.revision,
          policies: [
            {
              model: SEEDED_SYSTEM_DEFAULT_MODEL,
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
            {
              model: "gpt-5.6-luna",
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
          ],
        },
      }),
      [200],
    );

    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "claudeCode" },
        body: {},
      }),
      [200],
    );
    const after = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      after.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL, "gpt-5.6-luna"]);
  });

  it("completes an admin's onboarding with the field the source-first flow answered", async () => {
    const actor = orgActor();
    mockDefaultAgentStorage();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const completed = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: { industry: "marketing" },
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });

    const status = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
    });
  });

  it("rejects a field the flow does not offer", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );

    const rejected = await rawCompleteRequest({ industry: "farming" });

    expect(rejected.status).toBe(400);
    const status = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
    });
  });

  it("rejects an unknown model preference before completing onboarding", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const rejected = await setupRawAppRequest({
      context,
      routes: onboardingCompleteRoutes,
    })("/api/onboarding/complete?modelProvider=unknown", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    expect(rejected.status).toBe(400);
    const status = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body.onboardingComplete).toBeFalsy();
  });

  it("rejects a key the completion body does not declare", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const rejected = await rawCompleteRequest({ industries: ["marketing"] });

    expect(rejected.status).toBe(400);
  });
});
