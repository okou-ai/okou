import { RuleTester } from "@typescript-eslint/rule-tester";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { noTestOnlyRoutes } from "../rules/no-test-only-routes.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();

const routeTest = join(
  process.cwd(),
  "src/signals/routes/__tests__/agents.test.ts",
);
const productionRoute = join(process.cwd(), "src/signals/routes/agents.ts");
const testRouteModule = join(
  process.cwd(),
  "src/signals/routes/test-runtime-state.ts",
);
const contract = join(process.cwd(), "src/contracts/agents.ts");

tester.run("no-test-only-routes", noTestOnlyRoutes, {
  valid: [
    {
      filename: productionRoute,
      code: 'const path = "/api/agents"; const route = { route: c.list, handler: list$ };',
    },
    {
      filename: join(
        process.cwd(),
        "src/signals/routes/__tests__/test-teams-state.test.ts",
      ),
      code: "const app = setupApp({ context, routes: teamsRoutes });",
    },
    {
      filename: routeTest,
      code: 'const origin = "http://api.test/api/agents"; const latest = "/api/testing-tools";',
    },
    {
      filename: routeTest,
      code: 'log.error("failed", { route: "/api/test/:id" });',
    },
  ],
  invalid: [
    {
      filename: testRouteModule,
      code: "export const testRoutes = [];",
      errors: [{ messageId: "testRouteModule" }],
    },
    {
      filename: join(process.cwd(), "src/signals/routes/test-runtime/index.ts"),
      code: "export const testRoutes = [];",
      errors: [{ messageId: "testRouteModule" }],
    },
    {
      filename: contract,
      code: 'const route = { method: "POST", path: "/api/test/runtime-state/action" };',
      errors: [{ messageId: "testApiPath" }],
    },
    {
      filename: productionRoute,
      code: "const path = `/api/test/${name}`;",
      errors: [{ messageId: "testApiPath" }],
    },
    {
      filename: routeTest,
      code: "setupApp({ context, routes: [{ route: probe.get, handler: probe$ }] });",
      errors: [{ messageId: "testRegistration" }],
    },
    {
      filename: routeTest,
      code: 'const contract = c.router({ probe: { method: "GET", path: "/api/test/probe" } });',
      errors: [{ messageId: "testApiPath" }],
    },
  ],
});
