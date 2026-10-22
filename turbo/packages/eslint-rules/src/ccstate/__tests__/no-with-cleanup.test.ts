import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-with-cleanup.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const filename = "/project/turbo/apps/platform/src/signals/feature/action.ts";

ruleTester.run("no-with-cleanup", rule, {
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
      code: 'import { withCleanup } from "../utils.ts"; type Callback = typeof withCleanup;',
    },
    {
      filename,
      code: 'import { withCleanup as observe } from "../utils.ts"; export type { observe };',
    },
    {
      filename,
      code: 'import { settle } from "../utils.ts"; settle(operation);',
    },
    {
      filename,
      code: 'import { withCleanup } from "unrelated-library"; withCleanup(operation, callback);',
    },
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; function other(withCleanup) { return withCleanup(); }',
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
      code: 'import * as utils from "../utils.ts"; function other(utils) { return utils.withCleanup(); }',
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
      code: 'export type { withCleanup } from "../utils.ts";',
    },
    {
      filename,
      code: 'import type { withCleanup } from "../utils.ts"; type Callback = typeof withCleanup;',
    },
    {
      filename,
      code: 'import { type withCleanup } from "../utils.ts"; type Callback = typeof withCleanup;',
    },
    {
      filename,
      code: `import { withCleanup } from "../utils.ts";
// eslint-disable-next-line @rule-tester/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
const result = withCleanup(operation, callback);`,
    },
  ],
  invalid: [
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; type Callback = typeof withCleanup; withCleanup(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const helpers = utils; helpers.withCleanup(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils[key](operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { ...helpers } = utils;',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import { withCleanup as observe } from "../utils.ts"; export { observe };',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; withCleanup(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import { withCleanup as observe } from "../utils"; observe(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename: "/project/turbo/apps/platform/src/lib/observer.ts",
      code: 'import { withCleanup } from "../signals/utils.ts"; withCleanup(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils.withCleanup(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils["withCleanup"](operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils?.withCleanup(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { withCleanup: observe } = utils; observe(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; const alias = withCleanup; alias(operation, callback);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; consume(withCleanup);',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'export { withCleanup as observe } from "../utils.ts";',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'export * from "../utils.ts";',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'export * as helpers from "../utils.ts";',
      errors: [{ messageId: "noWithCleanup" }],
    },
    {
      filename,
      code: 'import { withCleanup } from "../utils.ts"; withCleanup(first, callback); withCleanup(second, callback);',
      errors: [{ messageId: "noWithCleanup" }, { messageId: "noWithCleanup" }],
    },
  ],
});
