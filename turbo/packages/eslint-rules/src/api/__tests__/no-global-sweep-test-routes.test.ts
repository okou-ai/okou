import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noGlobalSweepTestRoutes } from "../rules/no-global-sweep-test-routes.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const harness =
  "/app/src/signals/routes/__tests__/global-sweep-contracts.test.ts";
const behaviorTest =
  "/app/src/signals/routes/__tests__/stripe-automation-events.test.ts";

const helperImport = `
  import { expectGlobalSweepMissingAuth } from "./helpers/global-sweep-contract";
`;
const routeImport = `
  import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
`;

ruleTester.run("no-global-sweep-test-routes", noGlobalSweepTestRoutes, {
  valid: [
    {
      name: "isolated Official system coverage uses the canonical automation cron",
      filename: "/app/src/signals/routes/__tests__/official-workflows.test.ts",
      code: `${routeImport}
        setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes });
      `,
    },
    {
      name: "production bootstrap keeps global behavior",
      filename: "/app/src/signals/route.ts",
      code: `${routeImport}
        export const ROUTES = [...cronExecuteWorkflowAutomationsRoutes];
      `,
    },
    {
      name: "contract harness passes the route directly to the fixed no-auth helper",
      filename: harness,
      code: `${routeImport}${helperImport}
        await expectGlobalSweepMissingAuth(
          context,
          cronExecuteWorkflowAutomationsRoutes,
          "/api/cron/execute-workflow-automations",
        );
      `,
    },
    {
      name: "contract harness admits the fixed wrong-auth helper",
      filename: harness,
      code: `${routeImport}
        import { expectGlobalSweepWrongAuth } from "./helpers/global-sweep-contract";
        await expectGlobalSweepWrongAuth(
          context,
          cronExecuteWorkflowAutomationsRoutes,
          "/api/cron/execute-workflow-automations",
        );
      `,
    },
    {
      name: "ordinary automation requests use their production route slice",
      filename: behaviorTest,
      code: `
        import { workflowAutomationsRoutes } from "../workflow-automations";
        setupApp({ context, routes: workflowAutomationsRoutes });
      `,
    },
    {
      name: "ordinary user routes stay valid",
      filename: behaviorTest,
      code: `
        import { computerUseRoutes } from "../computer-use";
        setupApp({ routes: computerUseRoutes });
      `,
    },
    {
      name: "aggregate route member projection may remain metadata only",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        const options = { routes: ROUTES };
        expect(options.routes).toHaveLength(42);
      `,
    },
    {
      name: "aggregate route destructuring may remain metadata only",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        const options = { routes: ROUTES };
        const { routes } = options;
        expect(routes.map(({ route }) => route.method)).toContain("GET");
      `,
    },
    {
      name: "a later scoped route property overrides aggregate options",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        import { workflowAutomationsRoutes } from "../workflow-automations";
        const aggregateOptions = { signal, routes: ROUTES };
        createApp({
          ...aggregateOptions,
          routes: workflowAutomationsRoutes,
        });
      `,
    },
    {
      name: "an explicit scoped factory property overrides a canonical default",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        const buildScopedApp = (options) => options;
        function mount({ createApp: build = appFactory.createApp }) {
          return build({ routes: ROUTES });
        }
        mount({ createApp: buildScopedApp });
      `,
    },
  ],
  invalid: [
    {
      name: "Official system coverage cannot import an unrelated global sweep",
      filename: "/app/src/signals/routes/__tests__/official-workflows.test.ts",
      code: `import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "Official system coverage cannot alias the approved route",
      filename: "/app/src/signals/routes/__tests__/official-workflows.test.ts",
      code: `import { cronExecuteWorkflowAutomationsRoutes as sweep } from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "defaulted shorthand route destructuring remains rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        import { workflowAutomationsRoutes } from "../workflow-automations";
        const options = { routes: ROUTES };
        const { routes = workflowAutomationsRoutes } = options;
        createApp({ routes });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "defaulted renamed route destructuring remains rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        import { workflowAutomationsRoutes } from "../workflow-automations";
        const options = { routes: ROUTES };
        const { routes: mountedRoutes = workflowAutomationsRoutes } = options;
        setupApp({ routes: mountedRoutes })(contract);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "destructured helper route parameters remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        function mount({ routes }) {
          return createApp({ routes });
        }
        mount({ routes: ROUTES });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "defaulted destructured helper parameters remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        import { workflowAutomationsRoutes } from "../workflow-automations";
        function mountWithDefault(
          { routes } = { routes: workflowAutomationsRoutes },
        ) {
          return createApp({ routes });
        }
        mountWithDefault({ routes: ROUTES });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "canonical namespace app factory members remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        appFactory.createApp({ routes: ROUTES });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "canonical namespace app factory destructuring remains rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        const { createApp: mountFactory } = appFactory;
        mountFactory({ routes: ROUTES });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "canonical app factory namespaces cannot flow through helper parameters",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount(factory) {
          return factory.createApp({ routes: ROUTES });
        }
        mount(appFactory);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "destructured canonical app factories cannot flow through helper parameters",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount({ createApp: build }) {
          return build({ routes: ROUTES });
        }
        mount(appFactory);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "canonical factory options cannot flow through plain helper parameters",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount({ createApp: build }) {
          return build({ routes: ROUTES });
        }
        function forward(options) {
          return mount(options);
        }
        forward({ createApp: appFactory.createApp });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "wrapped canonical namespaces cannot flow through object helper parameters",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount(factory) {
          return factory.createApp({ routes: ROUTES });
        }
        function forward({ factory }) {
          return mount(factory);
        }
        forward({ factory: appFactory });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "explicit undefined activates canonical factory property defaults",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount({ createApp: build = appFactory.createApp }) {
          return build({ routes: ROUTES });
        }
        mount({ createApp: undefined });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "canonical namespaces survive nested parameter member projections",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount(factory) {
          return factory.createApp({ routes: ROUTES });
        }
        function forward({ options }) {
          return mount(options.factory);
        }
        forward({ options: { factory: appFactory } });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "explicit undefined activates canonical plain parameter defaults",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount(build = appFactory.createApp) {
          return build({ routes: ROUTES });
        }
        mount(undefined);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "explicit undefined activates canonical object parameter defaults",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        function mount(
          { createApp: build } = { createApp: appFactory.createApp },
        ) {
          return build({ routes: ROUTES });
        }
        mount(undefined);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aliased undefined activates canonical plain parameter defaults",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        const absent = undefined;
        function mount(build = appFactory.createApp) {
          return build({ routes: ROUTES });
        }
        mount(absent);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aliased void activates canonical object parameter defaults",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        const absent = void 0;
        function mount(
          { createApp: build } = { createApp: appFactory.createApp },
        ) {
          return build({ routes: ROUTES });
        }
        mount(absent);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "later undefined spreads activate canonical property defaults",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import * as appFactory from "../../../app-factory";
        const absent = { createApp: undefined };
        const scopedFactory = (options) => options;
        function mount({ createApp: build = appFactory.createApp }) {
          return build({ routes: ROUTES });
        }
        mount({ createApp: scopedFactory, ...absent });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate routes cannot flow through a local member projection",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        const options = { routes: ROUTES };
        createApp({ signal, routes: options.routes });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate routes cannot flow through local object destructuring",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        const options = { routes: ROUTES };
        const { routes } = options;
        setupApp({ context, routes })(contract);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate contract binder aliases remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        const bindContract = setupApp({ context, routes: ROUTES });
        const client = bindContract(contract);
        await client.execute({
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate app options aliases remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        const options = { signal, routes: ROUTES };
        const app = createApp(options);
        await app.request("/api/cron/execute-workflow-automations", {
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate production routes cannot become a ts-rest behavior client",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        const client = setupApp({ context, routes: ROUTES })(contract);
        await client.execute({
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate production routes cannot become a behavior-test sweep",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        const aggregateRoutes = ROUTES;
        const app = createApp({ signal, routes: aggregateRoutes });
        await app.request("/api/cron/execute-workflow-automations", {
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "old behavior helper cannot wrap the production-global sweep",
      filename: behaviorTest,
      code: `${routeImport}
        import { createApp } from "../../../app-factory";
        async function executeCron() {
          return await createApp({
            signal,
            routes: cronExecuteWorkflowAutomationsRoutes,
          }).request("/api/cron/execute-workflow-automations", {
            headers: { authorization: "Bearer test-cron-secret" },
          });
        }
        await executeCron();
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot rename a global route import",
      filename: harness,
      code: `
        import { cronExecuteWorkflowAutomationsRoutes as sweep } from "../cron-execute-workflow-automations";
        ${helperImport}
        await expectGlobalSweepMissingAuth(context, sweep, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot alias a route locally",
      filename: harness,
      code: `${routeImport}${helperImport}
        const sweep = cronExecuteWorkflowAutomationsRoutes;
        await expectGlobalSweepMissingAuth(context, sweep, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot put a route in a local array",
      filename: harness,
      code: `${routeImport}${helperImport}
        const routes = [...cronExecuteWorkflowAutomationsRoutes];
        await expectGlobalSweepMissingAuth(context, routes, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot pass a route through a local wrapper",
      filename: harness,
      code: `${routeImport}${helperImport}
        async function check(routes) {
          await expectGlobalSweepMissingAuth(context, routes, "/api/cron/execute-workflow-automations");
        }
        await check(cronExecuteWorkflowAutomationsRoutes);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot re-export a global route",
      filename: harness,
      code: `export { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot star re-export a global route module",
      filename: harness,
      code: `export * from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot mount a route with createApp",
      filename: harness,
      code: `${routeImport}
        import { createApp } from "../../../app-factory";
        await createApp({ signal, routes: cronExecuteWorkflowAutomationsRoutes })
          .request("/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot mount a route with setupApp",
      filename: harness,
      code: `${routeImport}
        await setupApp({
          context,
          routes: cronExecuteWorkflowAutomationsRoutes,
        })(cronExecuteWorkflowAutomationsContract).execute({
          headers: {},
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot make an authorized behavior call",
      filename: harness,
      code: `${routeImport}${helperImport}
        import { createApp } from "../../../app-factory";
        const response = await createApp({
          signal,
          routes: cronExecuteWorkflowAutomationsRoutes,
        }).request("/api/cron/execute-workflow-automations", {
          headers: { authorization: "Bearer test-cron-secret" },
        });
        expect(response.status).toBe(200);
        await expectGlobalSweepMissingAuth(context, cronExecuteWorkflowAutomationsRoutes, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "namespace import cannot hide the sweep",
      filename: behaviorTest,
      code: `import * as cron from "../cron-execute-workflow-automations"; cron.cronExecuteWorkflowAutomationsRoutes;`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "dynamic import cannot hide the sweep",
      filename: behaviorTest,
      code: `await import("../cron-execute-workflow-automations");`,
      errors: [{ messageId: "globalSweep" }],
    },
  ],
});
