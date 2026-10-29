import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-settle.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const filename = "/project/turbo/apps/platform/src/signals/feature/action.ts";

ruleTester.run("no-settle", rule, {
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
      code: 'import { settle } from "../utils.ts"; type Callback = typeof settle;',
    },
    {
      filename,
      code: 'import { settle as observe } from "../utils.ts"; export type { observe };',
    },
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; withCleanup(operation);',
    },
    {
      filename,
      code: 'import { settle } from "unrelated-library"; settle(operation, callback);',
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; function other(settle) { return settle(); }',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils.withCleanup(operation);',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { withCleanup } = utils;',
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; function other(utils) { return utils.settle(); }',
    },
    {
      filename,
      code: 'export { withCleanup } from "../utils.ts";',
    },
    {
      filename,
      code: 'export * from "../other-utils.ts";',
    },
    {
      filename,
      code: 'export type { settle } from "../utils.ts";',
    },
    {
      filename,
      code: 'import type { settle } from "../utils.ts"; type Callback = typeof settle;',
    },
    {
      filename,
      code: 'import { type settle } from "../utils.ts"; type Callback = typeof settle;',
    },
    {
      filename,
      code: `import { settle } from "../utils.ts";
// eslint-disable-next-line @rule-tester/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
const result = settle(operation, callback);`,
    },
  ],
  invalid: [
    {
      filename,
      code: 'import { settle } from "../utils.ts"; type Callback = typeof settle; settle(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const helpers = utils; helpers.settle(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils[key](operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { ...helpers } = utils;',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import { settle as observe } from "../utils.ts"; export { observe };',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; settle(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import { settle as observe } from "../utils"; observe(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename: "/project/turbo/apps/platform/src/lib/observer.ts",
      code: 'import { settle } from "../signals/utils.ts"; settle(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils.settle(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils["settle"](operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils?.settle(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { settle: observe } = utils; observe(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; const alias = settle; alias(operation, callback);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; consume(settle);',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'export { settle as observe } from "../utils.ts";',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'export * from "../utils.ts";',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'export * as helpers from "../utils.ts";',
      errors: [{ messageId: "noSettle" }],
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; settle(first, callback); settle(second, callback);',
      errors: [{ messageId: "noSettle" }, { messageId: "noSettle" }],
    },
  ],
});
