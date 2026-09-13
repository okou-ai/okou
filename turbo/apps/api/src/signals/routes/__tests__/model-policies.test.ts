import { randomUUID } from "node:crypto";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  DEFAULT_ORG_MODEL_POLICY_MODELS,
  LIMITED_FREE1_DEFAULT_RUN_MODEL,
  ACTIVE_RUN_MODELS,
  isBuiltInModelProviderType,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
  type ModelProviderWriteType,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelProviderConnectionsMainContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import type { VideoModelId } from "@okouai/api-contracts/contracts/video-models";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createApp } from "../../../app-factory";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { setOrgModelPolicyProviderTypeFixture } from "../../../test-fixtures/org-model-policies";
import {
  withBuiltInModelRuntimeRouteCandidateUnavailableForTest,
  withBuiltInModelRuntimeRouteUnavailableForTest,
} from "../../../test-fixtures/built-in-model-runtime-route";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createRouteMocks } from "./helpers/route-test";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { modelPoliciesRoutes } from "../model-policies";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { userModelPreferenceRoutes } from "../user-model-preference";

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
      isDefault: policy.isDefault,
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
  isDefault = false,
): UpdateOrgModelPolicy {
  return {
    model,
    isDefault,
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

describe("GET/PUT /api/model-policies", () => {
  it("keeps the successor usable after rejecting retired policy and preference writes", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    const client = apiClient();
    const existing = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const retired = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          policies: [
            ...toUpdate(existing.body),
            makeBuiltInPolicy("claude-fable-5"),
          ],
        },
      }),
      [400],
    );
    expect(retired.body.error.message).toBe(
      "Claude Fable 5 has been retired. Select Claude Fable 5.1.",
    );

    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const oldPreference = await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-fable-5", serviceTier: null },
      }),
      [400],
    );
    expect(oldPreference.body.error.message).toBe(retired.body.error.message);
    await accept(
      client.update({
        headers: authHeaders(),
        body: {
          policies: [
            ...toUpdate(existing.body),
            makeBuiltInPolicy("claude-fable-5-1"),
          ],
        },
      }),
      [200],
    );
    const successor = await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-fable-5-1", serviceTier: null },
      }),
      [200],
    );
    expect(successor.body.selectedModel).toBe("claude-fable-5-1");
  });

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

  it("returns the seeded workspace default model", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it("lists seeded curated models and the explicit default", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

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
    ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);
    expect(response.body.policies[0]).toMatchObject({
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
    });
    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
    expect(
      response.body.policies.find((policy) => {
        return policy.isDefault;
      })?.model,
    ).toBe(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL);
  });

  it("advertises the current built-in provider for route-specific effort controls", async () => {
    const fixture = seedFixture();
    useSession(fixture);
    const model = "deepseek-v4-flash";
    await seedBuiltInModelCandidateKeys(context, model);
    const client = apiClient();
    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: [makeBuiltInPolicy(model, true)] },
      }),
      [200],
    );
    expect(response.body.policies[0]?.runtimeProviderType).toBe("deepseek");
    // Operator-managed key availability/cooldowns have no user mutation API.
    // Scope the infrastructure state to this request without changing shared rows.
    const fallback =
      await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
        {
          selectedModel: model,
          providerType: "deepseek",
          upstreamModel: model,
        },
        async () => {
          return await accept(client.list({ headers: authHeaders() }), [200]);
        },
      );
    expect(fallback.body.policies[0]?.runtimeProviderType).toBe(
      "openrouter-codex",
    );
    const unavailable = await withBuiltInModelRuntimeRouteUnavailableForTest(
      model,
      async () => {
        return await accept(client.list({ headers: authHeaders() }), [200]);
      },
    );
    expect(unavailable.body.policies[0]?.runtimeProviderType).toBeNull();
  });

  it("preserves canonical built-in rows with legacy built-in route semantics", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    await accept(client.list({ headers: authHeaders() }), [200]);

    await setOrgModelPolicyProviderTypeFixture({
      orgId: fixture.orgId,
      model: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      defaultProviderType: "built-in",
    });

    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      response.body.policies.find((policy) => {
        return policy.isDefault;
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
    const updates = toUpdate(listed.body).map((policy) => {
      return policy.model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL
        ? {
            ...policy,
            defaultProviderType: "built-in" as const,
            modelProviderId: providerId,
          }
        : policy;
    });

    const response = await client.update({
      headers: authHeaders(),
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Built-in routes cannot store a provider ID",
        code: "BAD_REQUEST",
      },
    });
  });

  it("lists restricted policies for limited-free-1 workspace UI gating", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);

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
    ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);
    expect(response.body.workspaceDefaultModel).toBe(
      LIMITED_FREE1_DEFAULT_RUN_MODEL,
    );
    expect(
      response.body.policies.find((policy) => {
        return policy.isDefault;
      })?.model,
    ).toBe(LIMITED_FREE1_DEFAULT_RUN_MODEL);
  });

  it.each(["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.6-luna"] as const)(
    "keeps an existing %s default for limited-free-1 workspaces",
    async (previousDefaultModel) => {
      const fixture = seedFixture();
      useSession(fixture);
      const client = apiClient();
      await accept(
        client.update({
          headers: authHeaders(),
          body: {
            policies: [makeBuiltInPolicy(previousDefaultModel, true)],
          },
        }),
        [200],
      );

      await makeLimitedFreeWorkspace(fixture);
      useSession(fixture);
      const response = await accept(
        client.list({ headers: authHeaders() }),
        [200],
      );

      expect(response.body.workspaceDefaultModel).toBe(previousDefaultModel);
      expect(response.body.policies).toMatchObject([
        { model: previousDefaultModel, isDefault: true },
      ]);
    },
  );

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
    ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);
    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
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

    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it("requires admins for policy writes", async () => {
    const fixture = await seedFixture();
    useSession(fixture, "org:member");

    const response = await apiClient().update({
      headers: authHeaders(),
      body: { policies: [] },
    });

    expect(response.status).toBe(403);
    expect(response.body).toStrictEqual({
      error: {
        message: "Only admins can manage model policies",
        code: "FORBIDDEN",
      },
    });
  });

  it("updates the explicit workspace default", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body);

    updates[1] = { ...updates[1]!, isDefault: true };
    for (let index = 0; index < updates.length; index += 1) {
      if (index !== 1) {
        updates[index] = { ...updates[index]!, isDefault: false };
      }
    }

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
      }),
      [200],
    );

    const firstPolicy = response.body.policies.find((policy) => {
      return policy.model === DEFAULT_ORG_MODEL_POLICY_MODELS[0];
    });
    const secondPolicy = response.body.policies.find((policy) => {
      return policy.model === DEFAULT_ORG_MODEL_POLICY_MODELS[1];
    });
    expect(firstPolicy?.isDefault).toBeFalsy();
    expect(secondPolicy?.isDefault).toBeTruthy();
    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_MODELS[1],
    );
  });

  it("removes supported models omitted from an update", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const removedModel = DEFAULT_ORG_MODEL_POLICY_MODELS.find((model) => {
      return model !== DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    });
    if (!removedModel) {
      throw new Error("Default policy seed must include a non-default model");
    }
    const updates = toUpdate(listResponse.body).filter((policy) => {
      return policy.model !== removedModel;
    });

    const updateResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
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

  it("migrates member preferences from removed models to the workspace default", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const removedModel = DEFAULT_ORG_MODEL_POLICY_MODELS.find((model) => {
      return model !== DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    });
    if (!removedModel) {
      throw new Error("Default policy seed must include a non-default model");
    }
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: removedModel, serviceTier: null },
      }),
      [200],
    );

    const updates = toUpdate(listResponse.body).filter((policy) => {
      return policy.model !== removedModel;
    });
    await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
      }),
      [200],
    );

    const preferenceResponse = await accept(
      preferenceClient.get({ headers: authHeaders() }),
      [200],
    );
    expect(preferenceResponse.body.selectedModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
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
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const keptModel = DEFAULT_ORG_MODEL_POLICY_MODELS.find((model) => {
      return model !== DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    });
    const removedModel = DEFAULT_ORG_MODEL_POLICY_MODELS.find((model) => {
      return (
        model !== DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL && model !== keptModel
      );
    });
    if (!keptModel || !removedModel) {
      throw new Error(
        "Default policy seed must include two non-default models",
      );
    }
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: keptModel, serviceTier: null },
      }),
      [200],
    );

    const updates = toUpdate(listResponse.body).filter((policy) => {
      return policy.model !== removedModel;
    });
    await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
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
        body: { policies: updates },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(
      ACTIVE_RUN_MODELS.filter((model) => {
        return configuredModels.has(model);
      }),
    );
  });

  it("rejects restricted policy writes for limited-free-1 workspaces", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);

    const response = await apiClient().update({
      headers: authHeaders(),
      body: {
        policies: [
          makeBuiltInPolicy("deepseek-v4-pro", true),
          makeBuiltInPolicy("gpt-6-astra"),
        ],
      },
    });
    const afterRejected = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.status).toBe(402);
    expect(response.body).toStrictEqual({
      error: {
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    expect(afterRejected.body.workspaceDefaultModel).toBe(
      LIMITED_FREE1_DEFAULT_RUN_MODEL,
    );
    expect(
      afterRejected.body.policies
        .filter((policy) => {
          return policy.isDefault;
        })
        .map((policy) => {
          return policy.model;
        }),
    ).toStrictEqual([LIMITED_FREE1_DEFAULT_RUN_MODEL]);
  });

  it("rejects BYOK policy writes for limited-free-1 workspaces", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);
    const openRouterProviderId = await createOrgProvider(
      fixture,
      "openrouter-api-key",
    );
    const client = apiClient();

    const response = await client.update({
      headers: authHeaders(),
      body: {
        policies: [
          {
            ...makeBuiltInPolicy("claude-sonnet-5"),
            isDefault: true,
            defaultProviderType: "openrouter-api-key",
            credentialScope: "org",
            modelProviderId: openRouterProviderId,
          },
        ],
      },
    });

    expect(response.status).toBe(402);
    expect(response.body).toStrictEqual({
      error: {
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
  });

  it("keeps recently active GPT 5.5 and Claude Sonnet 4.6 selectable", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          policies: [
            ...toUpdate(listResponse.body),
            makeBuiltInPolicy("gpt-5.5"),
            makeBuiltInPolicy("claude-sonnet-4-6"),
          ],
        },
      }),
      [200],
    );

    expect(response.body.policies).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "gpt-5.5" }),
        expect.objectContaining({ model: "claude-sonnet-4-6" }),
      ]),
    );
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
        body: { policies: updates },
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
        body: { policies: updates },
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
          isDefault: policy.isDefault,
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
        body: { policies: previousClientPolicies },
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
        body: { policies: clearedPolicies },
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
          body: { policies: updates },
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
        body: { policies: updates },
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

  it.each([FeatureSwitchKey.CodexFastMode, FeatureSwitchKey.ModelPickerMenu])(
    "stores priority with a GPT 5.6 user model preference with %s",
    async (fastSwitch) => {
      const fixture = await seedFixture();
      useSession(fixture);
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
          body: { policies: updates },
        }),
        [200],
      );

      const switchOff = await accept(
        preferenceClient.update({
          headers: authHeaders(),
          body: { selectedModel: "gpt-5.6-sol", serviceTier: "priority" },
        }),
        [400],
      );
      expect(switchOff.body.error.message).toBe(
        "Codex fast mode is not enabled for this workspace",
      );

      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.CodexFastMode]: false,
        [fastSwitch]: true,
      });
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
    },
  );

  it("stores a member video default independent of the run model", async () => {
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
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
          selectedVideoModel: "fal-ai/veo3.1/fast",
        },
      }),
      [200],
    );
    expect(stored.body).toMatchObject({
      selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      selectedVideoModel: "fal-ai/veo3.1/fast",
    });

    // Clearing the run model must not take the video default with it.
    const cleared = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    expect(cleared.body).toMatchObject({
      selectedModel: null,
      selectedVideoModel: "fal-ai/veo3.1/fast",
    });

    const explicitlyCleared = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedVideoModel: null,
        },
      }),
      [200],
    );
    expect(explicitlyCleared.body.selectedVideoModel).toBeNull();
  });

  it("pushes the video-default kind only when the request carries the field", async () => {
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
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
          selectedVideoModel: "fal-ai/veo3.1/fast",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel", "defaultVideoModel"] },
    );

    // An older bundle sends only the run model, so the video kind stays out of
    // the payload and sessions that never asked for it are left alone.
    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel"] },
    );
  });

  it("keeps the stored video default when an older bundle omits it", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
          selectedVideoModel: "MiniMax-H3",
        },
      }),
      [200],
    );
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
        },
      }),
      [200],
    );

    expect(
      (await accept(preferenceClient.get({ headers: authHeaders() }), [200]))
        .body.selectedVideoModel,
    ).toBe("MiniMax-H3");
  });

  it("rejects a video default outside the catalog", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    // A run model id is never a video model id; the cast is what a client
    // sending a stale or hand-written id would produce at runtime.
    const outsideCatalog =
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL as unknown as VideoModelId;

    const response = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
          selectedVideoModel: outsideCatalog,
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: expect.stringMatching(/^selectedVideoModel: Invalid option:/),
        code: "BAD_REQUEST",
      },
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
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          serviceTier: null,
          selectedImageModel: "fal-ai/qwen-image",
        },
      }),
      [200],
    );
    expect(stored.body).toMatchObject({
      selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      selectedImageModel: "fal-ai/qwen-image",
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
      selectedImageModel: "fal-ai/qwen-image",
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
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
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

  it("rejects an image default outside the selectable catalog", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const outsideCatalog = "birefnet" as unknown as ImageModelId;

    const response = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
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
        body: { policies: updates },
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
      body: { policies: updates },
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
        return policy.model !== "deepseek-v4-pro";
      }),
      makeBuiltInPolicy("deepseek-v4-pro"),
    ].map((policy) => {
      if (policy.model !== "deepseek-v4-pro") {
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
      body: { policies: updates },
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
      body: { policies: updates },
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
    const duplicatedPolicy = updates[0]!;

    const response = await client.update({
      headers: authHeaders(),
      body: {
        policies: [
          duplicatedPolicy,
          { ...duplicatedPolicy, isDefault: false },
          ...updates.slice(1),
        ],
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

  it("rejects updates without exactly one default model", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      return { ...policy, isDefault: false };
    });

    const response = await client.update({
      headers: authHeaders(),
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Request must include exactly one default model",
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
        policies: [
          {
            model: "claude-haiku-4-5",
            isDefault: true,
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

  it("rejects incomplete update payloads", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await apiClient().update({
      headers: authHeaders(),
      body: { policies: [] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Request must include at least one model",
        code: "BAD_REQUEST",
      },
    });
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
  { type: "aws-bedrock", selectedModel: "deepseek-v4-pro" },
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
          policies: [
            {
              model: "claude-sonnet-4-6",
              isDefault: true,
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
