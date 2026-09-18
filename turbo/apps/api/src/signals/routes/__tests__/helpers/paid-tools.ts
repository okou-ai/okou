import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { paidToolsRoutes } from "../../paid-tools";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

export async function setPaidToolDisabled(
  context: TestContext,
  actor: ApiTestUser,
  toolId: PaidToolId,
  disabled: boolean,
): Promise<void> {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  await accept(
    setupApp({ context, routes: paidToolsRoutes })(paidToolsContract).update({
      headers: { authorization: "Bearer clerk-session" },
      params: { toolId },
      body: { disabled },
    }),
    [200],
  );
}
