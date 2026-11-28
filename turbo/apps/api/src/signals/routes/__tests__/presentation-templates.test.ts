import { createBddApi } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import { expect, test } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { presentationTemplatesRoutes } from "../presentation-templates";

const context = testContext();
const bdd = createBddApi(context);

test("presentation-templates-001 lists an empty personal template collection", async () => {
  const member = bdd.user({ orgRole: "org:member" });
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.orgRole,
  );
  const response = await accept(
    setupApp({ context, routes: presentationTemplatesRoutes })(
      presentationTemplatesContract,
    ).list({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  expect(response.body).toStrictEqual([]);
});
