import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/test-context-in-hooks.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("test-context-in-hooks", rule, {
  valid: [
    {
      name: "helper consumes an explicit context without registration",
      code: `export function createHelpers(context) { return { store: () => context.store }; }`,
      options: [{ allowRegistration: false }],
    },
    {
      name: "testContext called at top level without destructuring",
      code: `
        const context = testContext()
      `,
    },
    {
      name: "testContext destructured in it",
      code: `
        it('should work', () => {
          const { store, signal } = testContext()
        })
      `,
    },
    {
      name: "testContext destructured in test",
      code: `
        test('should work', () => {
          const { store, signal } = testContext()
        })
      `,
    },
    {
      name: "testContext destructured in beforeEach",
      code: `
        beforeEach(() => {
          const { store, signal } = testContext()
        })
      `,
    },
    {
      name: "testContext destructured in afterEach",
      code: `
        afterEach(() => {
          const { store } = testContext()
        })
      `,
    },
  ],
  invalid: [
    {
      name: "helper registers a hidden owner",
      code: `export const context = testContext()`,
      options: [{ allowRegistration: false }],
      errors: [{ messageId: "testContextRegistrationInHelper" }],
    },
    {
      name: "helper registers through an import alias",
      code: `import { testContext as createContext } from './test-helpers'; export const context = createContext();`,
      options: [{ allowRegistration: false }],
      errors: [{ messageId: "testContextRegistrationInHelper" }],
    },
    {
      name: "helper registers through a namespace import",
      code: `import * as fixtures from './test-helpers'; export const context = fixtures.testContext();`,
      options: [{ allowRegistration: false }],
      errors: [{ messageId: "testContextRegistrationInHelper" }],
    },
    {
      name: "helper hides registration in a factory",
      code: `export function createHelpers() { return testContext(); }`,
      options: [{ allowRegistration: false }],
      errors: [{ messageId: "testContextRegistrationInHelper" }],
    },
    {
      name: "testContext destructured at top level",
      code: `
        const { store, signal } = testContext()
      `,
      errors: [{ messageId: "testContextDestructuringOutsideHook" }],
    },
    {
      name: "testContext destructured in describe but not in hook",
      code: `
        describe('test suite', () => {
          const { store, signal } = testContext()
        })
      `,
      errors: [{ messageId: "testContextDestructuringOutsideHook" }],
    },
  ],
});
