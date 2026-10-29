import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-best-effort.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const filename = "/project/turbo/apps/platform/src/signals/feature/action.ts";

ruleTester.run("no-best-effort", rule, {
  valid: [
    {
      filename,
      code: 'import * as utils from "../utils.ts"; export type DeferredFactory = typeof utils.createDeferredPromise; export const isAbort = utils.isAbortError;',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; type Helpers = typeof utils;',
    },
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; type Callback = typeof bestEffort;',
    },
    {
      filename,
      code: 'import { bestEffort as observe } from "../utils.ts"; export type { observe };',
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; settle(operation);',
    },
    {
      filename,
      code: 'import { bestEffort } from "unrelated-library"; bestEffort(operation, callback);',
    },
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; function other(bestEffort) { return bestEffort(); }',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils.settle(operation);',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { settle } = utils;',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; function other(utils) { return utils.bestEffort(); }',
    },
    {
      filename,
      code: 'export { settle } from "../utils.ts";',
    },
    {
      filename,
      code: 'export * from "../other-utils.ts";',
    },
    {
      filename,
      code: 'export type { bestEffort } from "../utils.ts";',
    },
    {
      filename,
      code: 'import type { bestEffort } from "../utils.ts"; type Callback = typeof bestEffort;',
    },
    {
      filename,
      code: 'import { type bestEffort } from "../utils.ts"; type Callback = typeof bestEffort;',
    },
    {
      filename,
      code: `import { bestEffort } from "../utils.ts";
// eslint-disable-next-line @rule-tester/no-best-effort -- Legacy 20261029: existing bestEffort only; do not add new usages.
const result = bestEffort(operation, callback);`,
    },
  ],
  invalid: [
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; type Callback = typeof bestEffort; bestEffort(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const helpers = utils; helpers.bestEffort(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils[key](operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { ...helpers } = utils;',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import { bestEffort as observe } from "../utils.ts"; export { observe };',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; bestEffort(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import { bestEffort as observe } from "../utils"; observe(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename: "/project/turbo/apps/platform/src/lib/observer.ts",
      code: 'import { bestEffort } from "../signals/utils.ts"; bestEffort(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils.bestEffort(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils["bestEffort"](operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils?.bestEffort(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { bestEffort: observe } = utils; observe(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; const alias = bestEffort; alias(operation, callback);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; consume(bestEffort);',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'export { bestEffort as observe } from "../utils.ts";',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'export * from "../utils.ts";',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'export * as helpers from "../utils.ts";',
      errors: [{ messageId: "noBestEffort" }],
    },
    {
      filename,
      code: 'import { bestEffort } from "../utils.ts"; bestEffort(first, callback); bestEffort(second, callback);',
      errors: [{ messageId: "noBestEffort" }, { messageId: "noBestEffort" }],
    },
  ],
});
