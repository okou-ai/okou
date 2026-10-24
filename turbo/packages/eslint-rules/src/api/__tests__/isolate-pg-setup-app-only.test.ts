import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { isolatePgSetupAppOnly } from "../rules/isolate-pg-setup-app-only.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();
const isolationError = { messageId: "setupAppOnly" } as const;

tester.run("isolate-pg-setup-app-only", isolatePgSetupAppOnly, {
  valid: [
    {
      code: `
        import { it } from "vitest";
        it("owns global state", async () => {
          const app = await setupApp({ context, routes, isolatePg: true });
          await app(contract).sync();
        });
      `,
    },
    {
      code: `
        test("inherits the database in helpers", async () => {
          await setupApp({ context, routes, isolatePg: true });
          await fixture();
        });
        function fixture() {
          return setupApp({ context, routes });
        }
      `,
    },
    {
      code: `
        it.concurrent.each([true, false])("case %s", async (value) => {
          await setupApp({ context, routes, isolatePg: true });
        });
      `,
    },
    {
      code: `
        test.for([1, 2])("case %s", async (value) => {
          await setupApp({ context, routes, isolatePg: true });
        });
      `,
    },
    {
      code: `
        test.skipIf(disabled)("case", async () => {
          await setupApp({ context, routes, isolatePg: true });
        });
      `,
    },
    {
      code: `
        it.each\`name | value
          a | 1
        \`("case $name", async () => {
          await setupApp({ context, routes, isolatePg: true });
        });
      `,
    },
    {
      code: `
        import { test as caseTest } from "vitest";
        caseTest("case", { timeout: 1000 }, async () => {
          await setupApp({ context, routes, isolatePg: true });
        });
      `,
    },
    {
      code: `
        import * as vitest from "vitest";
        vitest.test("case", async function () {
          await setupApp({ context, routes, isolatePg: true });
        });
      `,
    },
    {
      code: `
        it("owns the inline lifetime", async () => {
          await withMockNow(instant, async () => {
            await scenario.run(async () => {
              await setupApp({ context, routes, isolatePg: true });
            });
          });
        });
      `,
    },
    {
      code: `
        it("uses a static key", async () => {
          await setupApp({ "isolatePg": true });
          await setupApp({ ["isolatePg"]: true });
        });
      `,
    },
    { code: 'throw new Error("Call setupApp({ isolatePg: true }) first");' },
    {
      filename: "/api/src/__tests__/test-helpers.ts",
      code: `
        type Options = { isolatePg?: boolean };
        function setupApp({ isolatePg = false }: Options) {}
      `,
    },
    {
      filename: "C:\\api\\src\\test-fixtures\\case-database.ts",
      code: "const isolatePg = true;",
    },
  ],
  invalid: [
    {
      code: "function fixture(options: { isolatePg?: boolean }) {}",
      errors: [isolationError],
    },
    {
      code: "type Options = { readonly isolatePg?: true };",
      errors: [isolationError],
    },
    {
      code: 'type Options = { "isolatePg"?: true };',
      errors: [isolationError],
    },
    {
      code: 'type Isolation = Options["isolatePg"];',
      errors: [isolationError],
    },
    {
      code: "const isolatePg = true;",
      errors: [isolationError],
    },
    {
      code: "const { isolatePg: isolated } = options;",
      errors: [isolationError],
    },
    {
      code: 'const isolated = options["isolatePg"];',
      errors: [isolationError],
    },
    {
      code: "const isolated = options[`isolatePg`];",
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ context, routes, isolatePg: options.isolatePg });
      });`,
      errors: [isolationError, isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ context, routes, isolatePg });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ ...(enabled ? { isolatePg: true } : {}) });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ context, routes, isolatePg: false });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ context, routes, isolatePg: enabled });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ context, routes, isolatePg: true as const });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        const options = { context, routes, isolatePg: true };
        await setupApp(options);
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupApp({ nested: { isolatePg: true } });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await setupRawAppRequest({ context, routes, isolatePg: true });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        await fixture({ context, routes, isolatePg: true });
      });`,
      errors: [isolationError],
    },
    {
      code: `async function fixture() {
        return await setupApp({ context, routes, isolatePg: true });
      }`,
      errors: [isolationError],
    },
    {
      code: `const fixture = async () => {
        return await setupApp({ context, routes, isolatePg: true });
      };`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        const fixture = async () => setupApp({ isolatePg: true });
        await fixture();
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        const fixture = { run: async () => setupApp({ isolatePg: true }) };
        await fixture.run();
      });`,
      errors: [isolationError],
    },
    {
      code: `beforeEach(async () => {
        await setupApp({ context, routes, isolatePg: true });
      });`,
      errors: [isolationError],
    },
    {
      code: `import { beforeEach as prepare } from "vitest";
      prepare(async () => {
        await withMockNow(instant, async () => {
          await setupApp({ context, routes, isolatePg: true });
        });
      });`,
      errors: [isolationError],
    },
    {
      code: `describe("suite", async () => {
        await setupApp({ context, routes, isolatePg: true });
      });`,
      errors: [isolationError],
    },
    {
      code: `it("case", async () => {
        onTestFinished(async () => {
          await setupApp({ context, routes, isolatePg: true });
        });
      });`,
      errors: [isolationError],
    },
    {
      code: "await setupApp({ context, routes, isolatePg: true });",
      errors: [isolationError],
    },
    {
      code: `function test(name, body) { return body(); }
      test("helper", async () => {
        await setupApp({ context, routes, isolatePg: true });
      });`,
      errors: [isolationError],
    },
    {
      code: `class Fixture { "isolatePg" = true; }`,
      errors: [isolationError],
    },
    {
      code: `class Fixture { accessor "isolatePg" = true; }`,
      errors: [isolationError],
    },
    {
      code: "class Fixture { #isolatePg = true; }",
      errors: [isolationError],
    },
    {
      filename: "/api/src/fixture.tsx",
      code: "const fixture = <Fixture isolatePg />;",
      errors: [isolationError],
    },
    {
      code: "type Isolation = Options[`isolatePg`];",
      errors: [isolationError],
    },
    {
      filename: "/api/src/signals/routes/__tests__/test-helpers.ts",
      code: "type Options = { isolatePg?: boolean };",
      errors: [isolationError],
    },
  ],
});
