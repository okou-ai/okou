import { randomUUID } from "node:crypto";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { insertCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import {
  updateModelRouteCapabilitiesFixture,
  updateRestrictedPlanAccessFixture,
} from "../../../test-fixtures/model-route-capabilities";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { modelPoliciesRoutes } from "../model-policies";
import { userModelPreferenceRoutes } from "../user-model-preference";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function policiesApi() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

function preferencesApi() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}

async function signInUnrestrictedAdmin(): Promise<void> {
  await upsertOrgPlanEntitlementFixture({
    orgId: signInAdmin(),
    status: "active",
    supportByok: true,
    restrictedBuiltInModels: false,
  });
}

function signInAdmin(): string {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  return actor.orgId;
}

/** A catalog model on the OpenAI API-key protocol, defined only by rows. */
async function insertRouteModel(): Promise<string> {
  const model = `route-capabilities-${randomUUID()}`;
  const restore = await insertCatalogModelFixture({
    model,
    displayName: "Route Capabilities",
    sortOrder: 100_000,
    builtInRoutes: [
      {
        concreteProviderType: "openai-api-key",
        upstreamModel: "route-capabilities",
        priority: 0,
        efforts: ["low", "high"],
        defaultEffort: "high",
      },
    ],
  });
  onTestFinished(restore);
  await seedBuiltInModelCandidateKeys(context, model);
  return model;
}

function updateBuiltInPolicy(model: string, revision: string) {
  return policiesApi().update({
    headers: authHeaders(),
    body: {
      revision,
      policies: [
        {
          model,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ],
    },
  });
}

async function policiesRevision(): Promise<string> {
  return (await accept(policiesApi().list({ headers: authHeaders() }), [200]))
    .body.revision;
}

async function addBuiltInPolicy(model: string) {
  return await accept(
    updateBuiltInPolicy(model, await policiesRevision()),
    [200],
  );
}

describe("model route capabilities", () => {
  it.each(["gpt-5.6-luna", "gpt-6-luna"])(
    "rejects max and accepts xhigh for the seeded %s catalog routes",
    async (model) => {
      await signInUnrestrictedAdmin();
      await seedBuiltInModelCandidateKeys(context, model);
      await addBuiltInPolicy(model);
      await accept(
        preferencesApi().update({
          headers: authHeaders(),
          body: {
            selectedModel: model,
            serviceTier: null,
            modelSettingsPatch: { model, effort: "max" },
          },
        }),
        [400],
      );
      const saved = await accept(
        preferencesApi().update({
          headers: authHeaders(),
          body: {
            selectedModel: model,
            serviceTier: null,
            modelSettingsPatch: { model, effort: "xhigh" },
          },
        }),
        [200],
      );
      expect(saved.body.modelSettings).toStrictEqual({
        [model]: { effort: "xhigh" },
      });
    },
  );
  it("accepts the reasoning efforts the model's route lists", async () => {
    await signInUnrestrictedAdmin();
    const model = await insertRouteModel();
    await addBuiltInPolicy(model);

    const saved = await accept(
      preferencesApi().update({
        headers: authHeaders(),
        body: {
          selectedModel: model,
          serviceTier: null,
          modelSettingsPatch: { model, effort: "low" },
        },
      }),
      [200],
    );
    expect(saved.body.modelSettings).toStrictEqual({
      [model]: { effort: "low" },
    });

    await updateModelRouteCapabilitiesFixture({
      model,
      efforts: ["medium", "xhigh"],
      defaultEffort: "medium",
      serviceTiers: [],
    });
    await accept(
      preferencesApi().update({
        headers: authHeaders(),
        body: {
          selectedModel: model,
          serviceTier: null,
          modelSettingsPatch: { model, effort: "low" },
        },
      }),
      [400],
    );
    const updated = await accept(
      preferencesApi().update({
        headers: authHeaders(),
        body: {
          selectedModel: model,
          serviceTier: null,
          modelSettingsPatch: { model, effort: "xhigh" },
        },
      }),
      [200],
    );
    expect(updated.body.modelSettings).toStrictEqual({
      [model]: { effort: "xhigh" },
    });
  });

  it("offers Fast when the model's route lists the priority tier", async () => {
    await signInUnrestrictedAdmin();
    const model = await insertRouteModel();
    await addBuiltInPolicy(model);
    const selectFast = () => {
      return preferencesApi().update({
        headers: authHeaders(),
        body: { selectedModel: model, serviceTier: "priority" },
      });
    };
    await accept(selectFast(), [400]);

    await updateModelRouteCapabilitiesFixture({
      model,
      efforts: ["low", "high"],
      defaultEffort: "high",
      serviceTiers: ["priority"],
    });
    const fast = await accept(selectFast(), [200]);
    expect(fast.body.serviceTier).toBe("priority");
  });

  it("admits a model on a restricted plan when the catalog allows it", async () => {
    const orgId = signInAdmin();
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: true,
    });
    const model = await insertRouteModel();
    await accept(updateBuiltInPolicy(model, await policiesRevision()), [402]);

    onTestFinished(
      await updateRestrictedPlanAccessFixture({
        model,
        builtInOnRestrictedPlans: true,
      }),
    );
    const added = await addBuiltInPolicy(model);
    expect(
      added.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toContain(model);
  });
});
