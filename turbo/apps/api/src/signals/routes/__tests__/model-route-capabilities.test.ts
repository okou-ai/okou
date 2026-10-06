import { randomUUID } from "node:crypto";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { insertCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { insertSubscriptionRouteCapabilitiesFixture } from "../../../test-fixtures/subscription-route-capabilities";
import {
  updateModelRouteCapabilitiesFixture,
  updateRestrictedPlanAccessFixture,
} from "../../../test-fixtures/model-route-capabilities";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { userModelPreferenceRoutes } from "../user-model-preference";

const context = testContext();
const authOrgApi = createAuthOrgAgentsBddApi(context);
const { api, configureSubscriptionPiModel, sessionHeaders } =
  createChatEventsFixture(context);
function preferencesApi() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}
async function connectedActor() {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected organization member");
  }
  // Personal capabilities remain available on an active restricted/free plan.
  await upsertOrgPlanEntitlementFixture({
    orgId: actor.orgId,
    status: "active",
    supportByok: false,
    restrictedBuiltInModels: true,
  });
  await configureSubscriptionPiModel(actor);
  return actor;
}
async function insertSubscriptionModel() {
  const model = `subscription-capabilities-${randomUUID()}`;
  onTestFinished(await insertSubscriptionRouteCapabilitiesFixture(model));
  return model;
}

describe("personal model route capabilities", () => {
  it("rejects max and accepts xhigh for the connected Luna subscription", async () => {
    const actor = await connectedActor();
    const model = "gpt-6-luna";
    const update = (effort: "max" | "xhigh") => {
      return preferencesApi().update({
        headers: sessionHeaders(actor),
        body: {
          selectedModel: model,
          serviceTier: null,
          modelSettingsPatch: { model, effort },
        },
      });
    };
    await accept(update("max"), [400]);
    const saved = await accept(update("xhigh"), [200]);
    expect(saved.body.modelSettings).toStrictEqual({
      [model]: { effort: "xhigh" },
    });
  });

  it("accepts only the reasoning efforts the personal catalog route lists", async () => {
    const actor = await connectedActor();
    const model = await insertSubscriptionModel();
    const update = (effort: "low" | "xhigh") => {
      return preferencesApi().update({
        headers: sessionHeaders(actor),
        body: {
          selectedModel: model,
          serviceTier: null,
          modelSettingsPatch: { model, effort },
        },
      });
    };
    const saved = await accept(update("low"), [200]);
    expect(saved.body.modelSettings).toStrictEqual({
      [model]: { effort: "low" },
    });
    await updateModelRouteCapabilitiesFixture({
      model,
      efforts: ["medium", "xhigh"],
      defaultEffort: "medium",
      serviceTiers: [],
    });
    await accept(update("low"), [400]);
    const changed = await accept(update("xhigh"), [200]);
    expect(changed.body.modelSettings).toStrictEqual({
      [model]: { effort: "xhigh" },
    });
  });

  it("offers Fast only when the personal route lists the priority tier", async () => {
    const actor = await connectedActor();
    const model = await insertSubscriptionModel();
    const selectFast = () => {
      return preferencesApi().update({
        headers: sessionHeaders(actor),
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
    const saved = await accept(selectFast(), [200]);
    expect(saved.body.serviceTier).toBe("priority");
  });

  it("does not admit a catalog-only platform model when the catalog marks it free", async () => {
    const actor = authOrgApi.user();
    if (!actor.orgId) {
      throw new Error("Expected organization member");
    }
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: true,
    });
    const model = `retired-platform-${randomUUID()}`;
    onTestFinished(
      await insertCatalogModelFixture({
        model,
        displayName: "Retired platform candidate",
        sortOrder: 100_000,
        builtInRoutes: [
          {
            concreteProviderType: "openai-api-key",
            upstreamModel: "gpt-6-luna",
            priority: 0,
            efforts: ["low", "high"],
            defaultEffort: "high",
          },
        ],
      }),
    );
    const select = () => {
      return preferencesApi().update({
        headers: sessionHeaders(actor),
        body: { selectedModel: model, serviceTier: null },
      });
    };
    await accept(select(), [400]);
    onTestFinished(
      await updateRestrictedPlanAccessFixture({
        model,
        builtInOnRestrictedPlans: true,
      }),
    );
    await accept(select(), [400]);
    const models = await api.listRunModels(actor);
    expect(
      models.models.map((entry) => {
        return entry.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
  });
});
