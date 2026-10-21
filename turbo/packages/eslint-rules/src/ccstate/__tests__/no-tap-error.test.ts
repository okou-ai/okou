import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-tap-error.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-tap-error", rule, {
  valid: [
    { code: `await operation();` },
    { code: `export async function tapError(p) { return await p; }` },
    { code: `function run(tapError) { return tapError(); }` },
    {
      code: `import { tapError } from "./utils.ts"; function run(tapError) { return tapError(); }`,
    },
    { code: `import * as utils from "./utils.ts"; utils.settle(operation());` },
    {
      code: `import * as utils from "./utils.ts"; function run(utils) { return utils.tapError(); }`,
    },
    {
      code: `import type { tapError } from "./types.ts"; type Handler = tapError;`,
    },
    {
      code: `import { tapError } from "./utils.ts";
// eslint-disable-next-line @rule-tester/no-tap-error -- Legacy use as of 2026/10/21: optional architecture detection.
await tapError(operation());`,
    },
  ],
  invalid: [
    {
      code: `import { tapError } from "../utils.ts"; await tapError(operation());`,
      errors: [{ messageId: "noTapError" }],
    },
    {
      code: `import { tapError as ignoreFailure } from "../utils.ts"; await ignoreFailure(operation());`,
      errors: [{ messageId: "noTapError" }],
    },
    {
      code: `import { tapError } from "./utils.ts"; const ignoreFailure = tapError;`,
      errors: [{ messageId: "noTapError" }],
    },
    {
      code: `import * as helpers from "./utils.ts"; await helpers.tapError(operation());`,
      errors: [{ messageId: "noTapError" }],
    },
    {
      code: `import * as helpers from "./utils.ts"; const ignoreFailure = helpers["tapError"];`,
      errors: [{ messageId: "noTapError" }],
    },
    {
      code: `import * as helpers from "./utils.ts"; const { tapError: ignoreFailure } = helpers;`,
      errors: [{ messageId: "noTapError" }],
    },
    {
      code: `export { tapError as ignoreFailure } from "./utils.ts";`,
      errors: [{ messageId: "noTapError" }],
    },
  ],
});
