import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { userModelPreferenceRoutes } from "../user-model-preference";

const context = testContext();
const authOrgApi = createAuthOrgAgentsBddApi(context);
const { api, bdd, configureSubscriptionPiModel, sessionHeaders } =
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
  authOrgApi.acceptAgentStorageWrites();
  await bdd.readOnboardingStatus(actor);
  await bdd.completeOnboarding(actor);
  await expect(api.readBillingStatus(actor)).resolves.toMatchObject({
    tier: "limited-free-1",
    status: "active",
  });
  await configureSubscriptionPiModel(actor);
  return actor;
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

  it("offers Fast only for a connected model whose route supports priority", async () => {
    const actor = await connectedActor();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const selectFast = (model: string) => {
      return preferencesApi().update({
        headers: sessionHeaders(actor),
        body: { selectedModel: model, serviceTier: "priority" },
      });
    };
    await accept(selectFast("claude-fable-5-1"), [400]);
    const saved = await accept(selectFast("gpt-6-astra"), [200]);
    expect(saved.body.serviceTier).toBe("priority");
  });
});
