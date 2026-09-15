import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { getStartedRoutes } from "../../get-started";
import { createRouteMocks } from "./route-test";

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
