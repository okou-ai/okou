import { onTestFinished } from "vitest";
import { SEEDED_ROUTED_MODELS } from "@okouai/core/__tests__/seeded-model-catalog";
import { randomUUID } from "node:crypto";
import {
  isBuiltInModelProviderType,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
  type ModelProviderWriteType,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { modelProviderConnectionsMainContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createApp } from "../../../app-factory";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { updateRestrictedPlanAccessFixture } from "../../../test-fixtures/model-route-capabilities";
import {
  setOrgMemberRunModelOutsidePolicyFixture,
  setOrgModelPolicyProviderTypeFixture,
  stagePreAddabilityModelPolicyFixture,
} from "../../../test-fixtures/org-model-policies";
import { insertBuiltInModelMirrorFixture } from "../../../test-fixtures/model-catalog";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createRouteMocks } from "./helpers/route-test";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { makeCodexAuthJson } from "./helpers/api-bdd-auth-device";
import {
  coolDownBuiltInCandidatesFixture,
  seedBuiltInModelCandidateKeys,
} from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { modelPoliciesRoutes } from "../model-policies";
import { modelProvidersRoutes } from "../model-providers";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

const TEST_APP_ROUTES = Object.freeze([
  ...modelPoliciesRoutes,
  ...modelProviderGatewayRoutes,
  ...userModelPreferenceRoutes,
]);

type ModelPolicyFixture = ApiTestUser & { readonly orgId: string };

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsApi(context);
const MODEL_POLICIES_PATH = "/api/model-policies";

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function toUpdate(data: OrgModelPoliciesResponse): UpdateOrgModelPolicy[] {
  return data.policies.map((policy) => {
    return {
      model: policy.model,
      defaultProviderType: isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? "built-in"
        : policy.defaultProviderType,
      credentialScope: policy.credentialScope,
      modelProviderId: policy.modelProviderId,
      modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
    };
  });
}

function makeBuiltInPolicy(
  model: UpdateOrgModelPolicy["model"],
): UpdateOrgModelPolicy {
  return {
    model,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
  };
}

function apiClient() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

/**
 * The write precondition is mandatory, so a caller reads before it writes. The
 * read also seeds a workspace that has never been listed, which is exactly what
 * a real client does before its first write.
 */
async function currentPolicyRevision(): Promise<string> {
  const current = await accept(
    apiClient().list({ headers: authHeaders() }),
    [200],
  );
  return current.body.revision;
}

function useSession(
  fixture: ModelPolicyFixture,
  orgRole: "org:admin" | "org:member" = "org:admin",
): void {
  mocks.clerk.session(fixture.userId, fixture.orgId, orgRole);
}

async function putRawModelPolicies(body: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  const response = await app.request(MODEL_POLICIES_PATH, {
    method: "PUT",
    headers: {
      authorization: "Bearer clerk-session",
      "content-type": "application/json",
    },
    body,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function seedFixture(): ModelPolicyFixture {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected model policy fixture to have an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

async function createOrgProvider(
  fixture: ModelPolicyFixture,
  type: ModelProviderWriteType,
): Promise<string> {
  const { providerId } = await runsApi.createOrgModelProvider(fixture, {
    type,
    secret: "test-model-provider-secret",
  });
  return providerId;
}

/** Enter Auto the way production does: a Debug admin uses the mode route. */
async function switchModelMode(
  fixture: ModelPolicyFixture,
  mode: "auto" | "custom",
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.OkouDebug]: true,
  });
  useSession(fixture);
  await accept(
    apiClient().updateMode({ headers: authHeaders(), body: { mode } }),
    [200],
  );
}

async function connectCodexSubscription(
  fixture: ModelPolicyFixture,
): Promise<void> {
  await createMiscRoutesApi(context).upsertPersonalModelProvider(
    fixture,
    {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: {
        CODEX_AUTH_JSON: makeCodexAuthJson({ accountId: randomUUID() }),
      },
    },
    [200, 201],
  );
  useSession(fixture);
}

async function makeLimitedFreeWorkspace(
  fixture: ModelPolicyFixture,
): Promise<void> {
  authOrgApi.acceptAgentStorageWrites();
  const status = await authOrgApi.readOnboardingStatus(fixture);
  if (!status.defaultAgentId) {
    throw new Error(
      "Expected limited-free bootstrap to create a default agent",
    );
  }
}

/**
 * Earlier APIs seeded every workspace with the same built-in models, so a
 * limited-free-1 workspace can own rows whose built-in route its plan could
 * not configure today. New organizations start in Auto; switch to Custom and
 * stage that historical row. Reading the list mirrors the client, which
 * re-sends the whole list on every write.
 */
async function listSeededLimitedFreePolicies(): Promise<{
  readonly fixture: ModelPolicyFixture;
  readonly stored: OrgModelPoliciesResponse;
}> {
  const fixture = seedFixture();
  await makeLimitedFreeWorkspace(fixture);
  await switchModelMode(fixture, "custom");
  await stagePreAddabilityModelPolicyFixture({
    orgId: fixture.orgId,
    userId: fixture.userId,
    model: "gpt-6-astra",
  });
  const stored = await accept(
    apiClient().list({ headers: authHeaders() }),
    [200],
  );
  expect(
    stored.body.policies.map((policy) => {
      return policy.model;
    }),
  ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL, "gpt-6-astra"]);
  return { fixture, stored: stored.body };
}

describe("GET/PUT /api/model-policies", () => {
  it("keeps the org mode separate from policies and exposes Auto policies to members without the switch", async () => {
    const fixture = seedFixture();
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });
    useSession(fixture);
    const client = apiClient();
    const initial = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(initial.body.modelMode).toBe("custom");
    await createOrgProvider(fixture, "anthropic-api-key");
    const gateways = setupApp({ context, routes: modelProviderGatewayRoutes })(
      modelProviderConnectionsMainContract,
    );
    await accept(
      gateways.create({
        headers: authHeaders(),
        body: {
          displayName: "Legacy workspace gateway",
          secret: "test-only-gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: { "claude-sonnet-5": "legacy-sonnet" },
            },
          ],
        },
      }),
      [201],
    );

    const unavailable = await client.updateMode({
      headers: authHeaders(),
      body: { mode: "auto" },
    });
    expect(unavailable.status).toBe(403);
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    useSession(fixture);

    await accept(
      client.updateMode({
        headers: authHeaders(),
        body: { mode: "auto" },
      }),
      [200],
    );
    expect(
      (await accept(gateways.list({ headers: authHeaders() }), [200])).body
        .connections,
    ).toStrictEqual([]);
    const rejectedGateway = await accept(
      gateways.create({
        headers: authHeaders(),
        body: {
          displayName: "Auto workspace gateway",
          secret: "test-only-gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {},
            },
          ],
        },
      }),
      [400],
    );
    expect(rejectedGateway.body.error.message).toContain("Auto mode");
    const auto = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(
      auto.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
    expect(
      (
        await client.update({
          headers: authHeaders(),
          body: {
            revision: auto.body.revision,
            policies: [
              makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
              makeBuiltInPolicy("gpt-6-luna"),
            ],
          },
        })
      ).status,
    ).toBe(400);
    const memberFixture = { ...fixture, userId: `user_${randomUUID()}` };
    useSession(memberFixture, "org:member");
    const member = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(member.body.modelMode).toBe("auto");
    expect(
      member.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
    expect(
      (
        await client.updateMode({
          headers: authHeaders(),
          body: { mode: "custom" },
        })
      ).status,
    ).toBe(403);
  });

  it("projects the seven subscription catalog entries only for the connected Auto member", async () => {
    const fixture = seedFixture();
    // Plan state is infrastructure-owned; Auto admits subscriptions on limited-free.
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    await switchModelMode(fixture, "auto");
    const client = apiClient();
    const before = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(
      before.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
    await createMiscRoutesApi(context).upsertPersonalModelProvider(
      fixture,
      { type: "claude-code-oauth-token", secret: "sk-ant-oat-auto-member" },
      [200, 201],
    );
    await connectCodexSubscription(fixture);
    const after = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(
      after.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([
      "okou-1.0",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(
      after.body.policies.find((policy) => {
        return policy.model === "claude-sonnet-5-5";
      }),
    ).toMatchObject({
      modelLabel: "Claude Sonnet 5.5",
      subscriptionOptions: {
        efforts: ["low", "medium", "high", "extra", "max", "ultracode"],
        serviceTier: null,
      },
      memberEffective: {
        providerType: "claude-code-oauth-token",
        availability: "available",
      },
    });
    expect(
      after.body.policies.find((policy) => {
        return policy.model === "gpt-6.1-sol";
      })?.subscriptionOptions,
    ).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      serviceTier: "priority",
    });
    expect(
      after.body.policies.find((policy) => {
        return policy.model === "gpt-6-astra";
      })?.subscriptionOptions,
    ).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      serviceTier: "priority",
    });
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const claudePreference = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-5-5", serviceTier: null },
      }),
      [200],
    );
    expect(claudePreference.body.selectedModel).toBe("claude-sonnet-5-5");
    const codexPreference = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-6-astra", serviceTier: "priority" },
      }),
      [200],
    );
    expect(codexPreference.body.serviceTier).toBe("priority");
    const outsideCatalogEffort = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: "gpt-6-luna",
          serviceTier: null,
          modelSettingsPatch: { model: "gpt-6-luna", effort: "ultra" },
        },
      }),
      [400],
    );
    expect(outsideCatalogEffort.body).toMatchObject({
      error: {
        message: "Reasoning effort is not available for this subscription",
      },
    });
    const other = { ...fixture, userId: `user_${randomUUID()}` };
    useSession(other, "org:member");
    const otherList = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      otherList.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
  });

  it("returns an Auto member to the system default after disconnecting the subscription", async () => {
    const fixture = seedFixture();
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });
    await switchModelMode(fixture, "auto");
    await connectCodexSubscription(fixture);
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-6-sol", serviceTier: "priority" },
      }),
      [200],
    );

    await createMiscRoutesApi(context).deletePersonalModelProvider(
      fixture,
      "codex-oauth-token",
      [204],
    );
    useSession(fixture);
    const preference = await accept(
      preferences.get({ headers: authHeaders() }),
      [200],
    );
    expect(preference.body).toMatchObject({
      selectedModel: "okou-1.0",
      serviceTier: null,
    });
  });

  it("returns subscription members to organization policies when Auto switches back to Custom", async () => {
    const fixture = seedFixture();
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });
    await switchModelMode(fixture, "auto");
    await connectCodexSubscription(fixture);
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-6-sol", serviceTier: "priority" },
      }),
      [200],
    );
    const legacyProvider = await setupApp({
      context,
      routes: modelProvidersRoutes,
    })(modelProvidersMainContract).upsert({
      headers: authHeaders(),
      body: { type: "anthropic-api-key", secret: "auto-workspace-key" },
    });
    expect(legacyProvider.status).toBe(400);

    await switchModelMode(fixture, "custom");
    const preference = await accept(
      preferences.get({ headers: authHeaders() }),
      [200],
    );
    expect(preference.body).toMatchObject({
      selectedModel: "okou-1.0",
      serviceTier: null,
    });
    const custom = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(custom.body.modelMode).toBe("custom");
    expect(
      custom.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
    await createOrgProvider(fixture, "anthropic-api-key");
    const updated = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: custom.body.revision,
          policies: [
            makeBuiltInPolicy("okou-1.0"),
            makeBuiltInPolicy("gpt-6-luna"),
          ],
        },
      }),
      [200],
    );
    expect(
      updated.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0", "gpt-6-luna"]);
  });

  it("offers active catalog models to add", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    const initial = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    // `replaced_by IS NULL` is the only addability authority.
    expect(initial.body.modelsAvailableToAdd).toStrictEqual(
      expect.arrayContaining(["gpt-5.6-sol", "gpt-6-sol", "claude-opus-5-5"]),
    );
  });

  it("can re-add GPT 6 Luna after removing it", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    const client = apiClient();
    const replaced = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy("gpt-5.6-luna"),
          ],
        },
      }),
      [200],
    );
    expect(replaced.body.modelsAvailableToAdd).toContain("gpt-6-luna");

    const restored = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy("gpt-5.6-luna"),
            makeBuiltInPolicy("gpt-6-luna"),
          ],
        },
      }),
      [200],
    );
    expect(
      restored.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toContain("gpt-6-luna");
  });

  it("admits active Sonnet 5.5 subject to the organization plan", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    await seedBuiltInModelCandidateKeys(context, "claude-sonnet-5-5");
    const client = apiClient();
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(listed.body.modelsAvailableToAdd).toContain("claude-sonnet-5-5");
    const added = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: listed.body.revision,
          policies: [
            ...toUpdate(listed.body),
            makeBuiltInPolicy("claude-sonnet-5-5"),
          ],
        },
      }),
      [200],
    );
    expect(added.body.policies).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-5-5",
        runtimeProviderType: "anthropic-api-key",
        routeStatus: "valid",
      }),
    );

    const free = seedFixture();
    await makeLimitedFreeWorkspace(free);
    await switchModelMode(free, "custom");
    const freePolicies = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const providerId = await createOrgProvider(free, "anthropic-api-key");
    for (const policy of [
      makeBuiltInPolicy("claude-sonnet-5-5"),
      {
        ...makeBuiltInPolicy("claude-sonnet-5-5"),
        defaultProviderType: "anthropic-api-key" as const,
        modelProviderId: providerId,
      },
    ]) {
      const denied = await client.update({
        headers: authHeaders(),
        body: {
          revision: freePolicies.body.revision,
          policies: [...toUpdate(freePolicies.body), policy],
        },
      });
      expect(denied.status).toBe(402);
      expect(denied.body).toMatchObject({
        error: { code: "PRO_REQUIRED" },
      });
    }
    const unchanged = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      unchanged.body.policies.some((policy) => {
        return policy.model === "claude-sonnet-5-5";
      }),
    ).toBeFalsy();
  });

  it("keeps a stored model configurable and lets it be re-added while active", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    const client = apiClient();
    await accept(client.list({ headers: authHeaders() }), [200]);
    await stagePreAddabilityModelPolicyFixture({
      orgId: fixture.orgId,
      userId: fixture.userId,
      model: "gpt-6-sol",
    });

    const existing = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      existing.body.policies.some((policy) => {
        return policy.model === "gpt-6-sol";
      }),
    ).toBeTruthy();

    const kept = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: toUpdate(existing.body),
        },
      }),
      [200],
    );
    expect(
      kept.body.policies.some((policy) => {
        return policy.model === "gpt-6-sol";
      }),
    ).toBeTruthy();

    const removed = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: toUpdate(kept.body).filter((policy) => {
            return policy.model !== "gpt-6-sol";
          }),
        },
      }),
      [200],
    );
    expect(removed.body.modelsAvailableToAdd).toContain("gpt-6-sol");

    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [...toUpdate(removed.body), makeBuiltInPolicy("gpt-6-sol")],
        },
      }),
      [200],
    );
  });

  it.each([
    ["claude-fable-5", "claude-fable-5-1"],
    ["gpt-5.5", "gpt-6-luna"],
    ["claude-sonnet-4-6", "claude-sonnet-5-5"],
    ["claude-opus-4-8", "claude-opus-5-5"],
    ["deepseek-v4-pro", "gpt-6-luna"],
  ] as const)(
    "stores a %s preference as its replacement %s",
    async (retiredModel, replacement) => {
      const fixture = seedFixture();
      useSession(fixture);
      const client = apiClient();
      const existing = await accept(
        client.list({ headers: authHeaders() }),
        [200],
      );
      await accept(
        client.update({
          headers: authHeaders(),
          body: {
            revision: existing.body.revision,
            policies: [
              ...toUpdate(existing.body),
              makeBuiltInPolicy(replacement),
            ],
          },
        }),
        [200],
      );
      const preferences = setupApp({
        context,
        routes: userModelPreferenceRoutes,
      })(userModelPreferenceContract);
      // A client sending the replaced ID stores the final model.
      const stored = await accept(
        preferences.update({
          headers: authHeaders(),
          body: { selectedModel: retiredModel, serviceTier: null },
        }),
        [200],
      );
      expect(stored.body.selectedModel).toBe(replacement);
    },
  );

  it("returns 401 for unauthenticated reads and writes", async () => {
    const client = apiClient();

    const listResponse = await client.list({ headers: {} });
    const updateResponse = await client.update({
      headers: {},
      body: { policies: [] },
    });

    expect(listResponse.status).toBe(401);
    expect(listResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(updateResponse.status).toBe(401);
    expect(updateResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 for sessions without an active organization", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, null);
    const client = apiClient();

    const listResponse = await client.list({
      headers: authHeaders(),
    });
    const updateResponse = await client.update({
      headers: authHeaders(),
      body: { policies: [] },
    });

    expect(listResponse.status).toBe(401);
    expect(listResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(updateResponse.status).toBe(401);
    expect(updateResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("projects only the system default for a workspace without policies", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.policies).toStrictEqual([
      expect.objectContaining({
        model: SEEDED_SYSTEM_DEFAULT_MODEL,
        modelLabel: "Auto",
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
        routeStatus: "valid",
      }),
    ]);
  });

  it("projects the system default beside stored policies", async () => {
    const fixture = await seedFixture();
    // An API that predates the fixed default seeded other built-in models.
    await stagePreAddabilityModelPolicyFixture({
      orgId: fixture.orgId,
      userId: fixture.userId,
      model: "gpt-6-luna",
    });
    useSession(fixture);

    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL, "gpt-6-luna"]);
  });

  it("advertises the current built-in provider for route-specific effort controls", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    // A test-owned mirror of DeepSeek V4 Flash keeps candidate cooldowns
    // isolated from concurrent tests that route the real model.
    const { model, restore } =
      await insertBuiltInModelMirrorFixture("deepseek-v4-flash");
    onTestFinished(restore);
    await seedBuiltInModelCandidateKeys(context, model);
    const client = apiClient();
    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy(model),
          ],
        },
      }),
      [200],
    );
    const runtimeProviderType = (body: OrgModelPoliciesResponse) => {
      return body.policies.find((policy) => {
        return policy.model === model;
      })?.runtimeProviderType;
    };
    expect(runtimeProviderType(response.body)).toBe("openrouter-codex");
    await coolDownBuiltInCandidatesFixture(context, model, [
      {
        provider_type: "openrouter-codex",
        upstream_model: "deepseek/deepseek-v4-flash",
      },
    ]);
    const unavailable = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(runtimeProviderType(unavailable.body)).toBeNull();
  });

  it("preserves canonical built-in rows with legacy built-in route semantics", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [makeBuiltInPolicy("gpt-6-luna")],
        },
      }),
      [200],
    );

    await setOrgModelPolicyProviderTypeFixture({
      orgId: fixture.orgId,
      model: "gpt-6-luna",
      defaultProviderType: "built-in",
    });

    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      response.body.policies.find((policy) => {
        return policy.model === "gpt-6-luna";
      }),
    ).toMatchObject({
      defaultProviderType: "built-in",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
    });
  });

  it("rejects built-in policy writes with a provider ID", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const providerId = await createOrgProvider(fixture, "deepseek");
    const client = apiClient();
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);
    const updates = [
      ...toUpdate(listed.body),
      { ...makeBuiltInPolicy("gpt-6-luna"), modelProviderId: providerId },
    ];

    const response = await client.update({
      headers: authHeaders(),
      body: { revision: await currentPolicyRevision(), policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Built-in routes cannot store a provider ID",
        code: "BAD_REQUEST",
      },
    });
  });

  it("starts a new limited-free-1 workspace in Auto with only the fixed default", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.modelMode).toBe("auto");
    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
    expect(response.body.policies[0]).toMatchObject({
      defaultProviderType: "built-in",
      credentialScope: "org",
    });
  });

  it("starts in Auto when the policy list was read before the workspace bootstrap", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    await accept(client.list({ headers: authHeaders() }), [200]);

    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.modelMode).toBe("auto");
    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
  });

  it("projects the system default beside a written list that omits it", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);

    const written = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: listed.body.revision,
          policies: [makeBuiltInPolicy("gpt-6-luna")],
        },
      }),
      [200],
    );

    expect(
      written.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL, "gpt-6-luna"]);
  });

  it("allows members to read policy controls", async () => {
    const fixture = await seedFixture();
    useSession(fixture, "org:member");

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
  });

  it("allows agent tokens to read policy controls without a model-provider capability", async () => {
    const fixture = await seedFixture();
    authOrgApi.mockClerkOrg(fixture);
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      apiClient().list({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
  });

  it("requires admins for policy writes", async () => {
    const fixture = await seedFixture();
    useSession(fixture, "org:member");

    const response = await apiClient().update({
      headers: authHeaders(),
      body: { revision: await currentPolicyRevision(), policies: [] },
    });

    expect(response.status).toBe(403);
    expect(response.body).toStrictEqual({
      error: {
        message: "Only admins can manage model policies",
        code: "FORBIDDEN",
      },
    });
  });

  it("does not keep a deleted organization's workspace policy", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);
    const updated = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: listed.body.revision,
          policies: [...toUpdate(listed.body), makeBuiltInPolicy("gpt-6-luna")],
        },
      }),
      [200],
    );
    expect(updated.body.policies).toHaveLength(2);

    // An empty organization left by a deleted account uses the same cleanup.
    context.mocks.s3.send.mockResolvedValue({});
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: fixture.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();

    const after = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(
      after.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
  });

  it("removes supported models omitted from an update", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const removedModel = "gpt-6-luna";
    const listResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy(removedModel),
          ],
        },
      }),
      [200],
    );
    const updates = toUpdate(listResponse.body).filter((policy) => {
      return policy.model !== removedModel;
    });

    const updateResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );
    const secondListResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(
      updateResponse.body.policies.some((policy) => {
        return policy.model === removedModel;
      }),
    ).toBeFalsy();
    expect(
      secondListResponse.body.policies.some((policy) => {
        return policy.model === removedModel;
      }),
    ).toBeFalsy();
  });

  it("migrates member preferences from removed models to the fixed default", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const removedModel = "gpt-6-luna";
    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy(removedModel),
          ],
        },
      }),
      [200],
    );
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: removedModel, serviceTier: null },
      }),
      [200],
    );

    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL)],
        },
      }),
      [200],
    );

    const preferenceResponse = await accept(
      preferenceClient.get({ headers: authHeaders() }),
      [200],
    );
    expect(preferenceResponse.body.selectedModel).toBe(
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
  });

  it("keeps member preferences for models still allowed after an update", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const keptModel = "gpt-6-luna";
    const removedModel = "claude-fable-5-1";
    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy(keptModel),
            makeBuiltInPolicy(removedModel),
          ],
        },
      }),
      [200],
    );
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: keptModel, serviceTier: null },
      }),
      [200],
    );

    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy(keptModel),
          ],
        },
      }),
      [200],
    );

    const preferenceResponse = await accept(
      preferenceClient.get({ headers: authHeaders() }),
      [200],
    );
    expect(preferenceResponse.body.selectedModel).toBe(keptModel);
  });

  it("sorts configured models by canonical catalog order", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("claude-opus-5"),
      makeBuiltInPolicy("deepseek-v4-flash"),
    ];
    const configuredModels = new Set(
      updates.map((policy) => {
        return policy.model;
      }),
    );

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(
      SEEDED_ROUTED_MODELS.filter((model) => {
        return configuredModels.has(model);
      }),
    );
  });

  it("asks a limited-free-1 workspace for a paid plan or a subscription before an organization API-key route", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    await switchModelMode(fixture, "custom");
    const openAiProviderId = await createOrgProvider(fixture, "openai-api-key");

    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            {
              ...makeBuiltInPolicy("gpt-6-astra"),
              defaultProviderType: "openai-api-key",
              credentialScope: "org",
              modelProviderId: openAiProviderId,
            },
          ],
        },
      }),
      [402],
    );

    expect(response.body.error).toStrictEqual({
      code: "PRO_REQUIRED",
      message:
        "GPT 6 Astra requires a paid plan. On the free plan, choose Auto or connect your own Claude Code or Codex subscription.",
    });
  });

  it("adds a catalog-freed Built-in model while a limited-free-1 workspace re-sends its stored restricted rows", async () => {
    const { stored } = await listSeededLimitedFreePolicies();
    // Free-plan Built-in access is the catalog row's flag.
    onTestFinished(
      await updateRestrictedPlanAccessFixture({
        model: "gpt-5.6-sol",
        builtInOnRestrictedPlans: true,
      }),
    );

    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [...toUpdate(stored), makeBuiltInPolicy("gpt-5.6-sol")],
        },
      }),
      [200],
    );

    expect(response.body.policies).toContainEqual(
      expect.objectContaining({
        model: "gpt-6-astra",
        defaultProviderType: "built-in",
      }),
    );
    expect(response.body.policies).toContainEqual(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        defaultProviderType: "built-in",
        routeStatus: "valid",
      }),
    );
  });

  it("rejects returning a stored restricted BYOK row to the built-in route", async () => {
    const { fixture, stored } = await listSeededLimitedFreePolicies();
    const openAiProviderId = await createOrgProvider(fixture, "openai-api-key");
    // The API-key route was configured while the workspace was paid.
    await upsertOrgPlanEntitlementFixture({
      orgId: fixture.orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    const routed = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: toUpdate(stored).map((policy) => {
            return policy.model === "gpt-6-astra"
              ? {
                  ...policy,
                  defaultProviderType: "openai-api-key" as const,
                  credentialScope: "org" as const,
                  modelProviderId: openAiProviderId,
                }
              : policy;
          }),
        },
      }),
      [200],
    );
    await upsertOrgPlanEntitlementFixture({
      orgId: fixture.orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: true,
    });

    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: toUpdate(routed.body).map((policy) => {
            return policy.model === "gpt-6-astra"
              ? makeBuiltInPolicy("gpt-6-astra")
              : policy;
          }),
        },
      }),
      [402],
    );
    const afterRejected = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.error.code).toBe("PRO_REQUIRED");
    expect(afterRejected.body.policies).toContainEqual(
      expect.objectContaining({
        model: "gpt-6-astra",
        defaultProviderType: "openai-api-key",
        modelProviderId: openAiProviderId,
      }),
    );
  });

  it("rejects adding a restricted built-in model to a seeded limited-free-1 workspace", async () => {
    const { stored } = await listSeededLimitedFreePolicies();

    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [...toUpdate(stored), makeBuiltInPolicy("gpt-5.6-sol")],
        },
      }),
      [402],
    );
    const afterRejected = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.error.code).toBe("PRO_REQUIRED");
    expect(
      afterRejected.body.policies.map((policy) => {
        return policy.model;
      }),
    ).not.toContain("gpt-5.6-sol");
  });

  it("allows compatible GPT 5.6 OpenAI org provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const openAiProviderId = await createOrgProvider(fixture, "openai-api-key");
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("gpt-5.6-sol"),
    ].map((policy) => {
      if (policy.model !== "gpt-5.6-sol") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "openai-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: openAiProviderId,
      };
    });

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );
    const sol = response.body.policies.find((policy) => {
      return policy.model === "gpt-5.6-sol";
    });

    expect(sol).toMatchObject({
      defaultProviderType: "openai-api-key",
      credentialScope: "org",
      modelProviderId: openAiProviderId,
      routeStatus: "valid",
    });
  });

  it("preserves an omitted custom gateway surface and clears an explicit null", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const gatewayClient = setupApp({
      context,
      routes: modelProviderGatewayRoutes,
    })(modelProviderConnectionsMainContract);
    const created = await accept(
      gatewayClient.create({
        headers: authHeaders(),
        body: {
          displayName: "Company Gateway",
          secret: "gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-5": "company-sonnet-production",
              },
            },
          ],
        },
      }),
      [201],
    );
    const surfaceId = created.body.surfaces[0]?.id;
    if (!surfaceId) {
      throw new Error("Expected custom gateway surface");
    }

    const client = apiClient();
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);
    const updates = [
      ...toUpdate(listed.body),
      makeBuiltInPolicy("claude-sonnet-5"),
    ].map((policy) => {
      return policy.model === "claude-sonnet-5"
        ? {
            ...policy,
            defaultProviderType: "custom-anthropic-messages" as const,
            credentialScope: "org" as const,
            modelProviderId: null,
            modelProviderSurfaceId: surfaceId,
          }
        : policy;
    });

    const updated = await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );
    const sonnet = updated.body.policies.find((policy) => {
      return policy.model === "claude-sonnet-5";
    });

    expect(sonnet).toMatchObject({
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
      routeStatus: "valid",
    });

    const previousClientPolicies: UpdateOrgModelPolicy[] =
      updated.body.policies.map((policy) => {
        return {
          model: policy.model,
          defaultProviderType: isBuiltInModelProviderType(
            policy.defaultProviderType,
          )
            ? "built-in"
            : policy.defaultProviderType,
          credentialScope: policy.credentialScope,
          modelProviderId: policy.modelProviderId,
        };
      });
    const roundTripped = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: previousClientPolicies,
        },
      }),
      [200],
    );
    expect(
      roundTripped.body.policies.find((policy) => {
        return policy.model === "claude-sonnet-5";
      }),
    ).toMatchObject({
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
      routeStatus: "valid",
    });

    const clearedPolicies = toUpdate(roundTripped.body).map((policy) => {
      return policy.model === "claude-sonnet-5"
        ? {
            ...policy,
            defaultProviderType: "built-in" as const,
            credentialScope: "org" as const,
            modelProviderId: null,
            modelProviderSurfaceId: null,
          }
        : policy;
    });
    const cleared = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: clearedPolicies,
        },
      }),
      [200],
    );
    expect(
      cleared.body.policies.find((policy) => {
        return policy.model === "claude-sonnet-5";
      }),
    ).toMatchObject({
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: null,
      routeStatus: "valid",
    });
  });

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "allows current GPT 5.6 %s provider routes",
    async (providerType) => {
      const fixture = await seedFixture();
      useSession(fixture);
      const providerId = await createOrgProvider(fixture, providerType);
      const client = apiClient();
      const listResponse = await accept(
        client.list({ headers: authHeaders() }),
        [200],
      );
      const updates = [
        ...toUpdate(listResponse.body),
        makeBuiltInPolicy("gpt-5.6-sol"),
      ].map((policy) => {
        if (policy.model !== "gpt-5.6-sol") {
          return policy;
        }
        return {
          ...policy,
          defaultProviderType: providerType,
          credentialScope: "org" as const,
          modelProviderId: providerId,
        };
      });

      const response = await accept(
        client.update({
          headers: authHeaders(),
          body: { revision: await currentPolicyRevision(), policies: updates },
        }),
        [200],
      );
      const policy = response.body.policies.find(({ model }) => {
        return model === "gpt-5.6-sol";
      });

      expect(policy).toMatchObject({
        defaultProviderType: providerType,
        credentialScope: "org",
        modelProviderId: providerId,
        routeStatus: "valid",
      });
    },
  );

  it("allows GPT 5.6 Codex OAuth member routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("gpt-5.6-sol"),
    ].map((policy) => {
      if (policy.model !== "gpt-5.6-sol") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "codex-oauth-token" as const,
        credentialScope: "member" as const,
        modelProviderId: null,
      };
    });

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );

    const sol = response.body.policies.find((policy) => {
      return policy.model === "gpt-5.6-sol";
    });
    expect(sol).toMatchObject({
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "valid",
    });
  });

  it("offers Fast but not Ultrafast on the direct OpenAI Astra route", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "pro",
      credits: 1_000_000,
    });
    const providerId = await createOrgProvider(fixture, "openai-api-key");
    await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            {
              model: "gpt-6-astra",
              defaultProviderType: "openai-api-key",
              credentialScope: "org",
              modelProviderId: providerId,
            },
          ],
        },
      }),
      [200],
    );
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    // Astra Ultrafast is temporarily disabled as catalog data: the seeded
    // direct OpenAI route no longer lists the ultrafast service tier.
    const ultrafast = await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-6-astra", serviceTier: "ultrafast" },
      }),
      [400],
    );
    expect(ultrafast.body).toMatchObject({
      error: { message: "Ultrafast is unavailable for this model route" },
    });
    const priority = await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-6-astra", serviceTier: "priority" },
      }),
      [200],
    );
    expect(priority.body).toMatchObject({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
  });

  it("stores priority with a GPT 5.6 user model preference", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    // The member projection is always present now, so the priority tier is
    // validated against the effective route rather than against a merely valid
    // organization route. A fresh workspace bootstraps onto limited-free-1,
    // whose plan restricts Built-in models, so give it a plan that admits the
    // route and a runtime route to resolve.
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "pro",
      credits: 1_000_000,
    });
    await seedBuiltInModelCandidateKeys(context, "gpt-5.6-sol");
    const client = apiClient();
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("gpt-5.6-sol"),
    ];
    await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );

    const priority = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-5.6-sol", serviceTier: "priority" },
      }),
      [200],
    );
    expect(priority.body).toMatchObject({
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    expect(
      (await accept(preferenceClient.get({ headers: authHeaders() }), [200]))
        .body.serviceTier,
    ).toBe("priority");
  });

  it("stores Fast for the effective personal route when the organization API provider is missing", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    const providerId = await createOrgProvider(fixture, "openai-api-key");
    await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            {
              model: "gpt-5.6-sol",
              defaultProviderType: "openai-api-key",
              credentialScope: "org",
              modelProviderId: providerId,
            },
          ],
        },
      }),
      [200],
    );
    const providers = createMiscRoutesApi(context);
    await providers.deleteOrgModelProvider(fixture, "openai-api-key", [204]);
    // Plan state is infrastructure-owned; subscriptions require a BYOK plan.
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });
    useSession(fixture);
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-5.6-sol", serviceTier: "priority" },
      }),
      [400],
    );

    await providers.upsertPersonalModelProvider(
      fixture,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({ accountId: randomUUID() }),
        },
      },
      [200, 201],
    );
    useSession(fixture);
    const projected = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(projected.body.policies).toContainEqual(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        defaultProviderType: "openai-api-key",
        routeStatus: "missing_provider",
        memberEffective: expect.objectContaining({
          providerType: "codex-oauth-token",
          availability: "available",
        }),
      }),
    );
    await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-5.6-sol", serviceTier: "priority" },
      }),
      [200],
    );
    const stored = await accept(
      preferences.get({ headers: authHeaders() }),
      [200],
    );
    expect(stored.body).toMatchObject({
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
  });

  it("stores, preserves, and clears a member image default", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    const stored = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: SEEDED_SYSTEM_DEFAULT_MODEL,
          serviceTier: null,
          selectedImageModel: "fal-ai/flux-pro/v1.1",
        },
      }),
      [200],
    );
    expect(stored.body).toMatchObject({
      selectedModel: SEEDED_SYSTEM_DEFAULT_MODEL,
      selectedImageModel: "fal-ai/flux-pro/v1.1",
    });
    expect(stored.body.updatedAt).not.toBeNull();

    const preserved = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    expect(preserved.body).toMatchObject({
      selectedModel: null,
      selectedImageModel: "fal-ai/flux-pro/v1.1",
    });

    const explicitlyCleared = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: null,
        },
      }),
      [200],
    );
    expect(explicitlyCleared.body.selectedImageModel).toBeNull();
  });

  it("pushes the image-default kind whenever the request carries the field", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: SEEDED_SYSTEM_DEFAULT_MODEL,
          serviceTier: null,
          selectedImageModel: "gpt-image-2",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel", "defaultImageModel"] },
    );

    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: null,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel", "defaultImageModel"] },
    );

    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel"] },
    );
  });

  it("stores an image default while the stored run model is outside the policy", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    // The seeded workspace policy is only the fixed default.
    await currentPolicyRevision();
    const removedModel = "gpt-6-luna";
    await setOrgMemberRunModelOutsidePolicyFixture({
      orgId: fixture.orgId,
      userId: fixture.userId,
      selectedModel: removedModel,
    });
    const stored = await accept(
      preferenceClient.get({ headers: authHeaders() }),
      [200],
    );
    expect(stored.body.selectedModel).toBe(removedModel);

    // Settings echoes the stored run preference with the new image model.
    const updated = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: stored.body.selectedModel,
          serviceTier: stored.body.serviceTier,
          selectedImageModel: "gpt-image-2",
        },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      selectedModel: removedModel,
      selectedImageModel: "gpt-image-2",
    });

    // Anything that changes the run preference is still admitted by policy.
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: removedModel,
          serviceTier: "priority",
          selectedImageModel: "gpt-image-1",
        },
      }),
      [400],
    );
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: removedModel,
          serviceTier: null,
          modelSettingsPatch: { model: removedModel, effort: "high" },
        },
      }),
      [400],
    );
    const unchanged = await accept(
      preferenceClient.get({ headers: authHeaders() }),
      [200],
    );
    expect(unchanged.body.selectedImageModel).toBe("gpt-image-2");
  });

  it("rejects an image default outside the selectable catalog", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const outsideCatalog = "not-an-image-model" as unknown as ImageModelId;

    const response = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: SEEDED_SYSTEM_DEFAULT_MODEL,
          serviceTier: null,
          selectedImageModel: outsideCatalog,
        },
      }),
      [400],
    );
    expect(response.status).toBe(400);
  });

  it("allows compatible member OAuth provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("claude-opus-5"),
    ].map((policy) => {
      if (policy.model !== "claude-opus-5") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "claude-code-oauth-token" as const,
        credentialScope: "member" as const,
        modelProviderId: null,
      };
    });

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: updates },
      }),
      [200],
    );
    const opus = response.body.policies.find((policy) => {
      return policy.model === "claude-opus-5";
    });

    expect(opus).toMatchObject({
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "valid",
    });
  });

  it("rejects workspace-scoped OAuth provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const providerId = await createOrgProvider(
      fixture,
      "claude-code-oauth-token",
    );
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("claude-opus-5"),
    ].map((policy) => {
      if (policy.model !== "claude-opus-5") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "claude-code-oauth-token" as const,
        credentialScope: "org" as const,
        modelProviderId: providerId,
      };
    });

    const response = await client.update({
      headers: authHeaders(),
      body: { revision: await currentPolicyRevision(), policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects incompatible provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const providerId = await createOrgProvider(fixture, "anthropic-api-key");
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body).filter((policy) => {
        return policy.model !== "deepseek-v4-flash";
      }),
      makeBuiltInPolicy("deepseek-v4-flash"),
    ].map((policy) => {
      if (policy.model !== "deepseek-v4-flash") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "anthropic-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: providerId,
      };
    });

    const response = await client.update({
      headers: authHeaders(),
      body: { revision: await currentPolicyRevision(), policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects org provider routes without a provider id", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeBuiltInPolicy("claude-opus-5"),
    ].map((policy) => {
      if (policy.model !== "claude-opus-5") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "anthropic-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: null,
      };
    });

    const response = await client.update({
      headers: authHeaders(),
      body: { revision: await currentPolicyRevision(), policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Org provider routes require a provider ID",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects duplicate model updates", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body);
    const duplicatedPolicy = makeBuiltInPolicy("gpt-6-luna");

    const response = await client.update({
      headers: authHeaders(),
      body: {
        revision: await currentPolicyRevision(),
        policies: [...updates, duplicatedPolicy, { ...duplicatedPolicy }],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: `Duplicate model "${duplicatedPolicy.model}"`,
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects update bodies that are not valid JSON", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await putRawModelPolicies("not-json");

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid JSON in request body",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects malformed update bodies", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await putRawModelPolicies("{}");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects removed model policy updates", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await putRawModelPolicies(
      JSON.stringify({
        revision: await currentPolicyRevision(),
        policies: [
          {
            model: "claude-haiku-4-5",
            defaultProviderType: "built-in",
            credentialScope: "org",
            modelProviderId: null,
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("accepts an empty list as the projected system default alone", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: { revision: await currentPolicyRevision(), policies: [] },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([SEEDED_SYSTEM_DEFAULT_MODEL]);
  });
});

test.each([
  { type: "azure-foundry", selectedModel: undefined },
  { type: "azure-foundry", selectedModel: "claude-opus-5" },
  {
    type: "azure-foundry",
    selectedModel: "https://private.example/deployment",
  },
  { type: "aws-bedrock", selectedModel: undefined },
  { type: "aws-bedrock", selectedModel: "anthropic.claude-opus-5-v1:0" },
  { type: "aws-bedrock", selectedModel: "deepseek-v4-flash" },
] as const)(
  "rejects an unmapped cloud $type $selectedModel through the public policy API",
  async ({ type, selectedModel }) => {
    const fixture = seedFixture();
    useSession(fixture);
    const { providerId } = await runsApi.createOrgModelProvider(fixture, {
      type,
      selectedModel,
      authMethod: "api-key",
      secrets:
        type === "azure-foundry"
          ? {
              ANTHROPIC_FOUNDRY_RESOURCE: "configured-resource",
              ANTHROPIC_FOUNDRY_API_KEY: "configured-key",
            }
          : {
              AWS_REGION: "us-east-1",
              AWS_BEARER_TOKEN_BEDROCK: "configured-bearer",
            },
    });
    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            {
              model: "claude-sonnet-5",
              defaultProviderType: type,
              credentialScope: "org",
              modelProviderId: providerId,
            },
          ],
        },
      }),
      [400],
    );
    expect(response.body.error.message).toContain(
      "explicit compatible saved deployment or profile",
    );
  },
);

describe("conditional organization model policy writes", () => {
  it("rejects missing and stale snapshots without erasing another admin's model or preference", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    // Full responses include live runtime routes. Retain each policy's keys so
    // another fixture's acquisition or cleanup cannot change either snapshot.
    for (const model of ["gpt-5.6-luna", "gpt-6-astra", "deepseek-v4-flash"]) {
      await seedBuiltInModelCandidateKeys(context, model);
    }
    await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          revision: await currentPolicyRevision(),
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy("gpt-5.6-luna"),
            makeBuiltInPolicy("gpt-6-astra"),
          ],
        },
      }),
      [200],
    );
    useSession(fixture);
    const first = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    const secondAdmin = authOrgApi.user({
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
    useSession({ ...secondAdmin, orgId: fixture.orgId });
    const second = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(second.body.revision).toBe(first.body.revision);
    const added = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          policies: [
            ...toUpdate(second.body),
            makeBuiltInPolicy("deepseek-v4-flash"),
          ],
          revision: second.body.revision,
        },
      }),
      [200],
    );
    const concurrentKey = await seedBuiltInModelCandidateKeys(
      context,
      "deepseek-v4-flash",
    );
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "deepseek-v4-flash", serviceTier: null },
      }),
      [200],
    );
    useSession(fixture);
    for (const revision of [undefined, first.body.revision]) {
      const rejected = await accept(
        apiClient().update({
          headers: authHeaders(),
          body: {
            policies: [
              makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
              makeBuiltInPolicy("gpt-6-astra"),
            ],
            revision,
          },
        }),
        [409],
      );
      expect(rejected.body.error.message).toContain("Refresh model settings");
    }
    const unchanged = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(unchanged.body.revision).toBe(added.body.revision);
    expect(unchanged.body.policies).toStrictEqual(added.body.policies);
    await concurrentKey.release();
    const afterKeyRelease = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(afterKeyRelease.body.policies).toStrictEqual(added.body.policies);
    useSession({ ...secondAdmin, orgId: fixture.orgId });
    const preference = await accept(
      preferences.get({ headers: authHeaders() }),
      [200],
    );
    expect(preference.body.selectedModel).toBe("deepseek-v4-flash");
    const edited = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: {
          policies: [
            makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
            makeBuiltInPolicy("gpt-5.6-luna"),
            makeBuiltInPolicy("deepseek-v4-flash"),
          ],
          revision: unchanged.body.revision,
        },
      }),
      [200],
    );
    expect(
      edited.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([
      SEEDED_SYSTEM_DEFAULT_MODEL,
      "gpt-5.6-luna",
      "deepseek-v4-flash",
    ]);
  });

  it.each([
    {
      model: "gpt-6-astra",
      addedModel: "gpt-5.6-sol",
      subscription: "codex-oauth-token",
      api: "openai-api-key",
    },
    {
      model: "claude-opus-5",
      addedModel: "claude-sonnet-5",
      subscription: "claude-code-oauth-token",
      api: "anthropic-api-key",
    },
  ] as const)(
    "adds and edits $subscription policies with the current revision without changing unrelated settings",
    async ({ model, addedModel, subscription, api }) => {
      const fixture = seedFixture();
      useSession(fixture);
      // Keep the built-in policy's live route stable across response snapshots.
      await seedBuiltInModelCandidateKeys(context, "gpt-5.6-luna");
      const providerId = await createOrgProvider(fixture, api);
      const initial = await accept(
        apiClient().update({
          headers: authHeaders(),
          body: {
            revision: await currentPolicyRevision(),
            policies: [
              makeBuiltInPolicy(SEEDED_SYSTEM_DEFAULT_MODEL),
              makeBuiltInPolicy("gpt-5.6-luna"),
              {
                ...makeBuiltInPolicy(model),
                defaultProviderType: api,
                modelProviderId: providerId,
              },
            ],
          },
        }),
        [200],
      );
      const preferences = setupApp({
        context,
        routes: userModelPreferenceRoutes,
      })(userModelPreferenceContract);
      await accept(
        preferences.update({
          headers: authHeaders(),
          body: { selectedModel: "gpt-5.6-luna", serviceTier: null },
        }),
        [200],
      );
      useSession(fixture);
      const read = await accept(
        apiClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(toUpdate(read.body)).toStrictEqual(toUpdate(initial.body));
      expect(read.body.writePreconditionRequired).toBeTruthy();
      const subscriptionPolicy = (
        selectedModel: typeof model | typeof addedModel,
      ): UpdateOrgModelPolicy => {
        return {
          ...makeBuiltInPolicy(selectedModel),
          defaultProviderType: subscription,
          credentialScope: "member",
          modelProviderSurfaceId: null,
        };
      };
      const requested = [
        ...toUpdate(read.body).map((policy) => {
          return policy.model === model ? subscriptionPolicy(model) : policy;
        }),
        subscriptionPolicy(addedModel),
      ];
      const saved = await accept(
        apiClient().update({
          headers: authHeaders(),
          body: { policies: requested, revision: read.body.revision },
        }),
        [200],
      );
      expect(toUpdate(saved.body)).toStrictEqual(
        expect.arrayContaining(requested),
      );
      expect(saved.body.policies).toHaveLength(requested.length);
      expect(
        saved.body.policies.find((policy) => {
          return policy.model === model;
        })?.id,
      ).toBe(
        initial.body.policies.find((policy) => {
          return policy.model === model;
        })?.id,
      );
      const edited = await accept(
        apiClient().update({
          headers: authHeaders(),
          body: {
            policies: toUpdate(saved.body).filter((policy) => {
              return policy.model !== addedModel;
            }),
            revision: saved.body.revision,
          },
        }),
        [200],
      );
      expect(
        edited.body.policies.find((policy) => {
          return policy.model === model;
        }),
      ).toMatchObject({
        defaultProviderType: subscription,
        credentialScope: "member",
      });
      const concurrentKey = await seedBuiltInModelCandidateKeys(
        context,
        "gpt-5.6-luna",
      );
      for (const revision of [undefined, saved.body.revision]) {
        await accept(
          apiClient().update({
            headers: authHeaders(),
            body: { policies: requested, revision },
          }),
          [409],
        );
      }
      const unchanged = await accept(
        apiClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(unchanged.body.policies).toStrictEqual(edited.body.policies);
      await concurrentKey.release();
      const afterKeyRelease = await accept(
        apiClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(afterKeyRelease.body.policies).toStrictEqual(edited.body.policies);
      const preference = await accept(
        preferences.get({ headers: authHeaders() }),
        [200],
      );
      expect(preference.body).toMatchObject({
        selectedModel: "gpt-5.6-luna",
        serviceTier: null,
      });
    },
  );
});
