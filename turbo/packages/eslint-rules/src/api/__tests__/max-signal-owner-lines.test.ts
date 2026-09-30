import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { maxSignalOwnerLines } from "../rules/max-signal-owner-lines.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const options: [{ max: number; owners: string[] }] = [
  { max: 4, owners: ["createClaimRunObjects"] },
];

ruleTester.run("max-signal-owner-lines", maxSignalOwnerLines, {
  valid: [
    {
      name: "counts graph callbacks independently of the declarative owner",
      options,
      code: `
        import { computed, command, state } from "ccstate";
        export function createClaimRunObjects(claim: { threadId: string }) {
          const revision$ = state(0);
          const event$ = computed(get => {
            get(revision$);
            return claim.threadId;
          });
          const prepare$ = command(({ get }) => {
            return get(event$);
          });
          return { event$, prepare$ };
        }
      `,
    },
    {
      name: "ignores blank and comment-only lines in operational code",
      options,
      code: `
        function shortOperation() {
          // A comment does not enlarge the operational function.

          return 1;
        }
      `,
    },
    {
      name: "recognizes imported constructor aliases",
      options,
      code: `
        import { computed as read, command as write } from "ccstate";
        function createClaimRunObjects(claim: { id: string }) {
          const value$ = read(() => claim.id);
          const result$ = read(get => get(value$));
          const run$ = write(({ get }) => get(result$));
          return { value$, result$, run$ };
        }
      `,
    },
  ],
  invalid: [
    {
      name: "still bounds each operational callback",
      options,
      code: `
        import { command } from "ccstate";
        function createClaimRunObjects() {
          const run$ = command(() => {
            const one = 1;
            const two = 2;
            const three = 3;
            return one + two + three;
          });
          return { run$ };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "does not exempt a similarly named imperative function",
      options,
      code: `
        function createClaimRunObjects() {
          writeToDatabase();
          const value = 1;
          const second = 2;
          return { value, second };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "does not exempt ordinary long functions",
      options,
      code: `
        function prepare() {
          const value = 1;
          const second = 2;
          const third = 3;
          return value + second + third;
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "rejects eager work hidden in state initialization",
      options,
      code: `
        import { state } from "ccstate";
        function createClaimRunObjects() {
          const eager$ = state(readDatabase());
          const one$ = state(1);
          const two$ = state(2);
          return { eager$, one$, two$ };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "does not trust constructor names from other packages",
      options,
      code: `
        import { computed } from "other-package";
        function createClaimRunObjects() {
          const one$ = computed(() => 1);
          const two$ = computed(() => 2);
          const three$ = computed(() => 3);
          return { one$, two$, three$ };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
  ],
});
