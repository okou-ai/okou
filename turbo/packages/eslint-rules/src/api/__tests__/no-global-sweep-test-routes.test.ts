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
const sandboxCleanupImport =
  'import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";';
const computerUseRetention =
  "/repo/turbo/apps/api/src/signals/routes/__tests__/computer-use-retention.test.ts";
const computerUseCleanupImport =
  'import { cronComputerUseScreenshotCleanupRoutes } from "../cron-computer-use-screenshot-cleanup";';

const helperImport = `
  import { expectGlobalSweepMissingAuth } from "./helpers/global-sweep-contract";
`;
const routeImport = `
  import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
`;

const stripeDueOperator =
  "/repo/turbo/apps/api/src/signals/routes/__tests__/stripe-automation-events.test.ts";
const stripeDueTitle =
  "skips a queued Stripe delivery after its owner disables the automation";
const stripeDueImports = `${routeImport}
  import { it } from "vitest";
  import { setupApp } from "../../../__tests__/test-helpers";
  import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
`;
const stripeDueMount = `const cron = (await setupApp({
  context,
  routes: cronExecuteWorkflowAutomationsRoutes,
  isolatePg: true,
}))(cronExecuteWorkflowAutomationsContract);`;
const stripeDueCase = `${stripeDueImports}
  it("${stripeDueTitle}", async () => {
    ${stripeDueMount}
    await cron.execute({ headers: { authorization: "Bearer test-cron-secret" } });
  });
`;

ruleTester.run("no-global-sweep-test-routes", noGlobalSweepTestRoutes, {
  valid: [
    {
      name: "the registered Stripe operator case directly awaits its isolated canonical client",
      filename: stripeDueOperator,
      code: stripeDueCase,
    },
    {
      name: "the isolated Computer Use retention suite mounts its real operator",
      filename: computerUseRetention,
      code: `${computerUseCleanupImport}
        import { setupApp } from "../../../__tests__/test-helpers";
        setupApp({ context, routes: cronComputerUseScreenshotCleanupRoutes, isolatePg: true })(contract);
      `,
    },
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
      name: "another case in the actual Stripe file stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "skips a queued Stripe delivery after its owner disables the automation",
        "ordinary Stripe behavior",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a same-basename file outside the full API path stays rejected",
      filename: behaviorTest,
      code: stripeDueCase,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "duplicate registered case declarations stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase + `it("${stripeDueTitle}", async () => {});`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an unused registered route import stays rejected",
      filename: stripeDueOperator,
      code: `${stripeDueImports} it("${stripeDueTitle}", async () => {});`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a permitted mount cannot shelter a second route use",
      filename: stripeDueOperator,
      code:
        stripeDueCase + "const alias = cronExecuteWorkflowAutomationsRoutes;",
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "two mounts in the same registered callback stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        stripeDueMount,
        stripeDueMount + stripeDueMount.replace("const cron", "const second"),
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an aliased Stripe route import stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace(
          "{ cronExecuteWorkflowAutomationsRoutes }",
          "{ cronExecuteWorkflowAutomationsRoutes as sweep }",
        )
        .replace(
          "routes: cronExecuteWorkflowAutomationsRoutes",
          "routes: sweep",
        ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a locally aliased route stays rejected",
      filename: stripeDueOperator,
      code:
        stripeDueCase.replace(
          "routes: cronExecuteWorkflowAutomationsRoutes",
          "routes: sweep",
        ) + "const sweep = cronExecuteWorkflowAutomationsRoutes;",
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a namespace Stripe route import stays rejected",
      filename: stripeDueOperator,
      code: `import * as cron from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a default Stripe route import stays rejected",
      filename: stripeDueOperator,
      code: `import cron from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a dynamic Stripe route import stays rejected",
      filename: stripeDueOperator,
      code: `await import("../cron-execute-workflow-automations");`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a named Stripe route re-export stays rejected",
      filename: stripeDueOperator,
      code: `export { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a star Stripe route re-export stays rejected",
      filename: stripeDueOperator,
      code: `export * from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a type-only Stripe route import stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "import { cronExecuteWorkflowAutomationsRoutes }",
        "import type { cronExecuteWorkflowAutomationsRoutes }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a type-only Stripe route specifier stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "{ cronExecuteWorkflowAutomationsRoutes }",
        "{ type cronExecuteWorkflowAutomationsRoutes }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "the matching route export from a different module stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        '"../cron-execute-workflow-automations"',
        '"unrelated/cron-execute-workflow-automations"',
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "the Stripe registration does not admit an unrelated operator",
      filename: stripeDueOperator,
      code: stripeDueCase + sandboxCleanupImport,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a private setupApp import stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        '"../../../__tests__/test-helpers"',
        '"./private-driver"',
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a local function named setupApp stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        'import { setupApp } from "../../../__tests__/test-helpers";',
        "function setupApp(options) { return options; }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a setupApp import alias stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace("import { setupApp }", "import { setupApp as build }")
        .replace("await setupApp(", "await build("),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a local setupApp alias stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "const cron = (await setupApp",
        "const build = setupApp; const cron = (await build",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a namespace setupApp member stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace(
          'import { setupApp } from "../../../__tests__/test-helpers";',
          'import * as factory from "../../../__tests__/test-helpers";',
        )
        .replace("await setupApp(", "await factory.setupApp("),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "createApp cannot replace the registered mount",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace(
          'import { setupApp } from "../../../__tests__/test-helpers";',
          'import { createApp } from "../../../app-factory";',
        )
        .replace("await setupApp(", "await createApp("),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a route array stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "routes: cronExecuteWorkflowAutomationsRoutes",
        "routes: [cronExecuteWorkflowAutomationsRoutes]",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "passing the route to a wrapper stays rejected",
      filename: stripeDueOperator,
      code: `${stripeDueImports} function mount(routes) { return setupApp({ context, routes, isolatePg: true }); } it("${stripeDueTitle}", async () => { const cron = (await mount(cronExecuteWorkflowAutomationsRoutes))(cronExecuteWorkflowAutomationsContract); });`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "production aggregate routes stay rejected at the actual Stripe path",
      filename: stripeDueOperator,
      code: `import { ROUTES } from "../../route"; import { setupApp } from "../../../__tests__/test-helpers"; setupApp({ context, routes: ROUTES, isolatePg: true });`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "missing Stripe isolation stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("isolatePg: true,", ""),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "false Stripe isolation stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("isolatePg: true", "isolatePg: false"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "variable Stripe isolation stays rejected",
      filename: stripeDueOperator,
      code:
        "const isolated = true;" +
        stripeDueCase.replace("isolatePg: true", "isolatePg: isolated"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a later spread cannot override Stripe isolation",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "isolatePg: true,",
        "isolatePg: true, ...options,",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "duplicate Stripe isolation keys stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "isolatePg: true,",
        "isolatePg: true, isolatePg: false,",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "duplicate context keys stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("context,", "context, context,"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "extra setup options stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("context,", "context, signal,"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "computed route keys stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "routes: cronExecuteWorkflowAutomationsRoutes",
        '["routes"]: cronExecuteWorkflowAutomationsRoutes',
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "route getters stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "routes: cronExecuteWorkflowAutomationsRoutes",
        "get routes() { return cronExecuteWorkflowAutomationsRoutes; }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "route methods stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "routes: cronExecuteWorkflowAutomationsRoutes",
        "routes() { return cronExecuteWorkflowAutomationsRoutes; }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an inline fake context object stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("context,", "context: {},"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an unawaited Stripe mount stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("await setupApp", "setupApp"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a stored setup binder stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        stripeDueMount,
        `const bind = await setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes, isolatePg: true }); const cron = bind(cronExecuteWorkflowAutomationsContract);`,
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a stored setup promise stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        stripeDueMount,
        `const pending = setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes, isolatePg: true }); const cron = (await pending)(cronExecuteWorkflowAutomationsContract);`,
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a wrong contract module stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        '"@okouai/api-contracts/contracts/cron"',
        '"./private-contract"',
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an aliased contract import stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace(
          "{ cronExecuteWorkflowAutomationsContract }",
          "{ cronExecuteWorkflowAutomationsContract as contract }",
        )
        .replace(")(cronExecuteWorkflowAutomationsContract);", ")(contract);"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a type-only contract stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        "import { cronExecuteWorkflowAutomationsContract }",
        "import type { cronExecuteWorkflowAutomationsContract }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a local fake contract stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        'import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";',
        "const cronExecuteWorkflowAutomationsContract = {};",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a top-level isolated mount stays rejected",
      filename: stripeDueOperator,
      code: `${stripeDueImports}${stripeDueMount}`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a beforeEach mount stays rejected",
      filename: stripeDueOperator,
      code: `${stripeDueImports} import { beforeEach } from "vitest"; beforeEach(async () => { ${stripeDueMount} });`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a nested callback mount stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        stripeDueMount,
        `await (async () => { ${stripeDueMount} })();`,
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a conditional mount stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        stripeDueMount,
        `if (enabled) { ${stripeDueMount} }`,
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a block-nested mount stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(stripeDueMount, `{ ${stripeDueMount} }`),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a mutable client binding stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("const cron =", "let cron ="),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "multiple client declarators stay rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        ")(cronExecuteWorkflowAutomationsContract);",
        ")(cronExecuteWorkflowAutomationsContract), other = 1;",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a fake local it function stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        'import { it } from "vitest";',
        "function it(title, callback) { return callback; }",
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an it import from the wrong module stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace(
        'import { it } from "vitest";',
        'import { it } from "./test-driver";',
      ),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "an it import alias stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace("import { it }", "import { it as test }")
        .replace('it("', 'test("'),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "it.only does not authorize the registered case",
      filename: stripeDueOperator,
      code: stripeDueCase.replace('it("', 'it.only("'),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "it.skip does not authorize the registered case",
      filename: stripeDueOperator,
      code: stripeDueCase.replace('it("', 'it.skip("'),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "it.each does not authorize the registered case",
      filename: stripeDueOperator,
      code: stripeDueCase.replace('it("', 'it.each([1])("'),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a nonasync callback stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase
        .replace("async () =>", "() =>")
        .replaceAll("await ", ""),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a third test argument stays rejected",
      filename: stripeDueOperator,
      code: stripeDueCase.replace("  });", "  }, 1000);"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a computed case title stays rejected",
      filename: stripeDueOperator,
      code:
        `const caseTitle = "${stripeDueTitle}";` +
        stripeDueCase.replace(`"${stripeDueTitle}"`, "caseTitle"),
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a permitted case cannot shelter another titled modifier call",
      filename: stripeDueOperator,
      code: stripeDueCase + `it.skip("${stripeDueTitle}", async () => {});`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "retention coverage must explicitly isolate its database",
      filename: computerUseRetention,
      code: `${computerUseCleanupImport}
        import { setupApp } from "../../../__tests__/test-helpers";
        setupApp({ context, routes: cronComputerUseScreenshotCleanupRoutes });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "retention coverage cannot override isolation through a spread",
      filename: computerUseRetention,
      code: `${computerUseCleanupImport}
        import { setupApp } from "../../../__tests__/test-helpers";
        setupApp({ context, routes: cronComputerUseScreenshotCleanupRoutes, isolatePg: true, ...options });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "ordinary coverage cannot use the Computer Use retention operator",
      filename: behaviorTest,
      code: computerUseCleanupImport,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "retention coverage cannot import an unrelated global operator",
      filename: computerUseRetention,
      code: sandboxCleanupImport,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "retention coverage cannot use a private operator driver",
      filename: computerUseRetention,
      code: `${computerUseCleanupImport}
        import { setupApp } from "./private-driver";
        setupApp({ routes: cronComputerUseScreenshotCleanupRoutes });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "a behavior suite cannot import sandbox cleanup",
      filename: behaviorTest,
      code: sandboxCleanupImport,
      errors: [{ messageId: "globalSweep" }],
    },
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
