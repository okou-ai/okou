import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import { pauseBriefForMembershipFailure } from "./helpers/morning-brief-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

describe("Morning Brief explicit installation", () => {
  it("keeps an existing brief paused when membership lookup returns 503", async () => {
    const fixture = await pauseBriefForMembershipFailure(context);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkTransportTestError(503),
    );
    const { actor } = fixture;
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await accept(
      setupApp({ context, routes: morningBriefPreferenceRoutes })(
        morningBriefPreferenceContract,
      ).retry({ headers: { authorization: "Bearer clerk-session" } }),
      [500],
    );
    await expect(fixture.readAutomations()).resolves.toMatchObject([
      {
        id: fixture.automationId,
        enabled: false,
        nextRunAt: null,
        official: {
          intendedEnabled: true,
          reconciliationStatus: "needs_reconfiguration",
        },
      },
    ]);
  });
});
