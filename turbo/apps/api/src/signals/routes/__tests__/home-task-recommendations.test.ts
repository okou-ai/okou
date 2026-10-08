import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { homeTaskRecommendationRoutes } from "../home-task-recommendations";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);

describe("GET /api/home-task-recommendations", () => {
  it("accepts a home touch without replacing the cold recommendation response", async () => {
    const actor = bdd.user();
    const { defaultAgentId: agentId } = await bdd.readOnboardingStatus(actor);
    if (!actor.orgId || !agentId) {
      throw new Error("Expected onboarding to create an organization Agent");
    }
    await bdd.completeOnboarding(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.HomeTaskRecommendations]: true },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            id: `orgmem_${actor.orgId}_${actor.userId}`,
            organization: { id: actor.orgId },
            publicUserData: { userId: actor.userId },
          },
        ],
      },
    );
    const client = setupApp({ context, routes: homeTaskRecommendationRoutes })(
      homeTaskRecommendationsContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const query = { agentId };
    const initial = await accept(client.list({ headers, query }), [200]);
    expect(initial.body).toMatchObject({
      status: "unavailable",
      recommendations: [],
    });
    await accept(client.touch({ headers, query }), [204]);
    const afterTouch = await accept(client.list({ headers, query }), [200]);
    expect(afterTouch.body).toStrictEqual(initial.body);
  });
});
