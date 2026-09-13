import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-create-child-abort-controller.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-create-child-abort-controller", rule, {
  valid: [
    {
      code: `
        import { resetSignal } from "../utils.ts";

        const resetOperationSignal$ = resetSignal();
      `,
    },
    {
      code: `
        import { createOwner as createChildAbortController } from "another-package";

        createChildAbortController();
      `,
    },
    {
      code: `
        const utils = { createChildAbortController: () => undefined };

        utils.createChildAbortController();
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { createChildAbortController } from "../utils.ts";

        createChildAbortController(signal);
      `,
      errors: [{ messageId: "childAbortController" }],
    },
    {
      code: `
        import { createChildAbortController as createOwner } from "../utils.ts";

        createOwner(signal);
      `,
      errors: [{ messageId: "childAbortController" }],
    },
    {
      code: `
        import * as utils from "../utils.ts";

        utils.createChildAbortController(signal);
        utils["createChildAbortController"](signal);
      `,
      errors: [
        { messageId: "childAbortController" },
        { messageId: "childAbortController" },
      ],
    },
    {
      code: `
        function createChildAbortController() {
          return undefined;
        }

        createChildAbortController();
      `,
      errors: [{ messageId: "childAbortController" }],
    },
  ],
});
