import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-on-rejection.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const filename = "/project/turbo/apps/platform/src/signals/feature/action.ts";

ruleTester.run("no-on-rejection", rule, {
  valid: [
    {
      filename,
      code: 'import { settle } from "../utils.ts"; settle(operation);',
    },
    {
      filename,
      code: 'import { onRejection } from "unrelated-library"; onRejection(operation, callback);',
    },
    {
      filename,
      code: 'import { onRejection } from "../utils.ts"; function other(onRejection) { return onRejection(); }',
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
      code: 'import * as utils from "../utils.ts"; function other(utils) { return utils.onRejection(); }',
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
      code: 'export type { onRejection } from "../utils.ts";',
    },
    {
      filename,
      code: 'import type { onRejection } from "../utils.ts"; type Callback = typeof onRejection;',
    },
    {
      filename,
      code: 'import { type onRejection } from "../utils.ts"; type Callback = typeof onRejection;',
    },
    {
      filename,
      code: `import { onRejection } from "../utils.ts";
// eslint-disable-next-line @rule-tester/no-on-rejection -- 存量 2026/10/21: infrastructure telemetry.
const result = onRejection(operation, callback);`,
    },
  ],
  invalid: [
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const helpers = utils; helpers.onRejection(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils[key](operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { ...helpers } = utils;',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import { onRejection as observe } from "../utils.ts"; export { observe };',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import { onRejection } from "../utils.ts"; onRejection(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import { onRejection as observe } from "../utils"; observe(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename: "/project/turbo/apps/platform/src/lib/observer.ts",
      code: 'import { onRejection } from "../signals/utils.ts"; onRejection(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils.onRejection(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils["onRejection"](operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; utils?.onRejection(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import * as utils from "../utils.ts"; const { onRejection: observe } = utils; observe(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import { onRejection } from "../utils.ts"; const alias = onRejection; alias(operation, callback);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import { onRejection } from "../utils.ts"; consume(onRejection);',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'export { onRejection as observe } from "../utils.ts";',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'export * from "../utils.ts";',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'export * as helpers from "../utils.ts";',
      errors: [{ messageId: "noOnRejection" }],
    },
    {
      filename,
      code: 'import { onRejection } from "../utils.ts"; onRejection(first, callback); onRejection(second, callback);',
      errors: [{ messageId: "noOnRejection" }, { messageId: "noOnRejection" }],
    },
  ],
});
