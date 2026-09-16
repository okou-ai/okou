import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { getStartedRoutes } from "../../get-started";
import { createRouteMocks } from "./route-test";
import { updateFeatureSwitchesForUser } from "./feature-switches";

export async function setGetStartedEnabled(
  context: TestContext,
  actor: {
    readonly userId: string;
    readonly orgId: string | null;
    readonly orgRole?: "org:admin" | "org:member";
  },
  enabled = true,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected reward organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.GetStartedQuests]: enabled },
  );
}

export async function readGetStartedStatus(
  context: TestContext,
  actor: { readonly userId: string; readonly orgId: string | null },
) {
  if (!actor.orgId) {
    throw new Error("Expected reward organization");
  }
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return (
    await accept(
      setupApp({ context, routes: getStartedRoutes })(
        getStartedContract,
      ).status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    )
  ).body;
}
